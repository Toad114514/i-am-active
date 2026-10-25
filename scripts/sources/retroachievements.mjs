/**
 * RetroAchievements 近期解锁成就。
 *
 * 关键点（均已对照官方文档确认）：
 *  - 鉴权参数是 `y=<web api key>`（不是 c= / h=），缺失或不合法一律 401。
 *  - `m` 是「回看多少分钟」，默认只有 60 分钟；不显式传基本总是空数组。
 *  - 返回的 `Date` 是 UTC 且不带时区标识，必须自己补 Z，否则时间会偏 8 小时。
 *  - 网页端有 Cloudflare 挑战，API 是唯一的自动化通道，没有「无 key 抓取」的退路。
 *
 * key 获取：https://retroachievements.org/settings 的 Keys 区域生成，
 * 填到 config.yaml 的 platforms.retroachievements.webApiKey（或环境变量 RA_API_KEY）。
 *
 * 去重交给 collect.mjs：新成就会同时写入 res/ralist.json，下次比对 id 跳过的跳过。
 */
import { getJson, HttpError } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const API = 'https://retroachievements.org/API';
const SITE = 'https://retroachievements.org';
const MEDIA = 'https://media.retroachievements.org';

/** 绝对化 /Badge/xxx.png、/Images/xxx.png 这类相对资源路径。 */
function absolute(pathname) {
  if (!pathname) return null;
  if (/^https?:\/\//.test(pathname)) return pathname;
  return `${MEDIA}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}

/** RA 的 "2023-12-27 16:04:50"（UTC）→ ISO8601。 */
function toIso(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return `${m[1]}T${m[2]}Z`;
}

/** 把 API 原始条目整理成站点用的中间结构（字段名兼容 PascalCase）。 */
function mapAchievement(raw) {
  const badge = raw.BadgeURL ?? (raw.BadgeName ? `/Badge/${raw.BadgeName}.png` : null);
  const gameIcon = raw.GameIcon ?? null;
  const achievementId = raw.AchievementID ?? null;
  const unlockedAtRaw = raw.Date ?? null;

  return {
    achievementId,
    title: raw.Title ?? null,
    description: raw.Description ?? null,
    points: raw.Points ?? null,
    trueRatio: raw.TrueRatio ?? null,
    hardcore: raw.HardcoreMode === 1 || raw.HardcoreMode === true,
    gameId: raw.GameID ?? null,
    gameTitle: raw.GameTitle ?? null,
    consoleName: raw.ConsoleName ?? null,
    badgeUrl: absolute(badge),
    gameIconUrl: absolute(gameIcon),
    achievementUrl: achievementId ? `${SITE}/achievement/${achievementId}` : null,
    gameUrl: raw.GameID ? `${SITE}/game/${raw.GameID}` : null,
    unlockedAtRaw,
    unlockedAt: toIso(unlockedAtRaw),
  };
}

/** 从 HttpError 里读出 RA 的错误体，给出可操作的提示。 */
function explainError(error) {
  const body = String(error.body ?? '');
  if (error.status === 401 || /Unauthenticated/i.test(body)) {
    return 'Web API Key 无效或已失效（到 https://retroachievements.org/settings 重新生成，填到 config.yaml 的 retroachievements.webApiKey）';
  }
  if (error.status === 403) {
    return 'API 拒绝访问（key 权限不足或账号被封禁）';
  }
  if (error.status === 429) {
    return '请求过于频繁，稍后重试';
  }
  return error.message;
}

/** 用 profile 接口校验用户名 + key，顺带拿到总积分。失败返回 null。 */
async function probeProfile(user, key) {
  const params = new URLSearchParams({ y: key, u: user });
  const data = await getJson(`${API}/API_GetUserProfile.php?${params}`, {
    timeoutMs: 20000,
    retries: 1,
  });
  const profile = data?.User ? data : null;
  return profile
    ? {
        user: profile.User,
        points: profile.TotalPoints ?? null,
        truePoints: profile.TotalTruePoints ?? null,
        memberSince: toIso(profile.MemberSince),
        motto: profile.Motto ?? null,
        userPic: absolute(profile.UserPic),
        lastGameId: profile.LastGameID ?? null,
      }
    : null;
}

/**
 * 计算回看窗口（分钟）：首轮按 lookbackDays，之后按上次运行时间收窄。
 * 下限 60（RA 默认值），上限 lookbackDays。
 */
function lookbackMinutes(config, since) {
  const maxMinutes = Math.max(1, Number(config.lookbackDays) || 60) * 24 * 60;
  const sinceMs = since instanceof Date ? since.getTime() : since ? Date.parse(since) : NaN;
  if (!Number.isFinite(sinceMs)) return maxMinutes;
  const gapMinutes = Math.ceil((Date.now() - sinceMs) / 60000) + 120;
  return Math.min(maxMinutes, Math.max(60, gapMinutes));
}

/**
 * @param {{since?: string|Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchRetroAchievements(context = {}) {
  const config = platform('retroachievements');
  const user = config.user;

  if (config.enabled === false) return [];

  const key = String(config.webApiKey ?? '').trim();
  if (!key) {
    console.warn(
      '[retroachievements] 未配置 Web API Key，跳过。' +
        '到 https://retroachievements.org/settings 生成后填入 config.yaml 的 ' +
        'platforms.retroachievements.webApiKey（或环境变量 RA_API_KEY）',
    );
    return [];
  }

  if (config.profileCheck !== false) {
    try {
      const profile = await probeProfile(user, key);
      if (!profile) {
        console.warn(`[retroachievements] 用户 "${user}" 不存在（或 key 无权访问），跳过`);
        return [];
      }
      const points = profile.points === null ? '未知' : profile.points;
      console.log(
        `[retroachievements] 校验通过：${profile.user} · 总积分 ${points}` +
          (profile.truePoints !== null ? ` · 白分 ${profile.truePoints}` : ''),
      );
    } catch (error) {
      console.warn(`[retroachievements] 校验失败，跳过：${explainError(error)}`);
      return [];
    }
  }

  const minutes = lookbackMinutes(config, context.since);
  const params = new URLSearchParams({ y: key, u: user, m: String(minutes) });

  let raw;
  try {
    raw = await getJson(`${API}/API_GetUserRecentAchievements.php?${params}`, {
      timeoutMs: 20000,
      retries: 2,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      console.warn(`[retroachievements] 请求失败：${explainError(error)}`);
    } else {
      console.warn(`[retroachievements] 请求失败：${error.message}`);
    }
    return [];
  }

  // 出错时 RA 会返回 {"Error": "..."} 而不是数组
  if (!Array.isArray(raw)) {
    const message = raw?.Error ?? raw?.error ?? JSON.stringify(raw).slice(0, 200);
    console.warn(`[retroachievements] 返回内容异常：${message}`);
    return [];
  }

  const maxItems = Math.max(1, Number(config.maxItems) || 60);
  const seen = new Set();

  const items = raw
    .map(mapAchievement)
    .filter((a) => {
      // 同一条成就在窗口里可能出现多次（软核 + 硬核），按「成就 + 解锁时间」去重
      const key = `${a.achievementId}:${a.unlockedAtRaw}`;
      if (!a.achievementId || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b.unlockedAt ?? 0) - Date.parse(a.unlockedAt ?? 0))
    .slice(0, maxItems);

  console.log(
    `[retroachievements] 回看 ${minutes} 分钟，拿到 ${raw.length} 条原始记录，` +
      `有效 ${items.length} 条`,
  );

  return items.map((a) => {
    const hardcoreText = a.hardcore ? '硬核成就' : '成就';
    const pointsText = a.points ? `，${a.points} 分` : '';
    const gameText = a.gameTitle ? `在《${a.gameTitle}》解锁${hardcoreText}` : `解锁${hardcoreText}`;
    return {
      // id 与旧版本保持同一格式，避免历史 ralist.json 里的记录被当成新成就
      id: `retroachievements:${a.achievementId}:${a.unlockedAtRaw ?? ''}`,
      platform: 'retroachievements',
      type: hardcoreText,
      title: a.title ?? '未命名成就',
      summary: a.description
        ? `${gameText}「${a.title ?? ''}」${pointsText}：${a.description}`
        : `${gameText}「${a.title ?? ''}」${pointsText}`,
      url: a.achievementUrl ?? a.gameUrl ?? `${SITE}/user/${user}`,
      image: a.badgeUrl ?? a.gameIconUrl ?? null,
      timestamp: a.unlockedAt,
      meta: {
        achievementId: a.achievementId,
        gameId: a.gameId,
        gameTitle: a.gameTitle,
        consoleName: a.consoleName,
        points: a.points,
        trueRatio: a.trueRatio,
        hardcore: a.hardcore,
        badgeUrl: a.badgeUrl,
        gameIconUrl: a.gameIconUrl,
        gameUrl: a.gameUrl,
        user,
      },
    };
  });
}

export { mapAchievement, toIso, lookbackMinutes };
