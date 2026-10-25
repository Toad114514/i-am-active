/**
 * RetroAchievements 近期解锁成就 + 最近玩过的游戏。
 *
 * 关键点（均已对照官方文档确认）：
 *  - 鉴权参数是 `y=<web api key>`（不是 c= / h=），缺失或不合法一律 401。
 *  - `m` 是「回看多少分钟」，默认只有 60 分钟；不显式传基本总是空数组。
 *  - 返回的 `Date` / `LastPlayed` 是 UTC 且不带时区标识，必须自己补 Z，
 *    否则时间会偏 8 小时（会直接导致「明明在窗口内却被过滤掉」）。
 *  - 网页端有 Cloudflare 挑战，API 是唯一的自动化通道，没有「无 key 抓取」的退路。
 *  - `API_GetUserRecentAchievements` 只给成就，**不给「玩了但没解锁」的游戏**；
 *    想看见「昨天玩了 B3313 但没拿成就」得再调 `API_GetUserRecentlyPlayedGames`。
 *
 * key 获取：https://retroachievements.org/settings 的 Keys 区域生成，
 * 填到 config.yaml 的 platforms.retroachievements.webApiKey（或环境变量 RA_API_KEY）。
 *
 * 「一条都没有」时本模块不会抛错（其它平台不该被它连坐），而是把现场写进
 * diagnostics，由 collect.mjs 落到 res/state.json 的 diagnostics.retroachievements，
 * 这样直接看仓库就能判断是「没配 key」「key 失效」还是「窗口里真的没活动」。
 */
import { getJson, HttpError, sleep } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const API = 'https://retroachievements.org/API';
const SITE = 'https://retroachievements.org';
const MEDIA = 'https://media.retroachievements.org';

/** 上一轮抓取的现场信息；collect 会把它写进 res/state.json。 */
let diagnostics = null;

/** 给 collect.mjs 用的诊断出口（与 steam.mjs 同一套约定）。 */
export function lastRaDiagnostics() {
  return diagnostics;
}

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

/** key 打码，只留长度信息，便于判断「配了但配错了」。 */
function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return `长度 ${key.length}`;
  return `${key.slice(0, 4)}…${key.slice(-2)}（长度 ${key.length}）`;
}

/** 把 API 原始成就条目整理成站点用的中间结构（字段名兼容 PascalCase）。 */
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

/** 细节：RA 用户名写错时返回 404/{"message":"..."} 而不是空数组。 */
function explainNotFound(raw) {
  const message = raw?.message ?? raw?.error ?? raw?.Error;
  if (!message) return null;
  if (/not found|no such user|unknown user/i.test(String(message))) {
    return `用户名不存在（检查 retroachievements.user）`;
  }
  return String(message);
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
 *
 * 下限有两个：
 *  - 60 分钟：RA 的默认值，再小没有意义；
 *  - minWindowMinutes（默认 3 天）：上次运行失败（比如 key 没配、401）时，
 *    lastRun 仍然会往前走，窗口就会一直只有两小时，那几天解锁的成就永远补不回来。
 *    多回看几天只多花一次请求，id 稳定，去重不会产生重复条目。
 */
function lookbackMinutes(config, since) {
  const maxMinutes = Math.max(1, Number(config.lookbackDays) || 60) * 24 * 60;
  const floorMinutes = Math.max(60, Number(config.minWindowMinutes) || 3 * 24 * 60);
  const sinceMs = since instanceof Date ? since.getTime() : since ? Date.parse(since) : NaN;
  if (!Number.isFinite(sinceMs)) return maxMinutes;
  const gapMinutes = Math.ceil((Date.now() - sinceMs) / 60000) + 120;
  return Math.min(maxMinutes, Math.max(floorMinutes, gapMinutes));
}

/** 成就 → 站点条目。 */
function achievementItem(a, user) {
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
}

/**
 * 游戏美术图缓存：一轮里同一款游戏只查一次。
 *
 * `API_GetGame` 给三张图，当背景的优先级是：
 *   ImageBoxArt（商店/盒装封面，最「像这款游戏」的一张）
 *   → ImageTitle（游戏内标题画面）
 *   → ImageIngame（游玩过程的截图）
 *
 * 标题画面排在游玩截图前面：标题画面一眼能认出是哪款游戏，而游玩截图常常是
 * 关卡里某个角落。代价是 RA 的 `ImageTitle` 偶尔不是真正的标题界面，而是
 * 一张宣传大头图（B3313 那张就是马里奥大头照）——但只有封面缺失时才会轮到它。
 *
 * 改顺序要同时把 `ART_RULE` 的版本号 +1：老条目靠它对不上号来触发重查。
 */
export const ART_RULE = 'boxart>title>ingame@v2';
/**
 * RA 的共享占位图：游戏没有对应美术时，API **不会**返回空字符串，而是返回这张
 * 「No Screenshot Found」的图。不认识它的话，条目背景就是一张写着
 * 「no screenshot found」的灰图（~Hack~ Super Mario Treasure World 就是这样，
 * ImageBoxArt = Images/000002.png，直接铺在卡片上）。
 *
 * 只能按「共享占位图名单」判断，不能按编号区间一刀切：低编号里混着真实素材
 * （000004~000007 是某款 Sonic 的截图，000010 也是真实游戏画面），
 * 只有 000002 是系统占位图。
 */
const PLACEHOLDER_ART = new Set(['000002.png']);

/** 导出给 art-refresh：判断已存的老条目是不是停在占位图上。 */
export function isPlaceholderArt(url) {
  if (!url) return false;
  return PLACEHOLDER_ART.has(String(url).split('/').pop() || '');
}

const gameArtCache = new Map();
/** 取图失败的现场（只留前几条），给 state.json 里的 diagnostics 用。 */
const artDebug = [];

async function fetchGameArt(gameId, key, budget, throttleMs = 0) {
  if (!gameId) return null;
  if (gameArtCache.has(gameId)) return gameArtCache.get(gameId);
  if (gameArtCache.size >= budget) return null;

  // 取图是按「款」单独请求的：回填三个月数据时一轮能撞上几十款游戏，
  // 一口气打过去很容易被当成爬虫。给每次请求之间垫一点间隔（默认 250ms）。
  if (throttleMs > 0 && gameArtCache.size > 0) await sleep(throttleMs);

  let art = null;
  try {
    // 参数名是 `i`（不是 `g`）。用错名字时 RA 不会报错，只会返回一个空对象，
    // 看起来像「这款游戏没有图」。字段同时兼容 PascalCase / camelCase。
    const params = new URLSearchParams({ y: key, i: String(gameId) });
    const data = await getJson(`${API}/API_GetGame.php?${params}`, {
      timeoutMs: 20000,
      retries: 1,
    });
    const ingame = absolute(data?.ImageIngame ?? data?.imageIngame);
    const boxArt = absolute(data?.ImageBoxArt ?? data?.imageBoxArt);
    const title = absolute(data?.ImageTitle ?? data?.imageTitle);
    // 缺图时 RA 给的是占位图，不是空值——所以三张图都要过一遍占位判断，
    // 一张都不可用才真的算「没有图」，否则往下退到 ingame / 标题画面。
    const candidates = [
      ['boxart', boxArt],
      ['title', title],
      ['ingame', ingame],
    ].filter(([, url]) => url && !isPlaceholderArt(url));
    const picked = candidates[0] ?? null;
    art = {
      backdrop: picked ? picked[1] : null,
      ingame,
      boxArt,
      title: data?.Title ?? data?.title ?? null,
      source: picked ? picked[0] : null,
      rule: ART_RULE,
    };
    if (!picked && artDebug.length < 3) {
      artDebug.push(
        `game ${gameId}: 三张图全是占位图或为空（box=${boxArt ?? '-'} ingame=${ingame ?? '-'} title=${title ?? '-'}）`,
      );
    }
  } catch (error) {
    const reason = error instanceof HttpError ? explainError(error) : error.message;
    if (artDebug.length < 3) artDebug.push(`game ${gameId}: ${reason}`);
    // 游戏图只是锦上添花，查不到就不放背景，绝不影响条目本身
    console.warn(`[retroachievements] game ${gameId} 取游戏图失败：${reason}`);
  }
  gameArtCache.set(gameId, art);
  return art;
}

/**
 * 最近玩过的游戏 → 「游玩记录」条目。
 *
 * 成就接口只回「解锁了什么」，一场没拿成就的游戏（或者存档状态/模拟器没开
 * 成就检测）在列表里完全看不见。这里按 LastPlayed 补一条，和 Steam 那边一致。
 */
function playSessionItem(game, user) {
  const title = game.Title ?? `Game ${game.GameID ?? ''}`;
  const total = game.NumPossibleAchievements ?? null;
  const done = game.NumAchieved ?? null;
  const scoreText =
    Number.isFinite(Number(done)) && Number.isFinite(Number(total)) && Number(total) > 0
      ? `，成就 ${Number(done)}/${Number(total)}`
      : '';
  const consoleText = game.ConsoleName ? `在 ${game.ConsoleName} 上` : '';
  return {
    // LastPlayed 参与 id：同一款游戏换个时间再玩会是一条新记录
    id: `retroachievements:play:${game.GameID}:${game.LastPlayed ?? ''}`,
    platform: 'retroachievements',
    type: '游玩记录',
    title: `玩了《${title}》`,
    summary: `${consoleText}玩了《${title}》${scoreText}`,
    url: game.GameID ? `${SITE}/game/${game.GameID}` : `${SITE}/user/${user}`,
    image: absolute(game.ImageIcon),
    timestamp: toIso(game.LastPlayed),
    meta: {
      kind: 'play-session',
      gameId: game.GameID ?? null,
      gameTitle: title,
      consoleName: game.ConsoleName ?? null,
      achievementsUnlocked: done,
      achievementsTotal: total,
      user,
    },
  };
}

/**
 * @param {{since?: string|Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchRetroAchievements(context = {}) {
  const config = platform('retroachievements');
  const user = config.user;
  const sinceMs =
    context.since instanceof Date
      ? context.since.getTime()
      : context.since
        ? Date.parse(context.since)
        : NaN;

  const diag = {
    checkedAt: new Date().toISOString(),
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    windowMinutes: null,
    keyConfigured: false,
    keyHint: null,
    note: '',
    profile: null,
    recentAchievements: null,
    recentlyPlayed: null,
    items: { achievements: 0, plays: 0 },
  };
  diagnostics = diag;
  artDebug.length = 0;

  if (config.enabled === false) {
    diag.note = 'config.yaml 里 retroachievements.enabled = false';
    return [];
  }

  const key = String(config.webApiKey ?? '').trim();
  if (!key) {
    diag.note =
      '未配置 Web API Key：GitHub Actions 里加 Secret RA_API_KEY 后重新运行。' +
      '（https://retroachievements.org/settings → Keys）';
    console.warn(
      '[retroachievements] 未配置 Web API Key，跳过。' +
        '到 https://retroachievements.org/settings 生成后填入 config.yaml 的 ' +
        'platforms.retroachievements.webApiKey（或环境变量 RA_API_KEY）',
    );
    return [];
  }

  diag.keyConfigured = true;
  diag.keyHint = maskKey(key);

  if (config.profileCheck !== false) {
    try {
      const profile = await probeProfile(user, key);
      if (!profile) {
        diag.profile = { ok: false, error: `用户 "${user}" 不存在（或 key 无权访问）` };
        diag.note = `用户名不对或 key 不属于这个账号：${user}`;
        console.warn(`[retroachievements] 用户 "${user}" 不存在（或 key 无权访问），跳过`);
        return [];
      }
      const points = profile.points === null ? '未知' : profile.points;
      diag.profile = { ok: true, user: profile.user, points, truePoints: profile.truePoints };
      console.log(
        `[retroachievements] 校验通过：${profile.user} · 总积分 ${points}` +
          (profile.truePoints !== null ? ` · 白分 ${profile.truePoints}` : ''),
      );
    } catch (error) {
      const reason = explainError(error);
      diag.profile = { ok: false, error: reason };
      diag.note = `校验失败：${reason}`;
      console.warn(`[retroachievements] 校验失败，跳过：${reason}`);
      return [];
    }
  }

  const minutes = lookbackMinutes(config, context.since);
  diag.windowMinutes = minutes;
  const maxItems = Math.max(1, Number(config.maxItems) || 60);
  const items = [];

  // ---------- 1) 近期解锁的成就 ----------
  const params = new URLSearchParams({ y: key, u: user, m: String(minutes) });
  let raw = null;
  let achievementsError = null;
  try {
    raw = await getJson(`${API}/API_GetUserRecentAchievements.php?${params}`, {
      timeoutMs: 20000,
      retries: 2,
    });
  } catch (error) {
    achievementsError =
      error instanceof HttpError ? explainError(error) : error.message;
    console.warn(`[retroachievements] 成就请求失败：${achievementsError}`);
  }

  let achievements = [];
  if (raw !== null) {
    // 出错时 RA 会返回 {"Error": "..."} / {"message": "..."} 而不是数组
    if (!Array.isArray(raw)) {
      const detail = explainNotFound(raw) ?? JSON.stringify(raw).slice(0, 200);
      achievementsError = `返回内容不是数组：${detail}`;
      console.warn(`[retroachievements] 返回内容异常：${detail}`);
    } else {
      const seen = new Set();
      achievements = raw
        .map(mapAchievement)
        .filter((a) => {
          // RA 的活动系统会把成就「镜像」到 Events 平台的活动游戏里：在
          // hack/活动关联游戏里解锁时，同一个成就（同徽章、同时间戳）会再
          // 发一条到 RAD 2025 之类的活动页，成就 ID 不同但内容重复，玩家
          // 根本没单独「玩过」那个活动游戏。这类镜像条目直接跳过。
          if (a.consoleName === 'Events') return false;
          // 同一条成就在窗口里可能出现多次（软核 + 硬核），按「成就 + 解锁时间」去重
          const key = `${a.achievementId}:${a.unlockedAtRaw}`;
          if (!a.achievementId || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => Date.parse(b.unlockedAt ?? 0) - Date.parse(a.unlockedAt ?? 0))
        .slice(0, maxItems);
    }
  }
  diag.recentAchievements = {
    ok: !achievementsError,
    rawCount: Array.isArray(raw) ? raw.length : 0,
    used: achievements.length,
    error: achievementsError,
  };
  items.push(...achievements.map((a) => achievementItem(a, user)));

  // ---------- 2) 最近玩过的游戏（没解锁成就也能看见） ----------
  if (config.playSessions !== false) {
    const count = Math.max(1, Math.min(50, Number(config.maxGames) || 10));
    const playParams = new URLSearchParams({ y: key, u: user, c: String(count) });
    let playRaw = null;
    let playError = null;
    try {
      playRaw = await getJson(`${API}/API_GetUserRecentlyPlayedGames.php?${playParams}`, {
        timeoutMs: 20000,
        retries: 2,
      });
    } catch (error) {
      playError = error instanceof HttpError ? explainError(error) : error.message;
      console.warn(`[retroachievements] 游玩记录请求失败：${playError}`);
    }

    let plays = [];
    if (Array.isArray(playRaw)) {
      // 与成就同一个窗口（而不是只按 since）：上次运行失败、或某天没跑成功时，
      // 昨天玩过的游戏还能补进来。id 里带 LastPlayed，重复抓到也只是同一条被跳过。
      const windowStartMs = Date.now() - minutes * 60000;
      plays = playRaw
        .filter((game) => {
          // 同上：Events 活动游戏的「游玩记录」也是镜像出来的，跳过
          if ((game.ConsoleName ?? game.consoleName) === 'Events') return false;
          const playedAt = Date.parse(toIso(game.LastPlayed) ?? '');
          return Number.isFinite(playedAt) && playedAt >= windowStartMs;
        })
        .slice(0, maxItems);
    } else if (playRaw !== null) {
      playError = explainNotFound(playRaw) ?? JSON.stringify(playRaw).slice(0, 200);
    }

    diag.recentlyPlayed = {
      ok: !playError,
      rawCount: Array.isArray(playRaw) ? playRaw.length : 0,
      used: plays.length,
      error: playError,
    };
    items.push(...plays.map((game) => playSessionItem(game, user)));
  } else {
    diag.recentlyPlayed = { ok: null, skipped: 'playSessions = false' };
  }

  // ---------- 3) 游戏封面/截图：当条目背景，成就图标缩成右下角角标 ----------
  let artCount = 0;
  const artSources = { title: 0, ingame: 0, boxart: 0 };
  if (config.gameArt !== false && items.length > 0) {
    const budget = Math.max(1, Math.min(50, Number(config.maxGameArt) || 20));
    // 取图请求之间的最小间隔（默认 250ms）。一轮几十款游戏时不垫间隔容易被限速。
    const throttleMs = Math.max(0, Number(config.artThrottleMs ?? 250));
    const gameIds = [...new Set(items.map((item) => item.meta?.gameId).filter(Boolean))];
    const art = new Map();
    for (const gameId of gameIds) {
      art.set(gameId, await fetchGameArt(gameId, key, budget, throttleMs));
    }
    for (const item of items) {
      const found = art.get(item.meta?.gameId);
      if (!found?.backdrop) continue;
      item.meta.backdrop = found.backdrop;
      item.meta.backdropSource = found.source ?? null;
      // 记下当前取图规则：改顺序时老条目靠它对不上号来触发重查
      item.meta.artRule = found.rule ?? null;
      if (found.source && artSources[found.source] !== undefined) artSources[found.source] += 1;
      // 只有成就才有东西可角标；游玩记录就单纯一张游戏图。
      // 角标只能是成就徽章本身，别拿游戏截图顶（截图缩到 42px 什么都看不出来）。
      if (item.meta.achievementId) {
        item.meta.badge = item.meta.badgeUrl ?? item.image ?? null;
      }
      artCount += 1;
    }
  }
  diag.gameArt = {
    games: new Set(items.map((i) => i.meta?.gameId).filter(Boolean)).size,
    withArt: artCount,
    sources: artSources,
    debug: artDebug.slice(),
  };
  if (artDebug.length) console.warn(`[retroachievements] 取图现场：${artDebug[0]}`);

  diag.items = {
    achievements: achievements.length,
    plays: items.length - achievements.length,
  };
  if (items.length === 0) {
    diag.note =
      diag.note ||
      `窗口 ${minutes} 分钟内没有成就，也没有新玩的游戏（接口正常返回，只是没东西）`;
  }

  console.log(
    `[retroachievements] 回看 ${minutes} 分钟，成就 ${achievements.length} 条` +
      `，游玩记录 ${diag.items.plays} 条`,
  );

  return items;
}

export { mapAchievement, toIso, lookbackMinutes, explainError, maskKey };

/**
 * 给「美术图回填」脚本用的出口：按 gameId 单独取一次游戏图。
 *
 * 和抓取时走的是同一个 fetchGameArt（同一套 boxart → ingame → title 优先级、
 * 同一个进程内缓存），只是不依赖「这一轮抓到哪些成就」——老条目不会因为
 * 掉出回看窗口就永远停留在旧规则下的那张图上。
 *
 * 没配 key / 取图失败都返回 null，调用方保持原样即可。
 */
export async function gameArtFor(gameId) {
  const key = String(platform('retroachievements').webApiKey ?? '').trim();
  if (!key || !gameId) return null;
  // 回填脚本一轮要查几十款游戏，同样垫间隔
  return fetchGameArt(gameId, key, 50, 250);
}
