#!/usr/bin/env node
/**
 * 历史条目的文案回填。
 *
 * 为什么需要：`title` / `summary` / `type` 是**抓取那一刻**用 source 里的模板拼好、
 * 写死进 `res/list.json` 的成品文本。改了模板以后，增量抓取只产出新条目，老条目
 * 还停在旧措辞上（「本次会话开始于…」「在《X》解锁硬核成就…」）。这里按旧格式
 * 原地重写成**当前模板会生成的样子**——不是另造一套文案，是把同一套模板补回去。
 *
 * 幂等：已经是新格式的条目不再匹配，跑多少次结果一样。
 *
 * 用法：
 *   node scripts/tools/rewrite-text.mjs           # 只打印会改哪些
 *   node scripts/tools/rewrite-text.mjs --write   # 写回 res/list.json
 *
 * 注意：这里写的是**快照**，以后 source 的模板再改，要同步更新本文件的映射
 * （每条规则的注释里都写了对应的 source 位置）。
 */

import { readList, writeList } from '../lib/store.mjs';

const write = process.argv.includes('--write');

// Steam 成就那个骷髅头是 U+1F480 + U+FE0F（变体选择符），少一个字节就和
// source 生成的文本对不上，直接写码点，别手打。
const SKULL = '\u{1F480}\uFE0F';

/** B 站：typeLabel() 里「投稿视频 → 新视频」「图文动态 → 神秘小图文」 */
function rewriteBilibili(item) {
  if (item.platform !== 'bilibili') return null;
  const map = { 投稿视频: '新视频', 图文动态: '神秘小图文' };
  const next = map[item.type];
  if (!next) return null;
  return { ...item, type: next };
}

/**
 * RA 成就：achievementItem()
 *   `在《G》解锁硬核成就「T」，10 分：desc`
 *   → `我在《G》解锁了 Hardcore「T」，获得了 10 分的好成绩：desc`
 * 老数据的 type 是「硬核成就 / 成就」，正好用来判断 Hardcore 还是 Softcore。
 */
const RA_ACH = /^在《(.+?)》解锁(硬核成就|成就)「([\s\S]+?)」，(\d+) 分(?:：([\s\S]*))?$/;

function rewriteRaAchievement(item) {
  if (item.platform !== 'retroachievements' || item.type === '游玩记录') return null;
  const m = RA_ACH.exec(item.summary ?? '');
  if (!m) return null;
  const [, game, tier, title, points, desc] = m;
  const hardcore = tier === '硬核成就' ? 'Hardcore' : 'Softcore';
  const head = `我在《${game}》解锁了 ${hardcore}「${title}」，获得了 ${points} 分的好成绩`;
  // type 也一起换掉：source 里是 `type: hardcoreText`，本来就是英文
  return { ...item, type: hardcore, summary: desc ? `${head}：${desc}` : head };
}

/**
 * RA 成就的 type 单独特化：有些条目 summary 上一轮已经改成新措辞，走不到上面那条
 * 规则，type 还停在「硬核成就 / 成就」。这里用 meta.hardcore 判定——它和两种 type
 * 严格一一对应，且与 summary 措辞无关，所以幂等。
 * `游玩记录` 没有 hardcore 字段，靠 typeof 判断天然排除，不会被打成 Softcore。
 */
function rewriteRaType(item) {
  if (item.platform !== 'retroachievements') return null;
  if (typeof item.meta?.hardcore !== 'boolean') return null;
  const tier = item.meta.hardcore ? 'Hardcore' : 'Softcore';
  if (item.type === tier) return null;
  return { ...item, type: tier };
}

/**
 * RA 游玩：playSessionItem()
 *   title  `玩了《G》`            → `严肃游玩 G`
 *   summary `在 N64 上玩了《G》，成就 30/298`
 *         → `在 N64 上严肃游玩了 G ，30/298 完成`
 * 注意 G 后面那个空格是 source 里 `严肃游玩了 ${title} ${scoreText}` 拼出来的。
 */
const RA_PLAY = /^在 (.+?) 上玩了《(.+?)》，成就 (\d+)\/(\d+)$/;

function rewriteRaPlay(item) {
  if (item.platform !== 'retroachievements' || item.type !== '游玩记录') return null;
  const m = RA_PLAY.exec(item.summary ?? '');
  if (!m) return null;
  const [, consoleName, game, done, total] = m;
  return {
    ...item,
    title: `严肃游玩 ${game}`,
    summary: `在 ${consoleName} 上严肃游玩了 ${game} ，${done}/${total} 完成`,
  };
}

/**
 * Steam 游玩：playItems()
 *   title  `《G》` → `严肃游玩 G`
 *   `本次会话开始于 T，两周内共 X，累计 Y` → `从 T 开始玩，两周内玩了 X，游玩时长 Y`
 */
const ST_PLAY = /^本次会话开始于 (.+?)，(?:两周内共 ([^，]+)，)?累计 (.+)$/;

function rewriteSteamPlay(item) {
  if (item.platform !== 'steam' || item.type !== '游玩记录') return null;
  const m = ST_PLAY.exec(item.summary ?? '');
  const name = /^《([\s\S]+)》$/.exec(item.title ?? '')?.[1];
  if (!m || !name) return null;
  const [, at, twoWeeks, totalTime] = m;
  const parts = [`从 ${at} 开始玩`];
  if (twoWeeks) parts.push(`两周内玩了 ${twoWeeks}`);
  parts.push(`游玩时长 ${totalTime}`);
  return { ...item, title: `严肃游玩 ${name}`, summary: parts.join('，') };
}

/**
 * Steam 成就：`在《G》解锁成就「T」：desc` → `G 获得成就💀️「T」：desc`
 * （source 里 gameTitle 后面是个空格，没有书名号）
 */
const ST_ACH = /^在《(.+?)》解锁成就「([\s\S]+?)」(?:：([\s\S]*))?$/;

function rewriteSteamAchievement(item) {
  if (item.platform !== 'steam' || item.type !== '成就解锁') return null;
  const m = ST_ACH.exec(item.summary ?? '');
  if (!m) return null;
  const [, game, title, desc] = m;
  const head = `${game} 获得成就${SKULL}「${title}」`;
  return { ...item, summary: desc ? `${head}：${desc}` : head };
}

const RULES = [
  ['bilibili 类型', rewriteBilibili],
  ['RA 成就', rewriteRaAchievement],
  ['RA 成就 type', rewriteRaType],
  ['RA 游玩', rewriteRaPlay],
  ['Steam 游玩', rewriteSteamPlay],
  ['Steam 成就', rewriteSteamAchievement],
];

const items = await readList();
const out = [];
const hits = new Map();

for (const item of items) {
  let next = null;
  for (const [label, fn] of RULES) {
    const r = fn(item);
    if (!r) continue;
    next = r;
    hits.set(label, (hits.get(label) ?? 0) + 1);
    break;
  }
  out.push(next ?? item);
}

if (hits.size === 0) {
  console.log('没有需要改的条目（都已经是新措辞）');
  process.exit(0);
}

for (const [label, n] of hits) console.log(`  ${label}: ${n} 条`);
console.log(`  合计 ${[...hits.values()].reduce((a, b) => a + b, 0)} / ${items.length} 条`);

// 抽出几条改动前后的对照，方便肉眼确认
const samples = [];
for (let i = 0; i < items.length && samples.length < 6; i += 1) {
  if (items[i] === out[i]) continue;
  samples.push({ before: items[i], after: out[i] });
}
console.log('\n样例：');
for (const { before, after } of samples) {
  console.log(`  ${before.platform} [${before.type} → ${after.type}]`);
  if (before.title !== after.title) console.log(`    title  ${before.title}  →  ${after.title}`);
  if (before.summary !== after.summary) {
    console.log(`    before ${String(before.summary).slice(0, 76)}`);
    console.log(`    after  ${String(after.summary).slice(0, 76)}`);
  }
}

if (!write) {
  console.log('\n（只预览，加 --write 才写回 res/list.json）');
  process.exit(0);
}

await writeList(out);
console.log('\n已写回 res/list.json');
