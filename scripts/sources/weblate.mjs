/**
 * Weblate（TDE 简体中文翻译）近期改动 → 按「翻译时段」汇总成一条活动。
 *
 * 为什么不逐条列：一次翻译往往在十几分钟内产生几十条 change（每改一个字符串就是一条），
 * 逐条写入会瞬间刷屏。这里把「相邻间隔小于 SESSION_GAP_MS 的连续改动」聚成一个时段，
 * 一个时段只产出一条活动，标题/摘要里给出总条数、动作分布、涉及组件与最近一条译文。
 *
 * 关键点（实测）：
 *  - 过滤参数是 `user=`，不是 `author=`（`author` 会被静默忽略，返回全量）。
 *  - 全局端点上 `project=` 参数无效，必须用 /api/projects/<slug>/changes/ 才按项目过滤。
 *  - 结果按 timestamp 升序返回，最新在最后一页，所以要先取 count 再算末页。
 *  - `limit` 硬上限 50。
 *  - 匿名 API 限流 100 次/24h；RSS 导出 /exports/rss/ 不受限流，
 *    因此主路径走 API（通常 2 次请求），限流时降级到 RSS。
 *  - 实例有 Anubis 反爬：浏览器 UA 会触发挑战页，curl/node 默认 UA 才放行。
 */
import { getJson, getText } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const weblate = platform('weblate');
const BASE = String(weblate.baseUrl).replace(/\/+$/, '');
const USERNAME = String(weblate.user);

/** 匿名请求时用非浏览器 UA，避免触发 Anubis 挑战。 */
const API_HEADERS = { 'User-Agent': 'curl/8.22.0' };

const PAGE_SIZE = Math.max(1, Math.min(50, Number(weblate.pageSize) || 50));
/** 最多回翻页数，防止一次翻译量特别大时把限流配额吃光。 */
const MAX_PAGES = Math.max(1, Number(weblate.maxPages) || 4);
/** 相邻两条改动间隔超过这个值，就算进入了另一个「翻译时段」。 */
const SESSION_GAP_MS = Math.max(1, Number(weblate.sessionGapMinutes) || 120) * 60 * 1000;
/** 只看最近这么多天的改动；更早的时段早已入库，不必每轮重算。 */
const LOOKBACK_MS = Math.max(1, Number(weblate.lookbackDays) || 7) * 24 * 60 * 60 * 1000;
/** 单个时段最多保留多少条明细。 */
const MAX_ROWS = Math.max(1, Number(weblate.maxRows) || 400);

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1].trim()) : null;
}

/** 从 API 链接里取 slug。 */
function slugFromUrl(url, marker) {
  if (!url) return null;
  const index = url.indexOf(marker);
  if (index < 0) return null;
  return url.slice(index + marker.length).replace(/\/$/, '');
}

/** 语言代码 → 中文名。 */
const LANGUAGE_NAMES = {
  zh_Hans: '简体中文',
  zh_Hant: '繁體中文',
  en: '英语',
  ja: '日语',
  de: '德语',
  fr: '法语',
  ru: '俄语',
};

const ACTION_NAMES = {
  'New translation': '新增译文',
  'Translation changed': '修改译文',
  'Suggestion added': '添加建议',
  'Suggestion accepted': '建议被采纳',
  'Suggestion rejected': '建议被拒绝',
  Comment: '评论',
  'Comment added': '添加评论',
  'Component name changed': '组件改名',
  'Source string added': '新增源串',
  'Source string changed': '修改源串',
  'Resource update': '资源更新',
  'New strings to translate': '新增待译文本',
  'Added new language': '新增语言',
  'Committed changes': '提交变更',
  'New contributor': '新贡献者',
  'Marked for edit': '标记待编辑',
};

/** 真正产出译文的动作；数量统计与摘要只取这些，避免「新贡献者」之类的噪声。 */
const TRANSLATION_ACTIONS = new Set([
  '新增译文',
  '修改译文',
  '添加建议',
  '建议被采纳',
  '建议被拒绝',
  '新增源串',
  '修改源串',
  '标记待编辑',
]);

/** 归一化一条 change（保留后续汇总要用的字段）。 */
function normalizeChange(change) {
  const componentPath = slugFromUrl(change.component, '/components/');
  const translationPath = slugFromUrl(change.translation, '/translations/');
  const language = translationPath?.split('/').pop() ?? null;

  return {
    id: String(change.id),
    ts: change.timestamp ? Date.parse(change.timestamp) : NaN,
    time: change.timestamp ?? null,
    actionName: ACTION_NAMES[change.action_name] ?? change.action_name ?? '翻译改动',
    componentPath,
    language,
    languageName: LANGUAGE_NAMES[language] ?? language ?? '未知语言',
    target: (change.target ?? '').trim(),
    url: change.translation
      ? change.translation.replace('/api/translations/', '/translate/')
      : `${BASE}/user/${USERNAME}/`,
  };
}

/** 译文里可能带富文本标签（例如 KBFX 的 <p align=center>），展示前转成纯文本。 */
function plainText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 单条译文的深链。
 *
 * Weblate 的 change 接口只给到「组件+语言」的 translation 页面，没有 unit 的 checksum；
 * 而逐条去查 /api/units/<id>/ 拿 web_url 会把匿名配额（100 次/24h）吃光。
 * 实测 /translate/<项目>/<组件>/<语言>/?q=<关键词> 会按关键词筛选，于是用译文正文做查询，
 * 点进去就落在对应字符串上（短串用引号做短语匹配，长串用前缀分词匹配）。
 */
function deepLink(baseUrl, text) {
  const fallback = baseUrl || `${BASE}/user/${USERNAME}/`;
  const clean = String(text ?? '')
    .replace(/["\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || !baseUrl) return fallback;
  const query = clean.length <= 60 ? `"${clean}"` : clean.slice(0, 60);
  return `${baseUrl}?q=${encodeURIComponent(query)}`;
}

/** 已抓到的这批改动里，最新时段是否已经完整（出现了 > SESSION_GAP 的空档）。 */
function newestSessionComplete(changes) {
  const times = changes.map((c) => c.ts).filter(Number.isFinite).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] - times[i - 1] > SESSION_GAP_MS) return true;
  }
  return false;
}

/** 从末页往前翻，直到拿到完整的最新时段（通常 1 页）。 */
async function fetchRecentChanges() {
  const first = await getJson(`${BASE}/api/changes/?user=${USERNAME}&limit=1`, {
    headers: API_HEADERS,
    timeoutMs: 20000,
    retries: 1,
  });
  const total = first?.count ?? 0;
  if (!total) return [];

  let page = Math.ceil(total / PAGE_SIZE);
  const seen = new Map();
  let pages = 0;

  while (page >= 1 && pages < MAX_PAGES) {
    const data = await getJson(
      `${BASE}/api/changes/?user=${USERNAME}&limit=${PAGE_SIZE}&page=${page}`,
      { headers: API_HEADERS, timeoutMs: 20000, retries: 1 },
    );
    const results = data?.results ?? [];
    if (!results.length) break;
    for (const change of results) {
      const normalized = normalizeChange(change);
      seen.set(normalized.id, normalized);
    }
    pages += 1;
    if (newestSessionComplete([...seen.values()])) break;
    page -= 1;
  }

  return [...seen.values()].sort((a, b) => a.ts - b.ts);
}

/** 按时间空档切成若干「翻译时段」。（导出便于自测） */
export function splitSessions(changes) {
  const sessions = [];
  let current = [];
  for (const change of changes) {
    const prev = current[current.length - 1];
    if (prev && Number.isFinite(change.ts) && Number.isFinite(prev.ts) && change.ts - prev.ts > SESSION_GAP_MS) {
      sessions.push(current);
      current = [];
    }
    current.push(change);
  }
  if (current.length) sessions.push(current);
  return sessions;
}

/** 把一条 session 汇总成一条活动。 */
function buildDigest(session) {
  const valid = session.filter((c) => Number.isFinite(c.ts));
  if (!valid.length) return null;

  const start = valid[0];
  const end = valid[valid.length - 1];
  const actions = new Map();
  const components = new Map();
  const languages = new Map();
  let latest = start;

  for (const change of valid) {
    actions.set(change.actionName, (actions.get(change.actionName) ?? 0) + 1);
    if (change.componentPath) {
      components.set(change.componentPath, (components.get(change.componentPath) ?? 0) + 1);
    }
    languages.set(change.languageName, (languages.get(change.languageName) ?? 0) + 1);
    if (change.ts >= latest.ts) latest = change;
  }

  const total = valid.length;
  const translationTotal = [...actions.entries()]
    .filter(([name]) => TRANSLATION_ACTIONS.has(name))
    .reduce((sum, [, n]) => sum + n, 0);

  const actionSummary = [...actions.entries()]
    .filter(([name]) => TRANSLATION_ACTIONS.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, n]) => `${name} ${n} 条`)
    .join('、');

  const componentList = [...components.keys()];
  const componentPreview = componentList.slice(0, 2).join('、');
  const componentText = componentList.length
    ? `涉及 ${componentList.length} 个组件（${componentPreview}${componentList.length > 2 ? ' 等' : ''}）`
    : '';

  const languageText = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '简体中文';
  const latestRaw = [...valid].reverse().find((c) => plainText(c.target))?.target ?? '';
  const latestTarget = plainText(latestRaw);

  // 逐条译文（最新在前），供页面展开查看；上限防止极端时段把 list.json 撑爆
  const rows = [...valid]
    .reverse()
    .filter((c) => TRANSLATION_ACTIONS.has(c.actionName) || c.target)
    .map((c) => {
      const text = plainText(c.target).slice(0, 160);
      return {
        text: text || c.actionName,
        action: c.actionName,
        component: c.componentPath,
        // 每条都指向对应的那条译文
        url: deepLink(c.url, text),
        time: c.time,
      };
    })
    .slice(0, MAX_ROWS);

  const summaryParts = [
    actionSummary || `${total} 条改动`,
    componentText,
    latestTarget ? `最近一条「${latestTarget.slice(0, 40)}」` : '',
  ].filter(Boolean);

  return {
    id: `weblate:session:${start.time?.replace(/\.\d+Z$/, 'Z') ?? start.ts}`,
    platform: 'weblate',
    type: '译文提交',
    title: `TDE ${languageText} · ${translationTotal || total} 条译文改动`,
    summary: summaryParts.join('，'),
    url: deepLink(latest.url, latestTarget),
    image: null,
    // 用时段结束时间排序：同一批译文继续追加时，条目会自然保持在最新位置
    timestamp: end.time,
    meta: {
      // collect 依据它做「覆盖 + 吸收窗口内旧记录」，而不是当作新条目追加
      merge: true,
      count: total,
      translationCount: translationTotal,
      // 逐条译文：页面每页显示 10 条，靠页码切换
      changes: rows,
      windowStart: start.time,
      windowEnd: end.time,
      components: componentList,
      actions: Object.fromEntries(actions),
      language: languages.keys().next().value ?? null,
      languageName: languageText,
      latestTarget: latestTarget || null,
      source: 'api',
    },
  };
}

/** 把改动集合汇总为活动列表（最新在前）。（导出便于自测） */
export function toDigests(changes) {
  const cutoff = Date.now() - LOOKBACK_MS;
  const sessions = splitSessions(changes).filter((s) => {
    const last = s[s.length - 1];
    return Number.isFinite(last.ts) && last.ts >= cutoff;
  });

  const digests = [];
  for (const session of sessions) {
    const digest = buildDigest(session);
    if (digest) digests.push(digest);
  }
  return digests.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

/** 走 API 取改动并汇总。 */
async function fetchViaApi() {
  return toDigests(await fetchRecentChanges());
}

/** 降级路径：RSS 导出（不限流，固定 10 条）。 */
async function fetchViaRss() {
  const xml = await getText(`${BASE}/exports/rss/`, {
    headers: API_HEADERS,
    timeoutMs: 20000,
    retries: 1,
  });
  const changes = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1];
    const description = tagText(block, 'description') ?? '';
    const author = description.match(/\/weblate\/user\/([^/]+)\//)?.[1] ?? null;
    if (author && author.toLowerCase() !== USERNAME.toLowerCase()) continue;
    const on = description.match(/ on (.+?) — (.+?) by /);
    const pubDate = tagText(block, 'pubDate');
    const link = tagText(block, 'link');
    const ts = pubDate ? Date.parse(pubDate) : NaN;

    changes.push({
      id: String(link ?? pubDate),
      ts,
      time: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      actionName: '翻译改动',
      componentPath: on?.[1]?.trim() ?? null,
      language: null,
      languageName: on?.[2]?.trim() ?? '未知语言',
      target: '',
      url: link ?? `${BASE}/user/${USERNAME}/`,
    });
  }
  changes.sort((a, b) => a.ts - b.ts);
  const digests = toDigests(changes);
  for (const digest of digests) digest.meta.source = 'rss';
  return digests;
}

/**
 * 注意：这里**不按 since 过滤**。汇总条目每次都要用完整时段重算，
 * 只取增量会让「条数」变成增量值，汇总就失真了；覆盖逻辑交给 collect 的 merge。
 *
 * @returns {Promise<Array<object>>}
 */
export async function fetchWeblate() {
  try {
    return await fetchViaApi();
  } catch (error) {
    console.warn(`[weblate] API 失败（${error.message}），降级到 RSS`);
    try {
      return await fetchViaRss();
    } catch (rssError) {
      console.warn(`[weblate] RSS 也失败: ${rssError.message}`);
      return [];
    }
  }
}
