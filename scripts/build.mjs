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

import { readList, readStats, readMirrors, DIST_DIR, RES_DIR, ROOT } from './lib/store.mjs';
import { PLATFORMS, PLATFORM_ORDER, KINDS, getPlatform, kindOf } from './lib/platforms.mjs';
import { SITE, PAGE_SIZE, esc, formatTime, isoAttr, yearOf } from './lib/site.mjs';
import { config } from './lib/config.mjs';

const ASSETS_DIR = path.join(ROOT, 'scripts', 'assets');

/** 部署到 GitHub Pages 子路径时的 base：环境变量 > config.yaml > 默认值。 */
const BASE = process.env.SITE_BASE || config.site.base || '/i-am-active';

/** 汇总卡片里逐条译文每页显示条数（与 assets/site.js 保持一致）。 */
/** 汇总卡（Weblate 译文时段 / GitHub·Gitee 仓库卡）每页显示几条明细。 */
const TLIST_PAGE_SIZE = 5;

/**
 * GitHub 仓库全名 → Gitee 镜像信息（res/mirrors.json）。
 *
 * 镜像仓库的提交只在 GitHub 那边出卡（见 scripts/lib/mirrors.mjs），但「这个仓库
 * 在 Gitee 也有」本身是条信息：不标出来的话 Gitee 那边就只剩几张卡，看着像少了。
 * main() 里加载后填进来，渲染时给对应的 GitHub 卡挂一个「Gitee 镜像」标记。
 */
let MIRROR_BY_GITHUB = new Map();

const ICON_ARROW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const ICON_TAG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h12"/></svg>';

const ICON_CLOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>';

/* 主题按钮两个图标叠在一起，CSS 按 data-theme 只显示一个 */
const ICON_SUN =
  '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>';

const ICON_MOON =
  '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5Z"/></svg>';

const ICON_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

/* ------------------------------------------------------------------ */
/* 页面片段                                                            */
/* ------------------------------------------------------------------ */

/** 顶栏（含右上角小导航）。 */
function renderTopbar({ current, base }) {
  const homeActive = current === 'home' ? ' navbtn--active' : '';
  const catActive = current === 'category' ? ' navbtn--active' : '';
  const tlActive = current === 'timeline' ? ' navbtn--active' : '';
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
          <a class="navbtn${tlActive}" href="${esc(base ? `${base}timeline/` : 'timeline/')}">${ICON_CLOCK}<span>时间线</span></a>
          <a class="navbtn${catActive}" href="${esc(base ? `${base}category/` : 'category/')}">${ICON_TAG}<span>分类</span></a>
          <button class="navbtn theme-toggle" type="button" data-theme-toggle aria-label="切换暗色模式" title="切换暗色 / 亮色">${ICON_SUN}${ICON_MOON}</button>
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

/**
 * GitHub 卡上的「Gitee 镜像」标记。
 *
 * 镜像仓库的提交只出一张卡（GitHub 那边），Gitee 侧不再重复。这个标记把那层
 * 关系补回界面上：悬停能看到「那 N 次提交是同一批改动」，点进去是 Gitee 仓库。
 */
function mirrorChip(item) {
  if (item.platform !== 'github') return '';
  const mirror = MIRROR_BY_GITHUB.get(item.meta?.repo ?? '');
  if (!mirror?.repo) return '';
  const gitee = getPlatform('gitee');
  const tip = `Gitee 上有同名镜像仓库（gitee.com/${mirror.repo}）：那 ${mirror.commits} 次提交是同一批改动，已并入这张 GitHub 卡`;
  return `<a class="item__mirror" href="https://gitee.com/${esc(mirror.repo)}" target="_blank" rel="noopener noreferrer" title="${esc(tip)}" style="--pc:${esc(gitee.color)}"><span class="item__mirror-dot"></span>Gitee 镜像</a>`;
}

/** 汇总型条目（带逐条明细）：整张卡不能是链接，否则明细里的链接会嵌套。 */
function renderDigestItem(item) {
  const platform = getPlatform(item.platform);
  const changes = item.meta.changes;
  // Weblate 目前只有 TDE 一个项目，汇总卡用一张 release 截图当底图（右上角起渐隐）
  const tde = item.platform === 'weblate' ? ' item--tde' : '';
  // 分段标头不算「条」
  const total = changes.filter((change) => !change.group).length;
  const fold = TLIST_PAGE_SIZE;
  const shown = Math.min(fold, total);
  const fullTime = item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';

  return `
      <li>
        <div class="item item--digest${tde}" style="--pc:${esc(platform.color)}">
          <div class="item__body">
            <div class="item__meta">
              <span class="item__icon">${platform.icon}</span>
              <span class="item__platform">${esc(platform.name)}</span>
              <span class="item__sep">·</span>
              <span class="item__type">${esc(item.type || '活动')}</span>
              <span class="item__sep">·</span>
              <span class="item__time" title="${esc(fullTime)}"${isoAttr(item.timestamp) ? ` datetime="${isoAttr(item.timestamp)}"` : ''}>${esc(formatTime(item.timestamp))}</span>${mirrorChip(item)}
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
  const tde = item.platform === 'weblate' ? ' item--tde' : '';
  const time = formatTime(item.timestamp);
  const fullTime = item.timestamp
    ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false })
    : '';
  return `
      <li>
        <a class="item${hasMedia ? ' item--media' : ''}${backdrop ? ' item--game' : ''}${showBadge ? ' item--badge' : ''}${tde}" href="${esc(item.url || '#')}"
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
        本页由 GitHub Actions 每 1 小时自动巡检各平台并重新生成，共收录
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
<script>
/* 主题在首屏渲染前定下来：先读用户上次的选择，没有就跟随系统。
   必须在样式表之前执行，否则深色系统会先闪一帧深色再跳亮色。
   写成内联而不是放 site.js，是因为 site.js 带 defer，跑起来已经在画了。 */
try {
  var theme = localStorage.getItem('theme');
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = theme;
} catch (e) {}
</script>
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
<button class="totop" type="button" data-to-top aria-label="回到顶部" tabindex="-1">${ICON_UP}</button>
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
  /*
   * 镜像关系要跟着数据走：分类页是浏览器端用 items.json 重新渲染的（筛选、搜索都走
   * 那一份），只在静态 HTML 里挂标记的话，一点筛选标记就没了。
   */
  const mirror = item.platform === 'github' ? MIRROR_BY_GITHUB.get(item.meta?.repo ?? '') : null;
  const gitee = getPlatform('gitee');
  return {
    ...item,
    platformName: platform.name,
    platformShort: platform.short,
    color: platform.color,
    icon: platform.icon,
    year: yearOf(item.timestamp),
    kind: kindOf(item.platform),
    timeText: formatTime(item.timestamp),
    mirror: mirror
      ? { platform: 'gitee', name: gitee.name, repo: mirror.repo, commits: mirror.commits, color: gitee.color }
      : null,
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
      /*
       * Gitee 的计数要算上「镜像卡」：那些仓库的提交并进了 GitHub 卡，但点开 Gitee
       * 时它们会一起列出来（见 site.js 的筛选），所以这里得跟着显示，否则侧栏写
       * 「5」、点进去看到 72 条，两个数字对不上。
       */
      const mirrorCards =
        id === 'gitee'
          ? list.filter((item) => item.platform === 'github' && MIRROR_BY_GITHUB.has(item.meta?.repo ?? ''))
              .length
          : 0;
      const mirrorCommits = [...MIRROR_BY_GITHUB.values()].reduce((sum, m) => sum + m.commits, 0);
      const total = platformCounts.get(id) + mirrorCards;
      const mirrorNote = mirrorCards
        ? `<span class="cats__mirror" title="其中 ${mirrorCards} 张是 GitHub 上的镜像卡：这些仓库在 Gitee 是同步镜像，${mirrorCommits} 次提交已并入 GitHub 卡，点开 Gitee 会一并列出">镜像 ${mirrorCards}</span>`
        : '';
      return `<li><a class="cats__link" href="?platform=${id}" data-cats-platform-link data-platform="${id}" data-direct-count="${platformCounts.get(id)}" data-mirror-count="${mirrorCards}">
       <span class="cats__dot" style="--pc:${esc(p.color)}"></span>${esc(p.name)}<span class="cats__count">${total}</span>${mirrorNote}
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
        <p class="cats__note" data-cats-note hidden></p>
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
/* 时间线                                                              */
/* ------------------------------------------------------------------ */

/**
 * 时间线页：把全部条目按「年 → 月」铺在一条竖轴上。
 *
 * 主页是「最新 20 条一页」，想看三年前的东西得连着点几十次页码；时间线
 * 给的是「一眼看完这几年都在干什么」的视角，所以**不分页**，整份直接渲染
 * （650 条上下约 100KB HTML，比再拆一套分页简单，也没有 JS 依赖）。
 * 年月按北京时间切——和列表卡上的时间一致，否则凌晨发的会被算到前一天。
 */
async function buildTimeline(list, assetsPrefix) {
  const pad = (n) => String(n).padStart(2, '0');
  const years = new Map();

  for (const item of list) {
    const ms = Date.parse(item.timestamp || '');
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms + 8 * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    if (!years.has(y)) years.set(y, { total: 0, months: new Map() });
    const bucket = years.get(y);
    bucket.total += 1;
    if (!bucket.months.has(m)) bucket.months.set(m, []);
    bucket.months.get(m).push({ item, day: `${pad(m)}-${pad(d.getUTCDate())}` });
  }

  const yearKeys = [...years.keys()].sort((a, b) => b - a);
  const platformCount = new Set(list.map((item) => item.platform)).size;
  const span = yearKeys.length
    ? yearKeys[yearKeys.length - 1] === yearKeys[0]
      ? String(yearKeys[0])
      : `${yearKeys[yearKeys.length - 1]}–${yearKeys[0]}`
    : '';

  const jump =
    yearKeys.length > 1
      ? `<nav class="tl-jump" aria-label="按年份跳转">${yearKeys
          .map(
            (y) =>
              `<a class="tl-jump__link" href="#y${y}">${y}<span class="tl-jump__n">${years.get(y).total}</span></a>`,
          )
          .join('')}</nav>`
      : '';

  const sections = yearKeys
    .map((y) => {
      const bucket = years.get(y);
      const months = [...bucket.months.keys()].sort((a, b) => b - a);
      const monthHtml = months
        .map((m) => {
          const rows = bucket.months
            .get(m)
            .map(({ item, day }) => {
              const platform = getPlatform(item.platform);
              const fullTime = item.timestamp
                ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false })
                : '';
              return `
          <li class="tl-item" style="--pc:${esc(platform.color)}">
            <span class="tl-item__date">${esc(day)}</span>
            <span class="tl-item__body">
              <a class="tl-item__title" href="${esc(item.url || '#')}"${item.url ? ' target="_blank" rel="noopener noreferrer"' : ''} title="${esc(item.title)}">${esc(item.title)}</a>
              ${item.summary ? `<span class="tl-item__desc">${esc(item.summary)}</span>` : ''}
              <span class="tl-item__meta"><span class="tl-item__plat">${esc(platform.name)}</span><span>·</span><span>${esc(item.type || '活动')}</span><span>·</span><span>${esc(fullTime)}</span>${mirrorChip(item)}</span>
            </span>
          </li>`;
            })
            .join('');
          return `
        <div class="tl-month">
          <div class="tl-month__label">${m} 月</div>
          <ul class="tl-month__list">${rows}
          </ul>
        </div>`;
        })
        .join('');
      return `
    <section class="tl-year" id="y${y}">
      <div class="tl-year__head">
        <h2 class="tl-year__num">${y}</h2>
        <span class="tl-year__count">${bucket.total} 条</span>
        <span class="tl-year__rule"></span>
      </div>${monthHtml}
    </section>`;
    })
    .join('');

  const body = `
    <div class="section-head">
      <h2>时间线</h2>
      <span class="section-head__meta">${esc(span)} · 共 ${list.length} 条</span>
    </div>
    <p class="tl-intro">写代码、打游戏、翻译、投稿，${platformCount} 个平台的记录按年月倒序铺在这条轴上，越往下越久远。</p>
    ${jump}
    <div class="tl">${sections}
    </div>
`;

  const html = renderPage({
    title: `时间线 · ${SITE.title}`,
    description: `${SITE.owner} 各平台活动的完整时间线，按年月排列。`,
    base: assetsPrefix,
    current: 'timeline',
    body,
    assetsPrefix,
    searchSrc: `${assetsPrefix}search-index.json`,
    bodyAttrs: ` data-search-src="${esc(assetsPrefix)}search-index.json"`,
  });

  const outDir = path.join(DIST_DIR, 'timeline');
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

  // 镜像登记表：Gitee 侧被并掉的仓库，GitHub 卡上要标「Gitee 镜像」
  const mirrors = await readMirrors();
  MIRROR_BY_GITHUB = new Map(
    Object.entries(mirrors)
      .filter(([, entry]) => entry?.github)
      .map(([giteeRepo, entry]) => [
        entry.github,
        { repo: giteeRepo, commits: Number(entry.commits) || 0 },
      ]),
  );

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
  await buildTimeline(sorted, assetsPrefix);

  // 404 页
  await writeFile(
    path.join(DIST_DIR, '404.html'),
    `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<script>
/* 和主页面同一套主题初值，否则亮色用户点进 404 会突然变黑 */
try {
  var theme = localStorage.getItem('theme');
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = theme;
} catch (e) {}
</script>
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
