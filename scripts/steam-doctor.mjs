#!/usr/bin/env node
/**
 * Steam 抓取自检。
 *
 * Steam 在「抓不到东西」时不会报错，只会回空，而 CI 里那几行日志翻起来很费劲。
 * 这个脚本把同一套请求在本地跑一遍并直接解释结果：
 *
 *   STEAM_API_KEY=xxxx STEAM_ID64=7656119xxxxxxxxxx node scripts/steam-doctor.mjs
 *
 * 只读，不写 res/，也不会把 key 打印出来。
 */
import { platform, configPath } from './lib/config.mjs';
import { getJson, HttpError } from './lib/http.mjs';

const steam = platform('steam');
const apiKey = String(steam.apiKey ?? '').trim();
const steamId64 = String(steam.steamId64 ?? '').trim();

const mask = (value) =>
  value.length <= 8 ? '***' : `${value.slice(0, 4)}${'*'.repeat(Math.min(8, value.length - 8))}${value.slice(-4)}`;

const show = (label, value) => console.log(`  ${label.padEnd(14)}${value}`);

console.log(`配置文件：${configPath}`);
console.log('');

if (!apiKey || !steamId64) {
  console.error('缺少密钥，先把环境变量设好再跑：');
  console.error('  STEAM_API_KEY=... STEAM_ID64=... node scripts/steam-doctor.mjs');
  process.exit(1);
}

console.log('凭据');
show('apiKey', mask(apiKey));
show('steamId64', steamId64);
if (!/^\d{17}$/.test(steamId64)) {
  console.error(
    `\n✗ steamId64 是 ${steamId64.length} 位，应该是 17 位纯数字。` +
      '\n  自定义名（如 toad1145）不行，用 https://steamid.io 换算一下。',
  );
  process.exit(1);
}

const params = new URLSearchParams({ key: apiKey, steamid: steamId64, format: 'json' });
let data;
try {
  data = await getJson(`https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?${params}`, {
    timeoutMs: 20000,
    retries: 1,
  });
} catch (error) {
  const reason = error instanceof HttpError ? `HTTP ${error.status}` : error.message;
  console.error(`\n✗ 请求失败：${reason}`);
  if (error instanceof HttpError && error.status === 403) {
    console.error('  403 多半是 key 不对，或者这个 key 不是你账号的。');
  }
  process.exit(1);
}

const response = data?.response ?? {};
const games = Array.isArray(response.games) ? response.games : [];

console.log('\nGetRecentlyPlayedGames');
show('原始返回', JSON.stringify(data).slice(0, 400));

if (games.length === 0) {
  console.log('');
  if (response.total_count === 0) {
    console.log('→ 接口正常，但这段时间没有可读的游玩记录。');
    console.log('  · 游戏还开着：Steam 一般要等你退出后才会把这次会话同步给接口，关掉再等 1~2 分钟');
    console.log('  · 最近两周确实没启动过游戏');
  } else {
    console.log('→ 返回的是空对象 {"response":{}}，API 拿不到你的任何数据，通常是：');
    console.log('  · 「编辑个人资料 → 隐私设置 → 游戏详情」不是公开');
    console.log('  · steamId64 不是这个账号的（打开 steamcommunity.com/profiles/<id> 看是不是你自己的主页）');
  }
  process.exit(0);
}

console.log(`\n找到 ${games.length} 款最近两周玩过的游戏`);
const fmt = (minutes) => {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
};
const when = (seconds) =>
  seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '接口未返回';

for (const game of games) {
  console.log(
    `  · ${game.name ?? `App ${game.appid}`}（${game.appid}）：` +
      `两周 ${fmt(game.playtime_2weeks)} / 总计 ${fmt(game.playtime_forever)} / ` +
      `上次游玩 ${when(game.rtime_last_played)}`,
  );
}

// 顺便看看第一款游戏的成就能不能读到，确认 ISteamUserStats 这条链路通不通
const first = games[0];
const achParams = new URLSearchParams({
  steamid: steamId64,
  appid: String(first.appid),
  key: apiKey,
  l: 'schinese',
});
try {
  const achData = await getJson(
    `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?${achParams}`,
    { timeoutMs: 20000, retries: 1 },
  );
  const stats = achData?.playerstats ?? {};
  if (stats.success === false || !Array.isArray(stats.achievements)) {
    console.log(`\n成就接口：${first.name ?? first.appid} 没有成就体系（success:false），会静默跳过`);
  } else {
    const unlocked = stats.achievements.filter((a) => a.unlocked);
    const recent = unlocked.filter((a) => Number(a.unlockedtime) * 1000 > Date.now() - 7 * 864e5);
    console.log(
      `\n成就接口：${first.name ?? first.appid} 共 ${stats.achievements.length} 个成就，已解锁 ${unlocked.length} 个，` +
        `最近 7 天解锁 ${recent.length} 个`,
    );
  }
} catch (error) {
  console.warn(`\n成就接口请求失败：${error instanceof HttpError ? `HTTP ${error.status}` : error.message}`);
}

console.log('\n结论：链路是通的，上面这些游戏里「上次游玩」在抓取窗口内的会写一条游玩记录。');
