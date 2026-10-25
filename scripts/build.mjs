/**
 * 静态站点生成器：读取 res/list.json → 输出 dist/。
 *
 * 产出：
 *   dist/index.html            主页（第 1 页）
 *   dist/page/N/index.html     主页分页
 *   dist/category/index.html   分类页（左栏分类 + 右栏结果）
 *   dist/search-index.json     前端搜索索引
 *   dist/assets/style.css
 *   dist/assets/site.js
 *   dist/404.html              GitHub Pages 404
 */
import { mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { readList, readStats, DIST_DIR, RES_DIR, ROOT } from './lib/store.mjs';
import { PLATFORMS, PLATFORM_ORDER, KINDS, getPlatform, kindOf } from './lib/platforms.mjs';
import { SITE, PAGE_SIZE, esc, formatTime, isoAttr, yearOf } from './lib/site.mjs';
import { config } from './lib/config.mjs';

const ASSETS_DIR = path.join(ROOT, 'scripts', 'assets');

/** 部署到 GitHub Pages 子路径时的 base：环境变量 > config.yaml > 默认值。 */
const BASE = process.env.SITE_BASE || config.site.base || '/i-am-active';

/** 汇总卡片里逐条译文每页显示条数（与 assets/site.js 保持一致）。 */
/** 汇总卡（Weblate 译文时段 / GitHub·Gitee 仓库卡）每页显示几条明细。 */
const TLIST_PAGE_SIZE = 5;

const ICON_ARROW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const ICON_TAG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h12"/></svg>';

/* ------------------------------------------------------------------ */
/* 页面片段                                                            */
/* ------------------------------------------------------------------ */

/** 顶栏（含右上角小导航）。 */
function renderTopbar({ current, base }) {
  const homeActive = current === 'home' ? ' navbtn--active' : '';
  const catActive = current === 'category' ? ' navbtn--active' : '';
  return `
  <header class="topbar">
    <div class="shell">
      <div class="topbar__head">
        <div class="brand">
          <h1 class="brand__title">${esc(SITE.title)}</h1>
          <p class="brand__subtitle">${esc(SITE.subtitle)}</p>
          <div class="brand__stats" data-site-stats></div>
        </div>
        <nav class="topnav" aria-label="站内导航">
          <div class="search">
            <span class="search__icon">${ICON_SEARCH}</span>
            <input
              class="search__input"
              type="search"
              placeholder="搜索活动…"
              aria-label="搜索活动"
              autocomplete="off"
              data-search-input
            />
            <button class="search__clear" type="button" aria-label="清空搜索" data-search-clear>✕</button>
            <div class="search__panel" data-search-panel data-open="0" role="listbox" aria-label="搜索结果"></div>
          </div>
          <a class="navbtn${homeActive}" href="${esc(base || './')}">${ICON_TAG}<span>活动</span></a>
          <a class="navbtn${catActive}" href="${esc(base ? `${base}category/` : 'category/')}">${ICON_TAG}<span>分类</span></a>
        </nav>
      </div>
    </div>
  </header>`;
}

/** 动作名 → 行内短标签。 */
const ACTION_SHORT = {
  新增译文: '新增',
  修改译文: '修改',
  添加建议: '建议',
  建议被采纳: '采纳',
  建议被拒绝: '驳回',
  标记待编辑: '待编辑',
  新增源串: '源串',
  修改源串: '源串改',
  翻译改动: '改动',
  // 仓库活动（GitHub / Gitee）：tag 位置窄，长标签会挤掉提交信息
  提交: '提交',
  新建仓库: '仓库',
  '新建 PR': 'PR',
  '新建 Issue': 'Issue',
  '合并 PR': '合并',
};

/** 明细行的短时间（固定 UTC+8，避免 CI 与本机时区不一致）。 */
function rowTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * 逐条明细；超出首页容量的部分先 hidden，由前端按页码翻放。
 *
 * 首页可见的判定按「条目」算，分段标头不占名额：标头跟着它所属的那一段，
 * 该段在本页有条目时标头一起显示（否则一张两段的卡每页只能放得下 3 条）。
 */
function renderTranslationRows(changes, fold = TLIST_PAGE_SIZE) {
  const visible = new Set();
  let entries = 0;
  let group = null;
  changes.forEach((change, index) => {
    if (change.group) {
      group = index;
      return;
    }
    if (entries < fold) {
      visible.add(index);
      if (group !== null) visible.add(group);
      entries += 1;
    }
  });

  return changes
    .map((change, index) => {
      // 分段标头（仓库活动按连续工作时段分段）：不是链接，也不计入「共 N 条」
      if (change.group) {
        return `
            <li class="tlist__group" data-tlist-group${visible.has(index) ? '' : ' hidden'}>
              <span>${esc(change.group)}</span>
            </li>`;
      }
      const label = ACTION_SHORT[change.action] ?? change.action ?? '';
      const text = String(change.text ?? '').trim() || '（空文字）';
      return `
            <li class="tlist__row"${visible.has(index) ? '' : ' hidden'}>
              <a class="tlist__link" href="${esc(change.url || '#')}" target="_blank" rel="noopener noreferrer">
                <span class="tlist__text">${esc(text)}</span>
                ${label ? `<span class="tlist__tag">${esc(label)}</span>` : ''}
                ${change.component ? `<span class="tlist__comp">${esc(change.component)}</span>` : ''}
                <time class="tlist__time"${isoAttr(change.time) ? ` datetime="${esc(isoAttr(change.time))}"` : ''}>${esc(rowTime(change.time))}</time>
              </a>
            </li>`;
    })
    .join('');
}

/** 汇总型条目（带逐条明细）：整张卡不能是链接，否则明细里的链接会嵌套。 */
function renderDigestItem(item) {
  const platform = getPlatform(item.platform);
  const changes = item.meta.changes;
  // 分段标头不算「条」
  const total = changes.filter((change) => !change.group).length;
  const fold = TLIST_PAGE_SIZE;
  const shown = Math.min(fold, total);
  const fullTime = item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';

  return `
      <li>
        <div class="item item--digest" style="--pc:${esc(platform.color)}">
          <div class="item__body">
            <div class="item__meta">
              <span class="item__icon">${platform.icon}</span>
              <span class="item__platform">${esc(platform.name)}</span>
              <span class="item__sep">·</span>
              <span class="item__type">${esc(item.type || '活动')}</span>
              <span class="item__sep">·</span>
              <span class="item__time" title="${esc(fullTime)}"${isoAttr(item.timestamp) ? ` datetime="${isoAttr(item.timestamp)}"` : ''}>${esc(formatTime(item.timestamp))}</span>
            </div>
            <h3 class="item__title"><a class="item__titlelink" href="${esc(item.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a></h3>
            <ul class="tlist" data-tlist data-tlist-page-size="${fold}" data-tlist-current="1">
${renderTranslationRows(changes, fold)}
            </ul>
            <div class="tlist__foot">
              <span class="tlist__progress" data-tlist-progress>第 1-${shown} 条 / 共 ${total} 条</span>
              <nav class="pager pager--inner" data-tlist-pager aria-label="明细分页" hidden></nav>
            </div>
          </div>
        </div>
      </li>`;
}

/** 单条活动条目。 */
function renderItem(item) {
  if (Array.isArray(item.meta?.changes) && item.meta.changes.length > 0) {
    return renderDigestItem(item);
  }
  const platform = getPlatform(item.platform);

  /*
   * 两种「有图」的排版：
   *  - 游戏条目（RA / Steam）：meta.backdrop 是游戏截图或封面，铺在左边当背景；
   *    成就图标缩成右下角的小角标（item--badge），不再被拉成糊掉的巨图。
   *  - 其它平台：没有 backdrop，item.image 继续当背景用（老样子）。
   * 背景图加载失败时把 item--media / item--badge 一起去掉，退回纯文字卡片，
   * 不会留下 46% 的一整块空白。
   */
  const backdrop = item.meta?.backdrop ?? null;
  const badge = item.meta?.badge ?? null;
  const mediaSrc = backdrop ?? item.image;
  const hasMedia = Boolean(mediaSrc);
  const showBadge = Boolean(backdrop) && Boolean(badge);
  const time = formatTime(item.timestamp);
  const fullTime = item.timestamp
    ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false })
    : '';
  return `
      <li>
        <a class="item${hasMedia ? ' item--media' : ''}${backdrop ? ' item--game' : ''}${showBadge ? ' item--badge' : ''}" href="${esc(item.url || '#')}"
           style="--pc:${esc(platform.color)}"${item.url ? ' target="_blank" rel="noopener noreferrer"' : ''}>
          ${
            hasMedia
              ? `<span class="item__media"><img src="${esc(mediaSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="var a=this.closest('.item');this.parentNode.remove();a&&a.classList.remove('item--media','item--game','item--badge')"></span>`
              : ''
          }
          ${
            showBadge
              ? `<img class="item__badge" src="${esc(badge)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
              : ''
          }
          <div class="item__body">
            <div class="item__meta">
              <span class="item__icon">${platform.icon}</span>
              <span class="item__platform">${esc(platform.name)}</span>
              <span class="item__sep">·</span>
              <span class="item__type">${esc(item.type || '活动')}</span>
              <span class="item__sep">·</span>
              <span class="item__time" title="${esc(fullTime)}"${isoAttr(item.timestamp) ? ` datetime="${isoAttr(item.timestamp)}"` : ''}>${esc(time)}</span>
            </div>
            <h3 class="item__title">${esc(item.title)}</h3>
            <p class="item__summary">${esc(item.summary)}</p>
            <div class="item__foot">
              <span class="item__jump">跳转到 ${esc(platform.short)}${ICON_ARROW}</span>
            </div>
          </div>
        </a>
      </li>`;
}

/** 分页导航（靠右）。 */
function renderPager(page, totalPages, basePath, infoText) {
  if (totalPages <= 1 && !infoText) return '';

  const parts = [];
  if (infoText) parts.push(`<span class="pager__info">${esc(infoText)}</span>`);

  const pageUrl = (n) => (n === 1 ? basePath : `${basePath}page/${n}/`);

  if (page > 1) {
    parts.push(`<a class="pager__link" href="${esc(pageUrl(page - 1))}" rel="prev">‹</a>`);
  }

  // 页码窗口：当前页前后各 2 页
  const window = [];
  for (let n = 1; n <= totalPages; n += 1) {
    const near = Math.abs(n - page) <= 2;
    const edge = n === 1 || n === totalPages;
    if (near || edge) window.push(n);
  }
  let previous = 0;
  for (const n of window) {
    if (previous && n - previous > 1) {
      parts.push('<span class="pager__gap">…</span>');
    }
    parts.push(
      n === page
        ? `<span class="pager__link" aria-current="page">${n}</span>`
        : `<a class="pager__link" href="${esc(pageUrl(n))}">${n}</a>`,
    );
    previous = n;
  }

  if (page < totalPages) {
    parts.push(`<a class="pager__link" href="${esc(pageUrl(page + 1))}" rel="next">›</a>`);
  }

  return `<nav class="pager" aria-label="分页">${parts.join('')}</nav>`;
}

/** 页脚。 */
function renderFooter({ base, stats, totalItems }) {
  const monitoringSince = stats?.monitoringSince
    ? new Date(stats.monitoringSince)
    : null;
  const watchedText = monitoringSince
    ? formatDuration(Date.now() - monitoringSince.getTime())
    : '刚刚开始';

  return `
  <footer class="footer">
    <div class="shell">
      <div class="footer__grid">
        <div>
          <div class="footer__block-label">访问量</div>
          <div class="footer__value">已被 <span data-views>—</span> 人看过</div>
        </div>
        <div>
          <div class="footer__block-label">监视时长</div>
          <div class="footer__value">已监视 ${esc(watchedText)}</div>
        </div>
        <div>
          <div class="footer__block-label">GitHub</div>
          <div class="footer__value"><a href="${esc(SITE.repoUrl)}" target="_blank" rel="noopener noreferrer">${esc(SITE.owner)} / i-am-active</a></div>
        </div>
        <div>
          <div class="footer__block-label">当前时间</div>
          <div class="footer__value" data-clock>—</div>
        </div>
      </div>
      <p class="footer__note">
        本页由 GitHub Actions 每 2 小时自动巡检各平台并重新生成，共收录
        <b>${totalItems}</b> 条活动记录。数据来源见
        <a href="${esc(SITE.repoUrl)}" target="_blank" rel="noopener noreferrer">仓库</a>。
      </p>
    </div>
  </footer>`;
}

/** 时长友好格式。 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0 分钟';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const parts = [];
  if (years) parts.push(`${years} 年`);
  if (months) parts.push(`${months} 个月`);
  if (days % 30 && !years) parts.push(`${days % 30} 天`);
  if (!parts.length) parts.push(`${Math.max(hours, 1)} 小时`);
  return parts.join(' ');
}

/** 完整 HTML 页面。 */
function renderPage({
  title,
  description,
  base,
  current,
  body,
  assetsPrefix,
  searchSrc,
  bodyAttrs = '',
  headExtra = '',
}) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="dark light">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(SITE.repoUrl)}">
<link rel="canonical" href="${esc(SITE.repoUrl)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A6%86%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="${esc(assetsPrefix)}assets/style.css">
${headExtra}
</head>
<body${bodyAttrs}>
${renderTopbar({ current, base })}
<main class="main">
  <div class="shell">
${body}
  </div>
</main>
${renderFooter({
  base,
  stats: current === 'home' ? currentStats : currentStats,
  totalItems: currentStats.totalItems,
})}
<script src="${esc(assetsPrefix)}assets/site.js" defer></script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* 数据准备                                                            */
/* ------------------------------------------------------------------ */

let currentStats = { totalItems: 0, monitoringSince: null };

/**
 * 图片地址归一化。
 *
 * 抓取器可以只写站点相对路径（`media/ottohub/123.jpg`）——那些图是抓取时
 * 就地下载到 res/media/ 的（原站链接带签名、几小时就失效）。这里补上 BASE
 * 前缀，页面上就变成站内绝对路径 `/i-am-active/media/...`，无论主页、
 * `/page/3/`、`/category/` 都能正确取到。
 */
function resolveMedia(src) {
  if (!src) return null;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return src;
  if (src.startsWith('/')) return src;
  return `${BASE === '/' ? '/' : `${BASE}/`}${src.replace(/^\/+/, '')}`;
}

/** 为主页与分类页准备统一的条目视图。 */
function toView(item) {
  const platform = getPlatform(item.platform);
  return {
    ...item,
    platformName: platform.name,
    platformShort: platform.short,
    color: platform.color,
    icon: platform.icon,
    year: yearOf(item.timestamp),
    kind: kindOf(item.platform),
    timeText: formatTime(item.timestamp),
  };
}

/* ------------------------------------------------------------------ */
/* 主页                                                                */
/* ------------------------------------------------------------------ */

async function buildHome(list, stats, assetsPrefix) {
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);
    const isFirst = page === 1;
    // 站内链接一律用「站点根绝对路径」。之前用 `${assetsPrefix}../` 做相对回退，
    // 浏览器会把 `/i-am-active/../page/3/` 归一化成 `/page/3/`（跳出子路径）→ 404。
    const homeBase = assetsPrefix;

    const body = `
    <div class="section-head">
      <h2>最新活动</h2>
      <span class="section-head__meta">第 ${page} / ${totalPages} 页 · 共 ${list.length} 条</span>
    </div>
    <ul class="list">
${slice.map(renderItem).join('\n')}
    </ul>
    ${renderPager(page, totalPages, homeBase, `第 ${start + 1}-${Math.min(start + PAGE_SIZE, list.length)} 条`)}
`;

    const html = renderPage({
      title: isFirst ? SITE.title : `${SITE.title} · 第 ${page} 页`,
      description: SITE.description,
      base: homeBase,
      current: 'home',
      body,
      assetsPrefix,
      searchSrc: `${homeBase}search-index.json`,
      bodyAttrs: ` data-search-src="${esc(homeBase)}search-index.json"`,
    });

    const outDir = isFirst ? DIST_DIR : path.join(DIST_DIR, 'page', String(page));
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'index.html'), html, 'utf8');
  }

  return totalPages;
}

/* ------------------------------------------------------------------ */
/* 分类页                                                              */
/* ------------------------------------------------------------------ */

async function buildCategory(list, assetsPrefix) {
  // 统计年份、平台与活动类型
  const yearCounts = new Map();
  const platformCounts = new Map();
  const kindCounts = new Map();
  for (const item of list) {
    const y = yearOf(item.timestamp);
    if (y) yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
    platformCounts.set(item.platform, (platformCounts.get(item.platform) ?? 0) + 1);
    const k = kindOf(item.platform);
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
  }
  const years = [...yearCounts.keys()].sort((a, b) => b - a);

  const sortedPlatforms = PLATFORM_ORDER.filter((id) => platformCounts.has(id)).concat(
    [...platformCounts.keys()].filter((id) => !PLATFORM_ORDER.includes(id)),
  );

  const yearLinks = [
    `<li><a class="cats__link" href="?" aria-current="true" data-cats-year-link data-year="all">
       <span class="cats__dot" style="--pc:var(--accent)"></span>全部年份<span class="cats__count">${list.length}</span>
     </a></li>`,
    ...years.map(
      (y) => `<li><a class="cats__link" href="?year=${y}" data-cats-year-link data-year="${y}">
       <span class="cats__dot" style="--pc:var(--accent)"></span>${y}<span class="cats__count">${yearCounts.get(y)}</span>
     </a></li>`,
    ),
  ];

  const platformLinks = [
    `<li><a class="cats__link" href="?" aria-current="true" data-cats-platform-link data-platform="all">
       <span class="cats__dot" style="--pc:var(--accent)"></span>全部平台<span class="cats__count">${list.length}</span>
     </a></li>`,
    ...sortedPlatforms.map((id) => {
      const p = getPlatform(id);
      return `<li><a class="cats__link" href="?platform=${id}" data-cats-platform-link data-platform="${id}">
       <span class="cats__dot" style="--pc:${esc(p.color)}"></span>${esc(p.name)}<span class="cats__count">${platformCounts.get(id)}</span>
     </a></li>`;
    }),
  ];

  // 活动类型：游戏 / 视频 / 代码 / 归档 / 其他（空类型不显示）
  const kindLinks = [
    `<li><a class="cats__link" href="?" aria-current="true" data-cats-kind-link data-kind="all">
       <span class="cats__dot" style="--pc:var(--accent)"></span>全部类型<span class="cats__count">${list.length}</span>
     </a></li>`,
    ...KINDS.filter((kind) => kindCounts.has(kind.id)).map(
      (kind) => `<li><a class="cats__link" href="?kind=${kind.id}" data-cats-kind-link data-kind="${kind.id}" title="${esc(kind.hint ?? '')}">
       <span class="cats__dot" style="--pc:${esc(kind.color)}"></span>${esc(kind.name)}<span class="cats__count">${kindCounts.get(kind.id)}</span>
     </a></li>`,
    ),
  ];

  const body = `
    <div class="section-head">
      <h2>按平台 / 年份 / 类型分类</h2>
      <span class="section-head__meta" data-cats-count>${list.length} 条结果</span>
    </div>
    <div class="cats" data-cats data-cats-src="${esc(assetsPrefix)}items.json">
      <aside class="cats__side">
        <div class="cats__group">
          <p class="cats__label">年份</p>
          <ul class="cats__list">${yearLinks.join('')}</ul>
        </div>
        <div class="cats__group">
          <p class="cats__label">活动类型</p>
          <ul class="cats__list">${kindLinks.join('')}</ul>
        </div>
        <div class="cats__group">
          <p class="cats__label">社交平台</p>
          <ul class="cats__list">${platformLinks.join('')}</ul>
        </div>
      </aside>
      <section class="cats__main">
        <ul class="list" data-cats-list>
${list.slice(0, PAGE_SIZE).map(renderItem).join('\n')}
        </ul>
        <div class="empty" data-cats-empty hidden>
          <strong>没有符合条件的活动</strong>
          换一个年份、类型或平台试试。
        </div>
      </section>
    </div>
`;

  const html = renderPage({
    title: `分类 · ${SITE.title}`,
    description: `按年份、活动类型与社交平台浏览 ${SITE.owner} 的活动记录。`,
    base: assetsPrefix,
    current: 'category',
    body,
    assetsPrefix,
    searchSrc: `${assetsPrefix}search-index.json`,
    bodyAttrs: ` data-search-src="${esc(assetsPrefix)}search-index.json"`,
  });

  const outDir = path.join(DIST_DIR, 'category');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), html, 'utf8');
}

/* ------------------------------------------------------------------ */
/* 站内链接自检                                                        */
/* ------------------------------------------------------------------ */

/**
 * 递归复制目录（手写而非 fs.cp：沙箱里 copyfile 会被拦，readFile/writeFile 不会）。
 */
async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await writeFile(to, await readFile(from));
  }
}

/** 递归列出目录下所有 .html。 */
async function listHtml(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listHtml(full)));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** 把站内 URL 映射成 dist 里的实际文件，找不到返回 null。 */
function resolveInternal(url) {
  const clean = url.split('#')[0].split('?')[0];
  if (!clean.startsWith('/') || !clean.startsWith(BASE)) return undefined; // 外链 / 非本站
  const target = path.join(DIST_DIR, clean.slice(BASE.length));
  if (existsSync(target)) {
    return statSync(target).isDirectory() ? existsSync(path.join(target, 'index.html')) : true;
  }
  return false;
}

/**
 * 校验所有页面里的站内链接都能落地。
 * 主要防住「用 ../ 拼相对路径导致跳出 BASE 子路径」这类 404。
 */
async function verifyLinks() {
  const pages = await listHtml(DIST_DIR);
  const broken = [];
  for (const file of pages) {
    const html = await readFile(file, 'utf8');
    const attrs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    for (const attr of attrs) {
      const ok = resolveInternal(attr);
      if (ok === false) {
        broken.push(`${path.relative(DIST_DIR, file)} → ${attr}`);
      }
      // 兜底：站内绝对路径里绝不该出现 `..`
      if (ok !== undefined && attr.includes('/../')) {
        broken.push(`${path.relative(DIST_DIR, file)} → 含 ../ 的绝对链接 ${attr}`);
      }
    }
  }
  if (broken.length) {
    console.error(`[build] 站内链接自检失败，共 ${broken.length} 条：`);
    for (const line of [...new Set(broken)].slice(0, 20)) console.error('  ' + line);
    throw new Error('站点存在坏链接，已中止');
  }
  console.log(`[build] 链接自检通过：${pages.length} 个页面`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const list = await readList();
  const stats = await readStats();

  // 按时间倒序（无时间的排后面）；同时把「站点相对路径」的图片补成站内绝对路径
  const sorted = [...list]
    .sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
      const tb = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
      return tb - ta;
    })
    .map((item) => ({ ...item, image: resolveMedia(item.image) }));

  currentStats = {
    totalItems: sorted.length,
    monitoringSince: stats?.monitoringSince ?? null,
  };

  // 清理上次产物
  if (existsSync(DIST_DIR)) await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const assetsPrefix = BASE === '/' ? '/' : `${BASE}/`;

  // 静态资源
  await mkdir(path.join(DIST_DIR, 'assets'), { recursive: true });
  for (const asset of ['style.css', 'site.js']) {
    const content = await readFile(path.join(ASSETS_DIR, asset), 'utf8');
    await writeFile(path.join(DIST_DIR, 'assets', asset), content, 'utf8');
  }

  // 自己托管的图片（res/media → dist/media）：原站链接带签名会过期，见 store.mjs
  const mediaDir = path.join(RES_DIR, 'media');
  if (existsSync(mediaDir)) {
    await copyDir(mediaDir, path.join(DIST_DIR, 'media'));
  }

  // 搜索索引 / 分类数据
  const views = sorted.map(toView);
  await writeFile(
    path.join(DIST_DIR, 'search-index.json'),
    JSON.stringify(
      views.map((v) => ({
        title: v.title,
        summary: v.summary,
        platform: v.platform,
        platformName: v.platformName,
        type: v.type,
        url: v.url,
        timeText: v.timeText,
        year: v.year,
        image: v.image,
        color: v.color,
        icon: v.icon,
      })),
      null,
      1,
    ),
    'utf8',
  );
  await writeFile(path.join(DIST_DIR, 'items.json'), JSON.stringify(views), 'utf8');

  const totalPages = await buildHome(sorted, stats, assetsPrefix);
  await buildCategory(sorted, assetsPrefix);

  // 404 页
  await writeFile(
    path.join(DIST_DIR, '404.html'),
    `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 · ${esc(SITE.title)}</title>
<link rel="stylesheet" href="${esc(assetsPrefix)}assets/style.css">
</head><body>
<div class="shell" style="padding-top:14vh">
  <div class="empty">
    <strong>404 · 这里什么都没有</strong>
    页面不存在，或者已经被新的活动挤走了。<br>
    <a href="${esc(assetsPrefix)}" style="color:var(--accent)">回到首页</a>
  </div>
</div>
</body></html>
`,
    'utf8',
  );

  // nojekyll，防止 GitHub Pages 吞掉下划线目录
  await writeFile(path.join(DIST_DIR, '.nojekyll'), '', 'utf8');

  await verifyLinks();

  console.log(`[build] 生成完成：${sorted.length} 条记录 / ${totalPages} 页 / base=${assetsPrefix}`);
}

main().catch((error) => {
  console.error('[build] 失败:', error);
  process.exit(1);
});
