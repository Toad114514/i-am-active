#!/usr/bin/env node
/**
 * RetroAchievements 抓取自检。
 *
 * RA 抓不到东西时只会静默返回空数组，CI 日志里也只是一行「回看 N 分钟，成就 0 条」。
 * 这个脚本把同一套请求在本地跑一遍并直接解释结果：
 *
 *   RA_API_KEY=xxxxxxxx node scripts/ra-doctor.mjs
 *   RA_API_KEY=xxxxxxxx node scripts/ra-doctor.mjs --minutes 2880   # 往前看两天
 *
 * 只读，不写 res/，也不会把 key 打印出来。
 */
import { platform, configPath } from './lib/config.mjs';
import { getJson, HttpError } from './lib/http.mjs';
import { explainError, maskKey, toIso } from './sources/retroachievements.mjs';

const API = 'https://retroachievements.org/API';
const args = process.argv.slice(2);
const minutesArg = args.indexOf('--minutes');
const minutes = minutesArg >= 0 ? Number(args[minutesArg + 1]) : 60 * 24 * 7;

const ra = platform('retroachievements');
const user = String(ra.user ?? '').trim();
const key = String(ra.webApiKey ?? '').trim();

const show = (label, value) => console.log(`  ${label.padEnd(16)}${value}`);

console.log(`配置文件：${configPath}`);
console.log('');

if (!key) {
  console.error('缺少密钥，先设好环境变量再跑：');
  console.error('  RA_API_KEY=... node scripts/ra-doctor.mjs');
  process.exit(1);
}

console.log('凭据');
show('user', user || '（没配）');
show('webApiKey', maskKey(key));
if (!user) {
  console.error('\n✗ config.yaml 里 retroachievements.user 是空的。');
  process.exit(1);
}

async function call(path, params) {
  const query = new URLSearchParams({ y: key, ...params });
  try {
    const data = await getJson(`${API}/${path}?${query}`, { timeoutMs: 20000, retries: 1 });
    return { data, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof HttpError ? explainError(error) : error.message,
    };
  }
}

// ---------- 1) 用户名 + key ----------
const profile = await call('API_GetUserProfile.php', { u: user });
console.log('\nGetUserProfile');
if (profile.error) {
  console.error(`  ✗ ${profile.error}`);
  console.error('  → key 不对 / 已重置 / 不是这个账号的 key，都回这个错。');
  process.exit(1);
}
if (!profile.data?.User) {
  console.error(`  ✗ 用户 "${user}" 不存在（检查 config.yaml 的 retroachievements.user，区分大小写）`);
  process.exit(1);
}
show('用户', profile.data.User);
show('总积分', profile.data.TotalPoints ?? '未知');
show('注册时间', profile.data.MemberSince ?? '未知');
show('最近游戏ID', profile.data.LastGameID ?? '未知');

// ---------- 2) 近期成就 ----------
console.log(`\nGetUserRecentAchievements（回看 ${minutes} 分钟）`);
const recent = await call('API_GetUserRecentAchievements.php', { u: user, m: String(minutes) });
if (recent.error) {
  console.error(`  ✗ ${recent.error}`);
} else if (!Array.isArray(recent.data)) {
  console.error(`  ✗ 返回不是数组：${JSON.stringify(recent.data).slice(0, 200)}`);
} else if (recent.data.length === 0) {
  console.log('  （空）');
  console.log('  → key 正常、用户正常，只是这段窗口里没有解锁记录。');
  console.log('  → 想确认历史记录：把 --minutes 调大，例如 --minutes 43200（30 天）。');
} else {
  show('条数', recent.data.length);
  for (const a of recent.data.slice(0, 8)) {
    const time = toIso(a.Date) ?? a.Date;
    console.log(
      `  · ${time}  ${a.GameTitle ?? '?'} / ${a.Title ?? '?'}` +
        `  ${a.Points ?? '?'}分${a.HardcoreMode === 1 ? ' 硬核' : ''}`,
    );
  }
  if (recent.data.length > 8) console.log(`  … 还有 ${recent.data.length - 8} 条`);
}

// ---------- 3) 最近玩过的游戏 ----------
console.log('\nGetUserRecentlyPlayedGames');
const played = await call('API_GetUserRecentlyPlayedGames.php', { u: user, c: '10' });
if (played.error) {
  console.error(`  ✗ ${played.error}`);
} else if (!Array.isArray(played.data)) {
  console.error(`  ✗ 返回不是数组：${JSON.stringify(played.data).slice(0, 200)}`);
} else if (played.data.length === 0) {
  console.log('  （空）→ 近两周没在这账号上玩过游戏？');
} else {
  for (const g of played.data) {
    const time = toIso(g.LastPlayed) ?? g.LastPlayed;
    console.log(
      `  · ${time}  ${g.Title ?? '?'}（${g.ConsoleName ?? '?'}）` +
        `  成就 ${g.NumAchieved ?? '?'}/${g.NumPossibleAchievements ?? '?'}`,
    );
  }
}

// ---------- 4) 游戏图（截图/封面）----------
// 站点上成就条目的背景就是这里拿的：参数名必须是 `i`，写成 `g` 会静默返回空对象。
const firstGameId = Array.isArray(recent.data) ? recent.data[0]?.GameID : null;
if (firstGameId) {
  console.log(`\nGetGame（gameId=${firstGameId}）`);
  const game = await call('API_GetGame.php', { i: String(firstGameId) });
  if (game.error) {
    console.error(`  ✗ ${game.error}`);
  } else if (!game.data || !Object.keys(game.data).length) {
    console.error('  ✗ 返回空对象 → 参数名写错（必须是 i=<gameId>，不是 g=）');
  } else {
    const pick = (o, a, b) => o?.[a] ?? o?.[b] ?? '（无）';
    show('ImageIngame', pick(game.data, 'ImageIngame', 'imageIngame'));
    show('ImageBoxArt', pick(game.data, 'ImageBoxArt', 'imageBoxArt'));
    show('ImageTitle', pick(game.data, 'ImageTitle', 'imageTitle'));
    console.log('  → 条目背景优先用 ImageIngame，其次 ImageBoxArt。');
  }
}

console.log('\n小结');
console.log('  · 成就接口正常但为空 → 那段时间确实没解锁，不是抓取坏了。');
console.log('  · 只要「玩过」能看见游戏 → 说明账号、key、网络都通，成就为空是游戏侧的事');
console.log('    （模拟器没开成就检测 / 用了别人的存档 / 玩的不是被追踪的 ROM 版本）。');
console.log('  · 「游玩记录」写进站点还需要 collect 跑一轮：node scripts/collect.mjs retroachievements');
