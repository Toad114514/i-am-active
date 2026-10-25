/**
 * Steam 成就获取记录（可选）。
 *
 * 关键点（实测）：
 *  - 正确的接口名是 `ISteamUserStats/GetPlayerAchievements/v1/`（不是 ISteamUser），
 *    「最近玩过的游戏」属于 `IPlayerService/GetRecentlyPlayedGames/v1/`。
 *  - 必须提供 apiKey 与 steamId64，否则 400/403。
 *  - GetRecentlyPlayedGames 固定只看最近两周，且**按两周游玩时长排序**，不是按时间倒序；
 *    它还能顺带给出这段时间玩过的 AppID，所以不需要手工维护 appIds。
 *  - 个人资料「游戏详情」不是公开时，GetRecentlyPlayedGames 返回 `{"response":{}}`，
 *    看起来像「没数据」——这里单独打一条提示，免得误判成代码坏了。
 *  - 未配置密钥时安静跳过（config.yaml 里默认 enabled: false）。
 *
 * 写入窗口：只把落在 [上次抓取时间, 现在] 的事件写进列表，首轮退回最近 14 天，
 * 否则第一次跑就会把攒了几年的历史一次灌进来。
 *
 * 两类事件：
 *  1. 游玩记录 —— 来源是 GetRecentlyPlayedGames 里的 `rtime_last_played`（本次会话开始时间）。
 *     只启动游戏、还没解锁成就是常态（比如坐在主菜单里），只靠成就会一条都抓不到。
 *     AppID + 时间戳做 id，同一次会话重复运行不会重复写入。
 *  2. 成就解锁 —— `unlockedtime` 落在窗口内的。
 */
import { getJson, HttpError } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const STEAM_API = 'https://api.steampowered.com';
const RECENT_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** AppID 只接受纯数字，避免把占位值当游戏去查。 */
function toAppId(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : null;
}

/** 从配置解析密钥、SteamID64、窗口与上限。 */
function steamConfig() {
  const config = platform('steam');
  const positiveInt = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
  };
  const extras = (Array.isArray(config.extraAppIds) ? config.extraAppIds : [config.extraAppIds])
    .map(toAppId)
    .filter(Boolean);
  return {
    apiKey: String(config.apiKey ?? '').trim(),
    steamId64: String(config.steamId64 ?? '').trim(),
    recentGames: config.recentGames !== false,
    playSessions: config.playSessions !== false,
    maxGames: positiveInt(config.maxGames, 10),
    maxItems: positiveInt(config.maxItems, 60),
    extraAppIds: extras,
  };
}

/** 抓取窗口起点：优先用上次抓取时间，首轮回退到 14 天前。 */
function windowStart(context = {}) {
  const sinceMs = context.since ? new Date(context.since).getTime() : Number.NaN;
  if (Number.isFinite(sinceMs)) return sinceMs;
  return Date.now() - RECENT_WINDOW_DAYS * DAY_MS;
}

/** 分钟数转成人话：45 分钟 / 2 小时 / 3 小时 20 分钟。 */
function formatPlaytime(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** 游戏头图，拿不到时前端 img 的 onerror 会自己把容器删掉，不会留破图。 */
function headerImage(appid) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
}

/**
 * 「这次真的启动过游戏」的记录。
 * 只认 `rtime_last_played`，因为它是一次会话的稳定时间戳：
 * 用 playtime_2weeks 的增量当信号的话，一直挂着的游戏每轮都会涨，
 * 结果每 2 小时往站点里塞一条「在玩 XXX」。
 */
function playItems(games, sinceMs) {
  const sinceSec = Math.floor(sinceMs / 1000);
  const items = [];
  for (const game of games) {
    if (!game.lastPlayedSec) continue;
    if (game.lastPlayedSec < sinceSec) continue;
    const name = game.name ?? `App ${game.appid}`;
    const parts = [`本次会话开始于 ${formatTime(game.lastPlayedSec)}`];
    if (game.minutes2weeks > 0) parts.push(`两周内共 ${formatPlaytime(game.minutes2weeks)}`);
    if (game.minutesTotal > 0) parts.push(`累计 ${formatPlaytime(game.minutesTotal)}`);
    items.push({
      id: `steam:play:${game.appid}:${game.lastPlayedSec}`,
      platform: 'steam',
      type: '游玩记录',
      title: `《${name}》`,
      summary: parts.join('，'),
      url: `https://steamcommunity.com/app/${game.appid}`,
      image: headerImage(game.appid),
      timestamp: new Date(game.lastPlayedSec * 1000).toISOString(),
      meta: {
        appid: game.appid,
        gameName: name,
        minutes2weeks: game.minutes2weeks,
        minutesTotal: game.minutesTotal,
      },
    });
  }
  return items;
}

/** 时间戳转成本地可读，日志里用，方便对着看。 */
function formatTime(seconds) {
  return new Date(seconds * 1000).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
}

/**
 * 最近两周玩过的游戏（按两周游玩时长从长到短）。
 * @returns {Promise<Array<{appid: string, name: string|null, minutes2weeks: number,
 *   minutesTotal: number, lastPlayedSec: number}>>}
 */
async function recentlyPlayedGames({ apiKey, steamId64, maxGames }) {
  const params = new URLSearchParams({ key: apiKey, steamid: steamId64, format: 'json' });
  let data;
  try {
    data = await getJson(`${STEAM_API}/IPlayerService/GetRecentlyPlayedGames/v1/?${params}`, {
      timeoutMs: 20000,
      retries: 1,
    });
  } catch (error) {
    const reason = error instanceof HttpError ? `HTTP ${error.status ?? '?'}` : error.message;
    console.warn(`[steam] 查询最近玩过的游戏失败：${reason}`);
    return [];
  }

  const response = data?.response ?? {};
  const games = Array.isArray(response.games) ? response.games : [];
  if (games.length === 0) {
    // 两种空要分开说，否则排查时会误判：
    //   {"response":{"total_count":0}} → 接口正常工作，只是这两周没玩
    //   {"response":{}}                → 拿不到任何东西，多半是隐私没开或 ID 不对
    if (response.total_count === 0) {
      console.warn(
        '[steam] 最近两周没有游玩记录（total_count=0）。' +
          '如果游戏正开着，Steam 往往要等你退出后才把这次会话同步到接口，' +
          '等下次运行再看；也可能是两周内确实没启动过。',
      );
    } else {
      console.warn(
        '[steam] Steam 返回空响应 {"response":{}}：' +
          '可能是「个人资料 → 隐私设置 → 游戏详情」不是公开，' +
          '也可能 steamId64 不是这个账号的（17 位数字，不是 toad1145 这种自定义名）',
      );
    }
    return [];
  }

  return games
    .map((game) => ({
      appid: toAppId(game.appid),
      name: game.name ?? null,
      minutes2weeks: Number(game.playtime_2weeks) || 0,
      minutesTotal: Number(game.playtime_forever) || 0,
      lastPlayedSec: Number(game.rtime_last_played) || 0,
    }))
    .filter((game) => game.appid)
    .slice(0, maxGames);
}

/**
 * 单款游戏的成就解锁记录，只保留窗口内的。
 * @returns {Promise<Array<object>>}
 */
async function fetchAchievementsForApp(appid, { apiKey, steamId64, sinceMs, gameName }) {
  const params = new URLSearchParams({
    steamid: steamId64,
    appid: String(appid),
    key: apiKey,
    l: 'schinese',
  });

  let data;
  try {
    data = await getJson(`${STEAM_API}/ISteamUserStats/GetPlayerAchievements/v1/?${params}`, {
      timeoutMs: 20000,
      retries: 1,
    });
  } catch (error) {
    const reason = error instanceof HttpError ? `HTTP ${error.status ?? '?'}` : error.message;
    console.warn(`[steam] appid=${appid} 获取成就失败：${reason}`);
    return [];
  }

  const stats = data?.playerstats ?? {};
  // 该游戏没有成就体系时这里会是 { success: false, error: 'Requested app has no stats' }
  if (stats.success === false || !Array.isArray(stats.achievements)) return [];

  const name = stats.gameName ?? gameName ?? `App ${appid}`;
  const items = [];
  for (const achievement of stats.achievements) {
    if (!achievement.unlocked || !achievement.unlockedtime) continue;
    const unlockedMs = Number(achievement.unlockedtime) * 1000;
    if (!Number.isFinite(unlockedMs) || unlockedMs < sinceMs) continue;

    const title = achievement.name || achievement.apiname || '未命名成就';
    items.push({
      id: `steam:${appid}:${achievement.achievementid}`,
      platform: 'steam',
      type: '成就解锁',
      title,
      summary: achievement.description
        ? `在《${name}》解锁成就「${title}」：${achievement.description}`
        : `在《${name}》解锁成就「${title}」`,
      url: `https://steamcommunity.com/profiles/${steamId64}/stats/${appid}/achievements`,
      image: achievement.icon ?? achievement.icongray ?? null,
      timestamp: new Date(unlockedMs).toISOString(),
      meta: { appid, gameName: name, achievementId: achievement.achievementid },
    });
  }
  return items;
}

/**
 * @param {{since?: Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchSteam(context = {}) {
  const config = steamConfig();
  if (!config.apiKey || !config.steamId64) {
    console.warn('[steam] 缺少 steam.apiKey 或 steam.steamId64，跳过');
    return [];
  }

  // SteamID64 是 17 位纯数字；填成 toad1145 这种自定义名或填错位数时，
  // API 只会返回空，不会报错，所以这里先把它显式点出来。
  if (!/^\d{17}$/.test(config.steamId64)) {
    const tail = config.steamId64.length > 6 ? `${config.steamId64.slice(0, 5)}…（${config.steamId64.length} 位）` : '（位数明显不对）';
    console.warn(
      `[steam] steamId64 应该是 17 位纯数字，当前是 ${tail}；` +
        '用 https://steamid.io 把个人资料链接换算一下',
    );
  }

  const sinceMs = windowStart(context);
  const games = config.recentGames
    ? await recentlyPlayedGames(config)
    : [];

  // 每款游戏都打一行现场数据。Steam 的「什么都没抓到」不报错、只回空，
  // 没有这行就只能靠猜：是没启动过、隐私没开，还是成就确实没解锁。
  for (const game of games) {
    console.log(
      `[steam] ${game.name ?? `App ${game.appid}`}（${game.appid}）：` +
        `两周 ${formatPlaytime(game.minutes2weeks)} / 总计 ${formatPlaytime(game.minutesTotal)} / ` +
        `上次游玩 ${game.lastPlayedSec ? formatTime(game.lastPlayedSec) : '接口未返回'}`,
    );
  }

  const collected = config.playSessions ? playItems(games, sinceMs) : [];
  const plays = collected.length;

  // 自动发现的游戏在前，额外关注的 AppID 兜底（去重）
  const targets = new Map();
  for (const game of games) targets.set(game.appid, game.name);
  for (const appid of config.extraAppIds) {
    if (!targets.has(appid)) targets.set(appid, null);
  }

  if (targets.size === 0) {
    console.log('[steam] 本轮没有需要检查的游戏');
    return collected.slice(0, config.maxItems);
  }

  for (const [appid, name] of targets) {
    const items = await fetchAchievementsForApp(appid, {
      apiKey: config.apiKey,
      steamId64: config.steamId64,
      sinceMs,
      gameName: name,
    });
    if (items.length) {
      console.log(`[steam] ${name ?? `App ${appid}`}：窗口内解锁 ${items.length} 个成就`);
    }
    collected.push(...items);
    if (collected.length >= config.maxItems) break;
  }

  const days = Math.max(1, Math.round((Date.now() - sinceMs) / DAY_MS));
  const achievements = Math.min(collected.length, config.maxItems) - plays;
  console.log(
    `[steam] 检查 ${targets.size} 款游戏（回看 ${days} 天），` +
      `新增 ${plays} 条游玩记录 + ${Math.max(0, achievements)} 条成就`,
  );
  if (collected.length === 0 && games.length > 0) {
    console.warn(
      '[steam] 游戏在最近列表里，但窗口内既没有新会话也没有新成就。' +
        '如果这会儿正玩着，Steam 通常要等你退出后才会更新「上次游玩」时间。',
    );
  }
  return collected.slice(0, config.maxItems);
}

/**
 * 最近两周玩过的游戏 → 可读列表（导出给测试用，逻辑与运行时一致）。
 */
export { recentlyPlayedGames, windowStart, fetchAchievementsForApp, playItems, formatPlaytime };
