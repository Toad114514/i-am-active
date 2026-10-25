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
 * 写入窗口：只把 `unlockedtime` 落在 [上次抓取时间, 现在] 的成就写进列表，
 * 首轮退回最近 14 天。否则第一次跑就会把「最近两周玩过的游戏」的历史成就一次性灌进来。
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

/**
 * 最近两周玩过的游戏（按两周游玩时长从长到短）。
 * @returns {Promise<Array<{appid: string, name: string|null, minutes2weeks: number}>>}
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
      console.warn('[steam] 最近两周确实没有游玩记录（total_count=0）');
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

  // 自动发现的游戏在前，额外关注的 AppID 兜底（去重）
  const targets = new Map();
  for (const game of games) targets.set(game.appid, game.name);
  for (const appid of config.extraAppIds) {
    if (!targets.has(appid)) targets.set(appid, null);
  }

  if (targets.size === 0) {
    console.log('[steam] 本轮没有需要检查的游戏');
    return [];
  }

  const collected = [];
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
  console.log(
    `[steam] 检查 ${targets.size} 款游戏（回看 ${days} 天），窗口内成就 ${Math.min(collected.length, config.maxItems)} 条`,
  );
  return collected.slice(0, config.maxItems);
}

/**
 * 最近两周玩过的游戏 → 可读列表（导出给测试用，逻辑与运行时一致）。
 */
export { recentlyPlayedGames, windowStart, fetchAchievementsForApp };
