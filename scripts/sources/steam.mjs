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
 *  1. 游玩记录 —— 时间取自 `rtime_last_played`。注意 GetRecentlyPlayedGames **不返回**
 *     这个字段（只有 appid/名称/两周与总时长），要再调一次 GetOwnedGames 才拿得到。
 *     只启动游戏、还没解锁成就是常态（比如坐在主菜单里），只靠成就会一条都抓不到。
 *     AppID + 时间戳做 id，同一次会话重复运行不会重复写入。
 *  2. 成就解锁 —— `unlockedtime` 落在窗口内的。
 */
import { getJson, HttpError } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const STEAM_API = 'https://api.steampowered.com';
const RECENT_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 上一轮抓取的现场信息。collect 会把它写进 res/state.json 的 diagnostics.steam，
 * 这样「Steam 为什么一条都没有」不用翻 CI 日志也能查——日志会过期，也可能没有权限看。
 * 只放公开信息（AppID、时长、时间），不含密钥。
 */
let diagnostics = null;

/** @returns {object|null} */
export function lastSteamDiagnostics() {
  return diagnostics;
}

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
    // 回看窗口（天）：只在「没有上次抓取时间」时生效（首轮/删掉 lastRun 后的全量回填）。
    // 0 = 不限，成就全部历史都会入库（与 github.lookbackDays: 0 同一套约定）。
    lookbackDays: Math.max(0, Math.floor(Number(config.lookbackDays) || 0)),
    extraAppIds: extras,
  };
}

/** 抓取窗口起点：优先用上次抓取时间；没有时退回 lookbackDays（0 = 全历史）。 */
function windowStart(context = {}, lookbackDays = RECENT_WINDOW_DAYS) {
  const sinceMs = context.since ? new Date(context.since).getTime() : Number.NaN;
  if (Number.isFinite(sinceMs)) return sinceMs;
  if (lookbackDays === 0) return 0;
  return Date.now() - lookbackDays * DAY_MS;
}

/**
 * 把 Steam 的错误体翻译成人话。最常遇到的是 403 + Profile is not public：
 * 同一个 key 调 GetOwnedGames 能过、调 GetPlayerAchievements 却被拒，
 * 因为成就接口对隐私的要求更严（需要「我的个人资料」和「游戏详情」都公开）。
 */
function explainSteamError(body) {
  const text = String(body ?? '');
  if (/profile is not public/i.test(text)) {
    return 'Steam 说「Profile is not public」：需要把 编辑个人资料 → 隐私设置 里的「我的个人资料」和「游戏详情」都设成公开';
  }
  if (/no stats/i.test(text)) return '这款游戏没有成就体系（Steam 回 Requested app has no stats）';
  return text.replace(/\s+/g, ' ').slice(0, 160);
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
export function headerImage(appid) {
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
    const parts = [`从 ${formatTime(game.lastPlayedSec)} 开始玩`];
    if (game.minutes2weeks > 0) parts.push(`两周内玩了 ${formatPlaytime(game.minutes2weeks)}`);
    if (game.minutesTotal > 0) parts.push(`游玩时长 ${formatPlaytime(game.minutesTotal)}`);
    items.push({
      id: `steam:play:${game.appid}:${game.lastPlayedSec}`,
      platform: 'steam',
      type: '游玩记录',
      title: `严肃游玩 ${name}`,
      summary: parts.join('，'),
      url: `https://steamcommunity.com/app/${game.appid}`,
      image: headerImage(game.appid),
      timestamp: new Date(game.lastPlayedSec * 1000).toISOString(),
      meta: {
        appid: game.appid,
        gameName: name,
        minutes2weeks: game.minutes2weeks,
        minutesTotal: game.minutesTotal,
        // 游戏头图当条目背景（和成就条目同一套版式，只是没有角标）
        backdrop: headerImage(game.appid),
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
 * `GetRecentlyPlayedGames` 只给 appid / 名称 / 两周与总时长，**不给** `rtime_last_played`
 * （那是 `GetOwnedGames` 才有的字段，实测返回里根本没有这个键）。
 * 所以「上次游玩时间」得再补一次 GetOwnedGames，一次性拿全部游戏的对应值。
 * @returns {Promise<Map<string, number>>} appid → Unix 秒
 */
async function lastPlayedTimes({ apiKey, steamId64 }) {
  const params = new URLSearchParams({
    key: apiKey,
    steamid: steamId64,
    include_played_free_games: '1',
    format: 'json',
  });
  const map = new Map();
  try {
    const data = await getJson(`${STEAM_API}/IPlayerService/GetOwnedGames/v1/?${params}`, {
      timeoutMs: 20000,
      retries: 1,
    });
    for (const game of data?.response?.games ?? []) {
      const appid = toAppId(game.appid);
      if (appid) map.set(appid, Number(game.rtime_last_played) || 0);
    }
  } catch (error) {
    const reason = error instanceof HttpError ? `HTTP ${error.status ?? '?'}` : error.message;
    console.warn(`[steam] 查询「上次游玩时间」失败（不影响成就）：${reason}`);
  }
  return map;
}

/**
 * 最近两周玩过的游戏（按两周游玩时长从长到短）。
 * 同时把「接口到底回了什么」原样带出来，供诊断用。
 * @returns {Promise<{games: Array<{appid: string, name: string|null, minutes2weeks: number,
 *   minutesTotal: number, lastPlayedSec: number}>, raw: object|null, error: string|null}>}
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
    return { games: [], raw: null, error: reason };
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
    return { games: [], raw: data ?? null, error: null };
  }

  const parsed = games
    .map((game) => ({
      appid: toAppId(game.appid),
      name: game.name ?? null,
      minutes2weeks: Number(game.playtime_2weeks) || 0,
      minutesTotal: Number(game.playtime_forever) || 0,
      lastPlayedSec: Number(game.rtime_last_played) || 0,
    }))
    .filter((game) => game.appid)
    .slice(0, maxGames);

  // 「上次游玩时间」这个接口不给，缺了就补一次 GetOwnedGames
  if (parsed.some((game) => !game.lastPlayedSec)) {
    const times = await lastPlayedTimes({ apiKey, steamId64 });
    for (const game of parsed) {
      if (!game.lastPlayedSec) game.lastPlayedSec = times.get(game.appid) ?? 0;
    }
  }

  return { games: parsed, raw: data ?? null, error: null };
}

/**
 * Valve 的 GetPlayerAchievements 返回的是 `achieved`（0/1）与 `unlocktime`（Unix 秒），
 * **不是** `unlocked` / `unlockedtime`——后者是某些第三方封装自己改的名字。
 * 之前按 unlocked 读，结果每条都被当成「没解锁」，成就永远是 0 条。
 */
const isAchieved = (achievement) => Number(achievement.achieved ?? achievement.unlocked ?? 0) === 1;
const unlockSeconds = (achievement) =>
  Number(achievement.unlocktime ?? achievement.unlockedtime ?? 0) || 0;

/**
 * 成就的中文名 / 描述 / 图标来自 GetSchemaForGame。GetPlayerAchievements 本身
 * 只给 apiname / achieved / unlocktime，直接用 apiname 当标题会显示成
 * 「ACH_WIN_ONE_GAME」这种内部标识。
 * @returns {Promise<Map<string, {displayName?: string, description?: string, icon?: string}>>}
 */
async function fetchAchievementSchema(appid, apiKey) {
  const params = new URLSearchParams({ key: apiKey, appid: String(appid), l: 'schinese' });
  try {
    const data = await getJson(`${STEAM_API}/ISteamUserStats/GetSchemaForGame/v2/?${params}`, {
      timeoutMs: 20000,
      retries: 1,
    });
    const list = data?.game?.availableGameStats?.achievements ?? [];
    const map = new Map();
    for (const achievement of list) {
      if (achievement?.name) map.set(achievement.name, achievement);
    }
    return map;
  } catch (error) {
    const reason = error instanceof HttpError ? `HTTP ${error.status ?? '?'}` : error.message;
    console.warn(`[steam] appid=${appid} 获取成就名称失败（标题将退回内部标识）：${reason}`);
    return new Map();
  }
}

/**
 * 单款游戏的成就解锁记录，只保留窗口内的。
 * @returns {Promise<{items: Array<object>, stats: {total: number, unlocked: number, inWindow: number}}>}
 */
async function fetchAchievementsForApp(appid, { apiKey, steamId64, sinceMs, gameName }) {
  const empty = (extra = {}) => ({
    items: [],
    stats: { total: 0, unlocked: 0, inWindow: 0, ok: false, error: null, ...extra },
  });
  const base = { steamid: steamId64, appid: String(appid), key: apiKey };
  // 线上实测：带 l=schinese 时这个接口会对部分账号直接回 403（同一个 key
  // 调 GetRecentlyPlayedGames / GetOwnedGames 都正常），去掉语言参数重试一次。
  const attempts = [
    { label: 'l=schinese', params: new URLSearchParams({ ...base, l: 'schinese' }) },
    { label: '无 l', params: new URLSearchParams(base) },
  ];

  let data = null;
  const failures = [];
  for (const attempt of attempts) {
    try {
      data = await getJson(`${STEAM_API}/ISteamUserStats/GetPlayerAchievements/v1/?${attempt.params}`, {
        timeoutMs: 20000,
        retries: 1,
      });
      break;
    } catch (error) {
      // 把响应体一起带上：Steam 的 403 会说明到底是「无权访问」「隐私没开」还是「key 不对」
      const reason =
        error instanceof HttpError
          ? `HTTP ${error.status ?? '?'}${error.body ? `（${explainSteamError(error.body)}）` : ''}`
          : error.message;
      failures.push(`${attempt.label} → ${reason}`);
    }
  }
  if (!data) {
    const reason = failures.join('；');
    // 「这款游戏没有成就体系」是正常情况，不值得刷一行警告
    if (/no stats/i.test(reason)) return empty({ error: reason });
    console.warn(`[steam] appid=${appid} 获取成就失败：${reason}`);
    return empty({ error: reason });
  }

  const stats = data?.playerstats ?? {};
  // 该游戏没有成就体系时这里会是 { success: false, error: 'Requested app has no stats' }
  if (stats.success === false || !Array.isArray(stats.achievements)) {
    const detail = typeof stats.error === 'string' ? stats.error : null;
    if (detail) console.warn(`[steam] appid=${appid} 读不到成就：${detail}`);
    return empty({ error: detail });
  }

  const gameTitle = stats.gameName ?? gameName ?? `App ${appid}`;
  const unlockedTotal = stats.achievements.filter(isAchieved).length;
  const fresh = [];
  for (const achievement of stats.achievements) {
    if (!isAchieved(achievement)) continue;
    const seconds = unlockSeconds(achievement);
    if (!seconds || seconds * 1000 < sinceMs) continue;
    fresh.push({ achievement, seconds });
  }

  const summary = {
    total: stats.achievements.length,
    unlocked: unlockedTotal,
    inWindow: fresh.length,
    ok: true,
    error: null,
  };
  if (fresh.length === 0) return { items: [], stats: summary };

  // 只有真的要把成就写进列表时，才多花一次请求去取中文名
  const schema = await fetchAchievementSchema(appid, apiKey);

  const items = fresh.map(({ achievement, seconds }) => {
    const key = achievement.apiname || achievement.name || 'unknown';
    const detail = schema.get(key) ?? {};
    const title = achievement.name || achievement.displayName || detail.displayName || key;
    const description = achievement.description || detail.description || '';
    const icon = achievement.icon || detail.icon || detail.icongray || null;
    return {
      id: `steam:${appid}:${key}`,
      platform: 'steam',
      type: '成就解锁',
      title,
      summary: description
        ? `${gameTitle} 获得成就💀️「${title}」：${description}`
        : `${gameTitle} 获得成就💀️「${title}」`,
      url: `https://steamcommunity.com/profiles/${steamId64}/stats/${appid}/achievements`,
      image: icon,
      timestamp: new Date(seconds * 1000).toISOString(),
      meta: {
        appid,
        gameName: gameTitle,
        achievementId: key,
        // 背景用游戏头图（不需要 key，CDN 直出 460×215），图标缩成右下角角标
        backdrop: headerImage(appid),
        badge: icon,
      },
    };
  });
  return { items, stats: summary };
}

/**
 * @param {{since?: Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchSteam(context = {}) {
  const config = steamConfig();
  const sinceMs = windowStart(context, config.lookbackDays);
  const diag = {
    checkedAt: new Date().toISOString(),
    since: new Date(sinceMs).toISOString(),
    note: '',
    totalCount: null,
    games: [],
    playItems: 0,
    achievementItems: 0,
    achievements: [],
  };
  diagnostics = diag;

  if (!config.apiKey || !config.steamId64) {
    console.warn('[steam] 缺少 steam.apiKey 或 steam.steamId64，跳过');
    diag.note = '缺少密钥（steam.apiKey / steam.steamId64）';
    return [];
  }

  // SteamID64 是 17 位纯数字；填成 toad1145 这种自定义名或填错位数时，
  // API 只会返回空，不会报错，所以这里先把它显式点出来。
  if (!/^\d{17}$/.test(config.steamId64)) {
    const tail =
      config.steamId64.length > 6
        ? `${config.steamId64.slice(0, 5)}…（${config.steamId64.length} 位）`
        : '（位数明显不对）';
    console.warn(
      `[steam] steamId64 应该是 17 位纯数字，当前是 ${tail}；` +
        '用 https://steamid.io 把个人资料链接换算一下',
    );
    diag.note = `steamId64 位数不对（${config.steamId64.length} 位）`;
  }

  const recent = config.recentGames
    ? await recentlyPlayedGames(config)
    : { games: [], raw: null, error: null };
  const games = recent.games;
  diag.totalCount = recent.raw?.response?.total_count ?? null;
  diag.games = games.map((game) => ({
    appid: game.appid,
    name: game.name,
    minutes2weeks: game.minutes2weeks,
    minutesTotal: game.minutesTotal,
    lastPlayed: game.lastPlayedSec ? new Date(game.lastPlayedSec * 1000).toISOString() : null,
  }));
  if (recent.error) diag.note = `查询最近游戏失败：${recent.error}`;
  else if (games.length === 0) {
    diag.note =
      diag.totalCount === 0
        ? '最近两周没有可读的游玩记录（total_count=0），游戏可能还开着没同步'
        : '接口返回空对象，多半是隐私「游戏详情」未公开或 steamId64 不是这个账号';
  }

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
  diag.playItems = plays;

  // 固定关注的 AppID 排在最前（去重）：它们是刻意点名要跟踪的，
  // 全量回填时不能被最近游戏的长尾把 maxItems 预算吃掉而遭截断。
  const targets = new Map();
  for (const appid of config.extraAppIds) targets.set(appid, null);
  for (const game of games) {
    if (!targets.has(game.appid)) targets.set(game.appid, game.name);
  }

  if (targets.size === 0) {
    console.log('[steam] 本轮没有需要检查的游戏');
    return collected.slice(0, config.maxItems);
  }

  for (const [appid, name] of targets) {
    const { items, stats } = await fetchAchievementsForApp(appid, {
      apiKey: config.apiKey,
      steamId64: config.steamId64,
      sinceMs,
      gameName: name,
    });
    diag.achievements.push({ appid, name: name ?? null, ...stats });
    if (stats.inWindow > 0) {
      console.log(`[steam] ${name ?? `App ${appid}`}：窗口内解锁 ${stats.inWindow} 个成就`);
    } else if (stats.unlocked > 0) {
      console.log(
        `[steam] ${name ?? `App ${appid}`}：共 ${stats.total} 个成就、已解锁 ${stats.unlocked} 个，窗口内没有新的`,
      );
    }
    collected.push(...items);
    if (collected.length >= config.maxItems) break;
  }

  const days = Math.max(1, Math.round((Date.now() - sinceMs) / DAY_MS));
  const achievements = Math.max(0, Math.min(collected.length, config.maxItems) - plays);
  diag.achievementItems = achievements;
  console.log(
    `[steam] 检查 ${targets.size} 款游戏（回看 ${days} 天），` +
      `新增 ${plays} 条游玩记录 + ${achievements} 条成就`,
  );
  const privacyBlocked = diag.achievements.some((entry) => /Profile is not public/i.test(entry.error ?? ''));
  if (privacyBlocked && collected.length === 0) {
    diag.note =
      'Steam 拒绝读成就：Profile is not public。把「编辑个人资料 → 隐私设置」里的' +
      '「我的个人资料」和「游戏详情」都设为公开（游玩记录不受影响，可以正常写）';
    console.warn(`[steam] ${diag.note}`);
  }
  if (collected.length === 0 && games.length > 0) {
    const unlockedSum = diag.achievements.reduce((sum, entry) => sum + (entry.unlocked ?? 0), 0);
    const totalSum = diag.achievements.reduce((sum, entry) => sum + (entry.total ?? 0), 0);
    console.warn(
      '[steam] 游戏在最近列表里，但窗口内既没有新会话也没有新成就。' +
        `（这些游戏共有 ${totalSum} 个成就、已解锁 ${unlockedSum} 个，只是都不在窗口内）`,
    );
    if (!privacyBlocked) {
      diag.note =
        unlockedSum > 0
          ? `窗口内没有新动作：这些游戏的 ${unlockedSum} 个已解锁成就都在上次抓取之前`
          : '窗口内没有新动作：最近列表里的游戏都没有成就体系，或本周没有新解锁';
    }
  }
  return collected.slice(0, config.maxItems);
}

/**
 * 最近两周玩过的游戏 → 可读列表（导出给测试用，逻辑与运行时一致）。
 */
export { recentlyPlayedGames, windowStart, fetchAchievementsForApp, playItems, formatPlaytime, explainSteamError };
