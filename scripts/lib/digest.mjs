/**
 * 仓库活动汇总（GitHub / Gitee 共用）。
 *
 * 输出的是「一次连续动工一张卡」的汇总条目，版式复用 Weblate 那套
 * （item--digest + 可翻页的逐条明细），所以必须带 meta.merge 和 meta.changes。
 *
 * 两级结构：
 *   1. 按「连续工作时段」切卡 —— 同一个仓库隔了几天再动一次，是两次完全
 *      不同的事，混成一张卡会变成一个越滚越大、看不出节奏的仓库档案。
 *      相邻两次操作的空档超过 gapMs 就切开，一段一张卡。
 *   2. 段内逐条列出 —— 提交信息 / Issue 标题 / 短 sha，可翻页。
 *
 * 聚合键（id）锚在**时段起点**：`<platform>:repo:<仓库全名>:<时段第一条操作的时间>`。
 *
 *   - 不能用「仓库」当 id（旧做法）：那样一个仓库只有一张卡，等于把上面第 1 条
 *     的切分全丢掉，卡片只能靠卡内的分段标头表达时间，列表上仍是一大坨。
 *   - 也不能锚在时段终点：一次动工里随时会再推一个提交，终点会往后挪，
 *     id 跟着变，于是同一段工作会不停「换 id 重出卡」，旧卡得靠吸收逻辑删，
 *     每轮都要删一次。起点在整段工作期间是固定的，追加提交只会原地更新这张卡。
 *
 * 一个仓库的多个时段卡之间在时间上互不重叠，所以 collect 的「新卡包住旧卡就替换」
 * 不会误删兄弟卡；反过来，两个时段被新数据接上（补抓到中间的提交）时，合并后的
 * 新卡会完整包住那两张旧卡，旧的被吸收掉，正好是想要的结果。
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

/** 时段的时间范围：`10-25 20:01–20:48`，跨天写成 `10-23 22:10 → 10-24 01:30`。 */
function sessionSpan(session) {
  const start = session[0].ts;
  const end = session[session.length - 1].ts;
  // 单独一条动作没法定范围，写起点就够了
  if (session.length === 1) return shortTime(start);
  const sameDay = shortDate(start) === shortDate(end);
  return sameDay
    ? `${shortTime(start)}–${shortTime(end, false)}`
    : `${shortTime(start)} → ${shortTime(end)}`;
}

/** 把一段连续工作做成一张卡。 */
function buildSessionCard({ platform, repo, session, maxRows, type }) {
  if (!session.length) return null;

  const first = session[0];
  const last = session[session.length - 1];
  const counts = new Map();
  for (const action of session) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);

  // 明细：段内最新在前
  const rows = [];
  for (let i = session.length - 1; i >= 0 && rows.length < maxRows; i -= 1) {
    const action = session[i];
    rows.push({
      text: rowText(action),
      action: action.kind,
      component: action.component ?? null,
      url: action.url ?? first.repoUrl ?? null,
      time: stamp(action.ts),
    });
  }

  const total = session.length;
  const latestText = rowText(last);
  // 新建仓库的「最近一条」就是仓库名，和标题重复，去掉
  const summary = [
    sessionSpan(session),
    last.kind === '新建仓库' ? '' : `最近一条「${latestText.slice(0, 40)}」`,
  ]
    .filter(Boolean)
    .join('，');

  return {
    id: `${platform}:repo:${repo}:${stamp(first.ts)}`,
    platform,
    type,
    // 标题里的各项加起来要等于明细条数（下面「共 N 条」就是 total），
    // 不然同一张卡上两个数字对不上，看着像算错了。
    title: `${repo} · ${countsText(counts)}`,
    summary,
    url: first.repoUrl ?? last.url ?? null,
    image: null,
    // 按这一段的最后一次动作排序：仓库有动静就浮上来
    timestamp: stamp(last.ts),
    meta: {
      // collect 依据它做「覆盖 + 吸收被包住的旧卡」，而不是当作新条目追加
      merge: true,
      kind: 'repo-digest',
      repo,
      count: total,
      // 逐条明细（页面每页 10 条，靠页码切换）
      changes: rows,
      windowStart: stamp(first.ts),
      windowEnd: stamp(last.ts),
      actions: Object.fromEntries(counts),
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.platform
 * @param {Array<{repo: string, repoUrl?: string, kind: string, ts: number, text?: string, url?: string, component?: string}>} options.actions
 * @param {number} options.gapMs 两次动工之间的最小空档，超过就拆成两张卡
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

  const cards = [];
  for (const [repo, list] of byRepo) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    for (const session of splitByGap(sorted, gapMs)) {
      const card = buildSessionCard({ platform, repo, session, maxRows, type });
      if (card) cards.push(card);
    }
  }

  return cards.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}
