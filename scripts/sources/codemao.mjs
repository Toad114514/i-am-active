/**
 * 编程猫（Codemao）作品归档 —— 这个账号最早的一片互联网足迹（2021 年起）。
 *
 * 端点（社区公开接口，不需要登录态）：
 *   GET https://api.codemao.cn/creation-tools/v1/user/center/work-list
 *         ?user_id=<id>&limit=100&offset=0
 *   → { items: [{ id, work_name, preview, view_times, liked_times, collect_times,
 *                 fork_times, publish_time, description, type }], total, counted }
 *
 * 实测（2026-10）：
 *  - 列表按 publish_time 倒序，offset 翻页正常。total 恰好停在 100、offset=100
 *    直接返回空数组，所以这个接口最多只能给到最新 100 个作品；账号若真的发过
 *    更多，更早的那些在这儿拿不到（换个思路也没有第二个人口：作品页、个人页
 *    都是同一个列表）。抓到的总数会写进 diagnostics，超过 100 时能一眼看出来。
 *  - 只返回**已发布**的作品，草稿/未发布的不在里面——正是这份归档要的。
 *  - 封面 creation.codemao.cn 的链接是长期有效的（2021 年的图现在照样能取，
 *    没有签名参数、没有 TTL），所以不像 OTTOhub 那样必须本地镜像。
 *  - publish_time 是 unix 秒。改完作品重新发布会刷新它，因此拿它当 rev：
 *    同一个作品的 rev 变了就说明被更新过（collect 里原地刷新那条记录）。
 *
 * 抓取策略（只 init 一次，之后只盯最新）：
 *  - since 为空（首轮 / --no-state / 删掉 state.json 里的 lastRun）→ 全量 init，
 *    按 limit=100 翻页拿完（最多 maxPages 页）。
 *  - 否则只取第一页（limit=incrementalLimit）：新作品照常入库，最新几件作品的
 *    rev 变了就在原条目上刷新，不再回翻历史。
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const API = 'https://api.codemao.cn';
const codemao = platform('codemao');
const USER_ID = String(codemao.userId ?? '').trim();
/** 全量 init 时每页条数（接口上限 100）。 */
const PAGE_SIZE = Math.max(1, Math.min(100, Number(codemao.pageSize) || 100));
/** 全量 init 最多翻几页。 */
const MAX_PAGES = Math.max(1, Number(codemao.maxPages) || 3);
/** 增量轮只取第一页的条数：够看到「有没有新作品」和最新那件的更新。 */
const INCREMENTAL_LIMIT = Math.max(1, Math.min(100, Number(codemao.incrementalLimit) || 20));
/** 简介在摘要里只留这么长（时间线上是一行两行截断，太长没意义）。 */
const DESC_LIMIT = 90;

let lastDiagnostics = null;

/** 编程猫的时间是 unix 秒；解析失败返回 null（条目会被跳过）。 */
function parseTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** 简介压成一行（原文本里换行很多），超出截断。 */
function oneLine(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= DESC_LIMIT) return flat;
  return `${flat.slice(0, DESC_LIMIT)}…`;
}

function statsText(work) {
  const parts = [];
  if (work.view_times) parts.push(`${work.view_times} 次浏览`);
  if (work.liked_times) parts.push(`${work.liked_times} 赞`);
  if (work.fork_times) parts.push(`被改编 ${work.fork_times} 次`);
  return parts.join(' · ');
}

function toItem(work) {
  const timestamp = parseTime(work.publish_time);
  if (!timestamp || !work.id) return null;
  const desc = oneLine(work.description);
  const stats = statsText(work);
  return {
    id: `codemao:work:${work.id}`,
    platform: 'codemao',
    type: '作品',
    title: String(work.work_name ?? '').trim() || '未命名作品',
    summary: [desc, stats].filter(Boolean).join(' · '),
    url: `https://shequ.codemao.cn/work/${work.id}`,
    image: work.preview || null,
    timestamp,
    meta: {
      workId: work.id,
      // 重新发布会刷新 publish_time；collect 拿它判断「同一个作品被更新过」
      rev: Number(work.publish_time),
      views: work.view_times ?? null,
      likes: work.liked_times ?? null,
      favorites: work.collect_times ?? null,
      forks: work.fork_times ?? null,
      // type: 1 = Kitten4 源码编辑器，8 = Nemo（3D/图形化实验室）
      editor: Number(work.type) === 1 ? 'kitten4' : Number(work.type) === 8 ? 'nemo' : null,
    },
  };
}

async function fetchPage(limit, offset) {
  const url =
    `${API}/creation-tools/v1/user/center/work-list` +
    `?user_id=${encodeURIComponent(USER_ID)}&limit=${limit}&offset=${offset}`;
  return getJson(url, {
    headers: { Accept: 'application/json', Referer: 'https://shequ.codemao.cn/' },
    timeoutMs: 20000,
    retries: 2,
  });
}

/**
 * @param {{since?: Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchCodemao(context = {}) {
  if (!USER_ID) {
    console.warn('[codemao] 未配置 userId，跳过');
    return [];
  }
  // since 为空 = 首轮（或强制全量）：把全部作品拉一遍，之后只盯最新
  const init = !context.since;
  const limit = init ? PAGE_SIZE : INCREMENTAL_LIMIT;
  const maxPages = init ? MAX_PAGES : 1;
  const diag = { mode: init ? 'init' : 'incremental', works: 0, pages: 0, total: null };

  const works = [];
  for (let page = 0; page < maxPages; page += 1) {
    let json;
    try {
      json = await fetchPage(limit, page * limit);
    } catch (error) {
      // 一页失败就当整轮没取全：宁可这轮不更新，也不要拿半份数据覆盖归档
      console.warn(`[codemao] 第 ${page + 1} 页获取失败（本轮跳过）: ${error.message}`);
      diag.error = error.message;
      lastDiagnostics = diag;
      return [];
    }
    const batch = Array.isArray(json?.items) ? json.items : [];
    if (json?.total != null) diag.total = json.total;
    diag.pages = page + 1;
    works.push(...batch);
    if (batch.length < limit) break;
  }

  const items = [];
  const seen = new Set();
  for (const work of works) {
    if (seen.has(work.id)) continue;
    seen.add(work.id);
    const item = toItem(work);
    if (item) items.push(item);
  }
  diag.works = items.length;
  if (diag.total != null && diag.total >= 100 && init) diag.totalMayBeCapped = true;
  lastDiagnostics = diag;
  return items;
}

export function lastCodemaoDiagnostics() {
  return lastDiagnostics;
}
