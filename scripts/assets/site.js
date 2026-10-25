/* ============================================================
   i-am-active · 客户端脚本
   - 实时搜索（本地索引过滤）
   - 分类页年份 / 平台联动筛选
   - 页脚当前时间（每秒刷新）
   - 访问计数（多端点容错，失败静默降级）
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 工具 ---------------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);

  /* ---------------- 汇总条目（逐条明细 + 页码式分页） ---------------- */

  /** 每页条数；若卡片自带 data-tlist-page-size 则以它为准。 */
  const TLIST_PAGE_SIZE = 5;

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
    // 仓库活动（GitHub / Gitee）
    提交: '提交',
    新建仓库: '仓库',
    '新建 PR': 'PR',
    '新建 Issue': 'Issue',
    '合并 PR': '合并',
  };

  const rowTime = (iso) => {
    const ms = Date.parse(iso || '');
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };

  /** 分类页用：把带明细的条目渲染成和静态页一致的卡片。 */
  function renderDigestItem(item, fold) {
    const size = fold || TLIST_PAGE_SIZE;
    const changes = item.meta.changes;
    // 分段标头（仓库活动里按连续工作时段分段）不算「条」
    const total = changes.filter((change) => !change.group).length;
    // 首页可见的判定按「条目」算，标头跟着所属的那一段走
    const visible = new Set();
    let shownEntries = 0;
    let group = null;
    changes.forEach((change, index) => {
      if (change.group) {
        group = index;
        return;
      }
      if (shownEntries < size) {
        visible.add(index);
        if (group !== null) visible.add(group);
        shownEntries += 1;
      }
    });
    const rows = changes
      .map((change, index) => {
        const hidden = visible.has(index) ? '' : ' hidden';
        if (change.group) {
          return `
              <li class="tlist__group" data-tlist-group${hidden}>
                <span>${escapeHtml(change.group)}</span>
              </li>`;
        }
        const label = ACTION_SHORT[change.action] || change.action || '';
        const text = String(change.text || '').trim() || '（空文字）';
        return `
              <li class="tlist__row"${hidden}>
                <a class="tlist__link" href="${escapeHtml(change.url || '#')}" target="_blank" rel="noopener noreferrer">
                  <span class="tlist__text">${escapeHtml(text)}</span>
                  ${label ? `<span class="tlist__tag">${escapeHtml(label)}</span>` : ''}
                  ${change.component ? `<span class="tlist__comp">${escapeHtml(change.component)}</span>` : ''}
                  <time class="tlist__time">${escapeHtml(rowTime(change.time))}</time>
                </a>
              </li>`;
      })
      .join('');

    return `
        <li>
          <div class="item item--digest" style="--pc:${escapeHtml(item.color || '#888')}">
            <div class="item__body">
              <div class="item__meta">
                <span class="item__icon">${item.icon || ''}</span>
                <span class="item__platform">${escapeHtml(item.platformName || '')}</span>
                <span class="item__sep">·</span>
                <span class="item__type">${escapeHtml(item.type || '')}</span>
                <span class="item__sep">·</span>
                <span class="item__time">${escapeHtml(item.timeText || '')}</span>
              </div>
              <h3 class="item__title"><a class="item__titlelink" href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
              <ul class="tlist" data-tlist data-tlist-page-size="${size}" data-tlist-current="1">${rows}
              </ul>
              <div class="tlist__foot">
                <span class="tlist__progress" data-tlist-progress>第 1-${Math.min(size, total)} 条 / 共 ${total} 条</span>
                <nav class="pager pager--inner" data-tlist-pager aria-label="明细分页" hidden></nav>
              </div>
            </div>
          </div>
        </li>`;
  }

  /** 页码窗口：当前页前后各 2 页，外加首末页。 */
  function pagerWindow(current, totalPages) {
    const out = [];
    for (let n = 1; n <= totalPages; n += 1) {
      if (n === 1 || n === totalPages || Math.abs(n - current) <= 2) out.push(n);
    }
    return out;
  }

  /** 渲染页码条（按钮，不产生历史记录）。 */
  function renderTlistPager(nav, current, totalPages) {
    if (totalPages <= 1) {
      nav.hidden = true;
      nav.textContent = '';
      return;
    }
    const parts = [];
    if (current > 1) {
      parts.push(
        `<button class="pager__link" type="button" data-tlist-page="${current - 1}" aria-label="上一页">‹</button>`
      );
    }
    let previous = 0;
    pagerWindow(current, totalPages).forEach((n) => {
      if (previous && n - previous > 1) parts.push('<span class="pager__gap">…</span>');
      parts.push(
        n === current
          ? `<span class="pager__link" aria-current="page">${n}</span>`
          : `<button class="pager__link" type="button" data-tlist-page="${n}" aria-label="第 ${n} 页">${n}</button>`
      );
      previous = n;
    });
    if (current < totalPages) {
      parts.push(
        `<button class="pager__link" type="button" data-tlist-page="${current + 1}" aria-label="下一页">›</button>`
      );
    }
    nav.innerHTML = parts.join('');
    nav.hidden = false;
  }

  /**
   * 翻到指定页：只切换 hidden，条目本身始终在 DOM 里。
   *
   * 分段标头（data-tlist-group）不是「一条」，不能占页码里的名额——按 DOM 行数
   * 分页时，一张卡里若有两段，每页就只显示得下 3 条明细。所以先按「条目」分页，
   * 再把标头挂到它所属的那一段上（该段在本页有条目时，标头一起显示）。
   */
  function showTlistPage(card, page) {
    const list = card.querySelector('[data-tlist]');
    if (!list) return;
    const rows = Array.from(list.children);
    if (!rows.length) return;

    const isGroup = (row) => row.hasAttribute('data-tlist-group');
    const entries = [];
    let group = null;
    for (const row of rows) {
      if (isGroup(row)) {
        group = row;
        continue;
      }
      entries.push({ row, group });
    }

    const size = Number(list.getAttribute('data-tlist-page-size')) || TLIST_PAGE_SIZE;
    const totalRows = entries.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / size));
    const current = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
    const start = (current - 1) * size;
    const slice = entries.slice(start, start + size);

    const visible = new Set(slice.map((entry) => entry.row));
    for (const entry of slice) if (entry.group) visible.add(entry.group);
    for (const row of rows) row.hidden = !visible.has(row);

    list.setAttribute('data-tlist-current', String(current));

    const progress = card.querySelector('[data-tlist-progress]');
    if (progress) {
      progress.textContent = slice.length
        ? `第 ${start + 1}-${start + slice.length} 条 / 共 ${totalRows} 条`
        : `共 ${totalRows} 条`;
    }

    const nav = card.querySelector('[data-tlist-pager]');
    if (nav) renderTlistPager(nav, current, totalPages);
  }

  /** 给页面上所有明细列表建好页码条（可重复调用，用于筛选后重渲染）。 */
  function setupTranslationLists(root) {
    $$('[data-tlist]', root || document).forEach((list) => {
      const card = list.closest('.item');
      if (!card || card.getAttribute('data-tlist-ready') === '1') return;
      card.setAttribute('data-tlist-ready', '1');
      const current = Number(list.getAttribute('data-tlist-current')) || 1;
      showTlistPage(card, current);
    });
  }

  /** 事件委托：点页码或左右箭头翻页。 */
  function initTranslationLists() {
    setupTranslationLists();
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tlist-page]');
      if (!button) return;
      const card = button.closest('.item');
      if (!card) return;
      showTlistPage(card, Number(button.getAttribute('data-tlist-page')) || 1);
    });
  }

  /* ---------------- 页脚时钟 ---------------- */

  function startClock() {
    const node = $('[data-clock]');
    if (!node) return;
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
      const now = new Date();
      const stamp =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      node.textContent = stamp;
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------------- 访问计数 ---------------- */

  /*
   * 依次尝试多个公开计数端点；全部失败则用本地存储估算，
   * 保证页脚永远有数字而不是空白。
   */
  function startViewCounter() {
    const node = $('[data-views]');
    if (!node) return;

    const NS = 'i-am-active';
    const KEY = 'views';
    const ENDPOINTS = [
      `https://api.countapi.xyz/hit/${NS}/${KEY}`,
      `https://countapi.dev/api/v1/hit?${NS}&${KEY}`,
    ];

    const LOCAL_KEY = 'i-am-active:views';

    const localCount = () => {
      let n = 0;
      try {
        n = Number(localStorage.getItem(LOCAL_KEY) || 0);
      } catch (_) {
        /* 隐私模式下 localStorage 不可用 */
      }
      n += 1;
      try {
        localStorage.setItem(LOCAL_KEY, String(n));
      } catch (_) {
        /* 忽略写入失败 */
      }
      return n;
    };

    const render = (n) => {
      node.textContent = Number(n || 0).toLocaleString('zh-CN');
    };

    render(localCount());

    let index = 0;
    const tryNext = () => {
      if (index >= ENDPOINTS.length) return;
      const url = ENDPOINTS[index++];
      fetch(url, { method: 'POST', mode: 'cors', cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
        .then((data) => {
          const count = data && (data.count ?? data.value ?? data.hits);
          if (Number(count) > 0) render(count);
        })
        .catch(() => tryNext());
    };
    tryNext();
  }

  /* ---------------- 搜索 ---------------- */

  function startSearch() {
    const input = $('[data-search-input]');
    const panel = $('[data-search-panel]');
    const clear = $('[data-search-clear]');
    if (!input || !panel) return;

    let index = [];
    let ready = false;

    const load = () => {
      if (ready) return;
      ready = true;
      const src = document.body.getAttribute('data-search-src');
      if (!src) return;
      fetch(src, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => {
          index = Array.isArray(data) ? data : [];
        })
        .catch(() => {
          index = [];
        });
    };

    const hide = () => {
      panel.setAttribute('data-open', '0');
      clear && clear.setAttribute('data-show', '0');
    };

    const render = (keyword) => {
      const q = keyword.trim().toLowerCase();
      if (!q) {
        panel.innerHTML = '<div class="search__hint">输入关键词以搜索标题、简介与平台</div>';
        return;
      }
      const hits = [];
      for (const item of index) {
        const haystack = `${item.title} ${item.summary} ${item.platformName} ${item.type}`.toLowerCase();
        if (haystack.includes(q)) hits.push(item);
        if (hits.length >= 40) break;
      }
      if (!hits.length) {
        panel.innerHTML = '<div class="search__hint">没有匹配的结果</div>';
        return;
      }
      panel.innerHTML = hits
        .map(
          (item) => `
        <a class="search__row" href="${escapeHtml(item.url || '#')}">
          <div class="search__row-top">
            <span>${escapeHtml(item.platformName || item.platform)}</span>
            <span>·</span>
            <span>${escapeHtml(item.type || '')}</span>
            <span>·</span>
            <span>${escapeHtml(item.timeText || '')}</span>
          </div>
          <div class="search__row-title">${escapeHtml(item.title)}</div>
        </a>`
        )
        .join('');
    };

    input.addEventListener('focus', () => {
      load();
      panel.setAttribute('data-open', '1');
      render(input.value);
    });

    input.addEventListener('input', () => {
      load();
      panel.setAttribute('data-open', '1');
      if (input.value) clear && clear.setAttribute('data-show', '1');
      render(input.value);
    });

    clear &&
      clear.addEventListener('click', () => {
        input.value = '';
        clear.setAttribute('data-show', '0');
        input.focus();
        render('');
      });

    document.addEventListener('click', (event) => {
      if (!panel.contains(event.target) && event.target !== input) hide();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hide();
        input.blur();
      }
    });
  }

  /* ---------------- 分类页筛选 ---------------- */

  function startCategoryFilter() {
    const root = $('[data-cats]');
    if (!root) return;

    const listNode = $('[data-cats-list]', root);
    // 计数在 .section-head 里，不在 [data-cats] 里面——按 root 找会永远是 null，
    // 结果条数就停在 SSR 生成的「共 N 条」不动了。
    const countNode = $('[data-cats-count]');
    const emptyNode = $('[data-cats-empty]', root);
    const yearSelect = $('[data-cats-year]', root);
    const platformSelect = $('[data-cats-platform]', root);
    const kindSelect = $('[data-cats-kind]', root);
    let items = [];

    // 三个维度可以叠加：年份 × 活动类型 × 平台
    const state = { year: 'all', kind: 'all', platform: 'all' };

    const load = () => {
      const src = root.getAttribute('data-cats-src');
      if (!src) return Promise.resolve();
      return fetch(src, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => {
          items = Array.isArray(data) ? data : [];
          apply();
        })
        .catch(() => {
          items = [];
          apply();
        });
    };

    const apply = () => {
      const filtered = items.filter((item) => {
        if (state.year !== 'all' && String(item.year) !== state.year) return false;
        if (state.kind !== 'all' && item.kind !== state.kind) return false;
        if (state.platform !== 'all' && item.platform !== state.platform) return false;
        return true;
      });

      if (countNode) {
        countNode.textContent = `${filtered.length} 条结果`;
      }
      if (!listNode) return;

      if (!filtered.length) {
        listNode.innerHTML = '';
        if (emptyNode) emptyNode.hidden = false;
        return;
      }
      if (emptyNode) emptyNode.hidden = true;

      listNode.innerHTML = filtered
        .map((item) => {
          if (item.meta && Array.isArray(item.meta.changes) && item.meta.changes.length) {
            // 每页条数必须和静态页同一份（TLIST_PAGE_SIZE）：这里曾经写死 10，
            // 于是分类页上汇总卡一页显示 10 条，首页是 5 条，两处不一致。
            return renderDigestItem(item, TLIST_PAGE_SIZE);
          }
          // 和 build.mjs 的 renderItem 保持同一套规则：有游戏背景图时，
          // 成就图标缩成右下角角标；没有就退回「图标当背景」。
          const backdrop = (item.meta && item.meta.backdrop) || null;
          const badge = (item.meta && item.meta.badge) || null;
          const mediaSrc = backdrop || item.image;
          const hasMedia = Boolean(mediaSrc);
          const showBadge = Boolean(backdrop) && Boolean(badge);
          return `
        <li>
          <a class="item${hasMedia ? ' item--media' : ''}${backdrop ? ' item--game' : ''}${showBadge ? ' item--badge' : ''}" href="${escapeHtml(item.url || '#')}"
             style="--pc:${escapeHtml(item.color || '#888')}">
            ${
              hasMedia
                ? `<span class="item__media"><img src="${escapeHtml(mediaSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
                : ''
            }
            ${
              showBadge
                ? `<img class="item__badge" src="${escapeHtml(badge)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                : ''
            }
            <div class="item__body">
              <div class="item__meta">
                <span class="item__icon">${item.icon || ''}</span>
                <span class="item__platform">${escapeHtml(item.platformName || '')}</span>
                <span class="item__sep">·</span>
                <span class="item__type">${escapeHtml(item.type || '')}</span>
                <span class="item__sep">·</span>
                <span class="item__time">${escapeHtml(item.timeText || '')}</span>
              </div>
              <h3 class="item__title">${escapeHtml(item.title)}</h3>
              <p class="item__summary">${escapeHtml(item.summary)}</p>
              <div class="item__foot">
                <span class="item__jump">跳转到 ${escapeHtml(item.platformShort || '')}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                </span>
              </div>
            </div>
          </a>
        </li>`;
        })
        .join('');

      // 重新渲染后，新卡片需要重新建页码条
      setupTranslationLists(listNode);
    };

    const sync = () => {
      $$('[data-cats-year-link]', root).forEach((link) => {
        link.setAttribute(
          'aria-current',
          link.getAttribute('data-year') === state.year ? 'true' : 'false'
        );
      });
      $$('[data-cats-kind-link]', root).forEach((link) => {
        link.setAttribute(
          'aria-current',
          link.getAttribute('data-kind') === state.kind ? 'true' : 'false'
        );
      });
      $$('[data-cats-platform-link]', root).forEach((link) => {
        link.setAttribute(
          'aria-current',
          link.getAttribute('data-platform') === state.platform ? 'true' : 'false'
        );
      });
      if (yearSelect) yearSelect.value = state.year;
      if (kindSelect) kindSelect.value = state.kind;
      if (platformSelect) platformSelect.value = state.platform;
      const url = new URL(window.location.href);
      if (state.year === 'all') url.searchParams.delete('year');
      else url.searchParams.set('year', state.year);
      if (state.kind === 'all') url.searchParams.delete('kind');
      else url.searchParams.set('kind', state.kind);
      if (state.platform === 'all') url.searchParams.delete('platform');
      else url.searchParams.set('platform', state.platform);
      window.history.replaceState(null, '', url);
    };

    root.addEventListener('click', (event) => {
      const link = event.target.closest(
        '[data-cats-year-link], [data-cats-kind-link], [data-cats-platform-link]'
      );
      if (!link) return;
      event.preventDefault();
      if (link.hasAttribute('data-year')) state.year = link.getAttribute('data-year');
      if (link.hasAttribute('data-kind')) state.kind = link.getAttribute('data-kind');
      if (link.hasAttribute('data-platform')) state.platform = link.getAttribute('data-platform');
      sync();
      apply();
    });

    [yearSelect, kindSelect, platformSelect].forEach((select) => {
      if (!select) return;
      select.addEventListener('change', () => {
        if (select === yearSelect) state.year = select.value;
        else if (select === kindSelect) state.kind = select.value;
        else state.platform = select.value;
        sync();
        apply();
      });
    });

    const params = new URLSearchParams(window.location.search);
    const y = params.get('year');
    const k = params.get('kind');
    const p = params.get('platform');
    if (y && $(`[data-cats-year-link][data-year="${CSS.escape(y)}"]`, root)) state.year = y;
    if (k && $(`[data-cats-kind-link][data-kind="${CSS.escape(k)}"]`, root)) state.kind = k;
    if (p && $(`[data-cats-platform-link][data-platform="${CSS.escape(p)}"]`, root))
      state.platform = p;

    sync();
    load();
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    startClock();
    startViewCounter();
    startSearch();
    startCategoryFilter();
    initTranslationLists();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
