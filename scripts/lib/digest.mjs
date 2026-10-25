/**
 * 仓库活动汇总（GitHub / Gitee 共用）。
 *
 * 输出的是「一个仓库一张卡」的汇总条目，版式复用 Weblate 那套
 * （item--digest + 可翻页的逐条明细），所以必须带 meta.merge 和 meta.changes。
 *
 * 三级结构，缺一不可：
 *   1. 一个仓库一张卡 —— 逐个提交列出来会把整条时间线刷满，也无法回答
 *      「这个仓库我一共干了多少」。不同仓库天然分开。
 *   2. 卡内按「连续工作时段」分段 —— 隔了一周再动同一个仓库，混在一段里
 *      会让人误以为是同一次连续工作，所以用时间空档切开，每段加一条分段标头。
 *   3. 段内逐条列出 —— 提交信息 / Issue 标题 / 短 sha，可翻页。
 *
 * 聚合键（id）只到仓库一级：`<platform>:repo:<仓库全名>`。同一仓库继续干活时
 * id 不变 → collect 走「覆盖」而不是「新增」，卡片原地更新，条数越滚越准，
 * 也不会因为抓取窗口边界滑动而重复出卡。
 */

/** 相邻两条动作间隔超过 gapMs 就切开。输入需按时间升序。 */
export function splitByGap(actions, gapMs) {
  const sessions = [];
  let current = [];
  for (const action of actions) {
    const prev = current[current.length - 1];
    if (prev && action.ts - prev.ts > gapMs) {
      sessions.push(current);
      current = [];
    }
    current.push(action);
  }
  if (current.length) sessions.push(current);
  return sessions;
}

/** 统一成「毫秒精度」的 ISO，避免 .123Z / .000Z 抖动。 */
export function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

/** 固定 UTC+8 的短时间（CI 与本机时区不一致，不能用 toLocaleString 碰运地）。 */
function shortTime(ms, withDate = true) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (!withDate) return hm;
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hm}`;
}

function shortDate(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const KIND_TITLES = {
  提交: (n) => `${n} 次提交`,
  '新建 PR': (n) => `${n} 个 PR`,
  '新建 Issue': (n) => `${n} 个 Issue`,
  '合并 PR': (n) => `${n} 个 PR 合并`,
  新建仓库: (n) => `${n} 个新仓库`,
  发布: (n) => `${n} 次发布`,
};

function countsText(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => (KIND_TITLES[kind] ? KIND_TITLES[kind](n) : `${kind} ${n} 条`))
    .join('、');
}

/** 单条动作的展示文案兜底（提交信息可能是空串）。 */
function rowText(action) {
  const text = String(action.text ?? '').trim();
  if (text) return text.slice(0, 160);
  return action.kind === '提交' ? '（无提交信息）' : '（无标题）';
}

/** 分段标头：`10-25 20:01–20:48 · 5 条`，跨天的写成 `10-23 22:10 → 10-24 01:30`。 */
function sessionLabel(session) {
  const start = session[0].ts;
  const end = session[session.length - 1].ts;
  const sameDay = shortDate(start) === shortDate(end);
  const span = sameDay ? `${shortTime(start)}–${shortTime(end, false)}` : `${shortTime(start)} → ${shortTime(end)}`;
  return `${span} · ${session.length} 条`;
}

/** 把同一个仓库的全部动作用汇总成一张卡。 */
function buildRepo({ platform, repo, sessions, maxRows, type }) {
  const all = sessions.flat();
  if (!all.length) return null;

  const first = all[0];
  const last = all[all.length - 1];
  const counts = new Map();
  for (const action of all) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);

  // 明细：最新的时段在最上面，段内也是最新在前
  const rows = [];
  let emitted = 0;
  for (let i = sessions.length - 1; i >= 0 && emitted < maxRows; i -= 1) {
    const session = sessions[i];
    // 只有「一段里不止一条」且「整卡不止一段」时加标头，否则标头比内容还多
    if (sessions.length > 1 && session.length > 1) rows.push({ group: sessionLabel(session) });
    for (let j = session.length - 1; j >= 0 && emitted < maxRows; j -= 1) {
      const action = session[j];
      rows.push({
        text: rowText(action),
        action: action.kind,
        component: action.component ?? null,
        url: action.url ?? first.repoUrl ?? null,
        time: stamp(action.ts),
      });
      emitted += 1;
    }
  }

  const total = all.length;
  const latestText = rowText(last);
  // 「新建仓库」只是这张卡的开场白，标题里再算一项会把标题拉得很长；
  // 但也别让它凭空消失——只有它一种动作时照常显示。
  const headline = counts.size > 1 && counts.has('新建仓库')
    ? new Map([...counts].filter(([kind]) => kind !== '新建仓库'))
    : counts;
  const span = shortDate(first.ts) === shortDate(last.ts)
    ? ''
    : `（${shortDate(first.ts)} → ${shortDate(last.ts)}）`;
  const summary = [
    countsText(headline),
    span ? `横跨 ${span.slice(1, -1)}` : '',
    last.kind === '新建仓库' ? '' : `最近一条「${latestText.slice(0, 40)}」`,
  ]
    .filter(Boolean)
    .join('，');

  return {
    id: `${platform}:repo:${repo}`,
    platform,
    type,
    title: `${repo} · ${countsText(headline)}`,
    summary,
    url: first.repoUrl ?? last.url ?? null,
    image: null,
    // 按最后一次动作排序：仓库有动静就浮上来
    timestamp: stamp(last.ts),
    meta: {
      // collect 依据它做「覆盖 + 吸收窗口内的旧记录」，而不是当作新条目追加
      merge: true,
      kind: 'repo-digest',
      repo,
      count: total,
      // 逐条明细（页面每页 10 条，靠页码切换）；{ group } 行是分段标头，不计数
      changes: rows,
      windowStart: stamp(first.ts),
      windowEnd: stamp(last.ts),
      sessions: sessions.length,
      actions: Object.fromEntries(counts),
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.platform
 * @param {Array<{repo: string, repoUrl?: string, kind: string, ts: number, text?: string, url?: string, component?: string}>} options.actions
 * @param {number} options.gapMs 连续工作时段之间的最小空档
 * @param {number} [options.maxRows] 单卡最多保留多少条明细
 * @param {string} [options.type] 条目类型文案
 * @returns {Array<object>} 汇总条目，最新在前
 */
export function buildRepoDigests({ platform, actions, gapMs, maxRows = 300, type = '仓库活动' }) {
  // 同一个提交可能被翻页/重试抓到两次，先按 id 去重
  const seen = new Set();
  const unique = [];
  for (const action of actions) {
    if (!Number.isFinite(action.ts) || !action.repo) continue;
    const key = action.uid ?? `${action.repo}:${action.kind}:${action.ts}:${action.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(action);
  }

  const byRepo = new Map();
  for (const action of unique) {
    if (!byRepo.has(action.repo)) byRepo.set(action.repo, []);
    byRepo.get(action.repo).push(action);
  }

  const digests = [];
  for (const [repo, list] of byRepo) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    const digest = buildRepo({
      platform,
      repo,
      sessions: splitByGap(sorted, gapMs),
      maxRows,
      type,
    });
    if (digest) digests.push(digest);
  }

  return digests.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}
