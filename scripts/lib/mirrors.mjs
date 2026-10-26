/**
 * Gitee 镜像仓库去重。
 *
 * 背景：Gitee 上有一批仓库是 GitHub 的镜像同步——toadstool/tpaxs ← Toad114514/tpaxs、
 * toadstool/staxle ← Toad114514/Staxle、toadstool/milkfk ← Toad114514/milk-fk。
 * 镜像同步是把同一批提交原样搬过去，于是两边各生成一套仓库卡，时间线上看起来
 * 像同一件事干了两遍。这里把「Gitee 那边只是镜像」的提交丢掉，让 GitHub 卡独自
 * 代表这段工作；Gitee 上真正独有的提交（直接推到 Gitee、或者镜像断了）照常出卡。
 *
 * 判据用**提交 sha**，不用仓库名：sha 是内容寻址的，镜像过去的提交在两边完全
 * 一致；仓库改过名（efopt → Efoptos、hqkillboss → huaqiangbuymelon）也不影响。
 *
 * 但也不能只看 sha：同一个提交被推到两个不同项目里（fork、挪仓库）时两边是不同
 * 的「去处」，不该互相吞。所以还要求仓库对得上——要么规范化后短名相同
 * （大小写、连字符、下划线不敏感），要么在 config.yaml 的 gitee.mirrors 里显式
 * 声明。改了名的仓库只能靠声明，没法猜。
 */

/** 仓库短名规范化：`Toad114514/milk-fk` → `milkfk`。 */
export function normRepo(fullName) {
  return String(fullName ?? '')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * 从列表里收集 GitHub 提交 sha。
 *
 * 数据源就用已经落库的 GitHub 卡（meta.changes 里每行带 7 位短 sha），而不是重新
 * 请求一次 API：卡片本身就是抓取结果的留档，用它判断镜像不需要网络，也不会因为
 * 限流拿到一半数据就误判。
 *
 * @param {Array<object>} list res/list.json 的条目
 * @returns {{byRepo: Map<string, Set<string>>, byNorm: Map<string, Set<string>>}}
 */
export function buildGitHubShaIndex(list) {
  const byRepo = new Map();
  const byNorm = new Map();
  const nameByNorm = new Map();
  for (const item of list) {
    if (item.platform !== 'github') continue;
    const repo = item.meta?.repo;
    if (!repo) continue;
    for (const row of item.meta?.changes ?? []) {
      const sha = row.component;
      if (!sha) continue;
      if (!byRepo.has(repo)) byRepo.set(repo, new Set());
      byRepo.get(repo).add(sha);
      const key = normRepo(repo);
      if (!byNorm.has(key)) byNorm.set(key, new Set());
      byNorm.get(key).add(sha);
      // 记下规范化短名对应的「真名」，卡片上要显示链接
      if (!nameByNorm.has(key)) nameByNorm.set(key, repo);
    }
  }
  return { byRepo, byNorm, nameByNorm };
}

/**
 * 某个 Gitee 仓库对应的 GitHub 仓库与提交集合；对不上（不是镜像）返回 null。
 *
 * @param {string} giteeRepo `toadstool/xbres`
 * @param {{byRepo: Map<string, Set<string>>, byNorm: Map<string, Set<string>>, nameByNorm: Map<string, string>}} index
 * @param {Record<string, string>} [aliases] config.yaml 的 gitee.mirrors
 * @returns {{github: string|null, shas: Set<string>}|null}
 */
export function mirrorTargetFor(giteeRepo, index, aliases = {}) {
  const norm = normRepo(giteeRepo);
  // 1. 显式声明的镜像（改过名的仓库只能走这条）
  for (const [from, to] of Object.entries(aliases ?? {})) {
    if (normRepo(from) !== norm) continue;
    const target = String(to);
    const direct = index.byRepo.get(target);
    if (direct) return { github: target, shas: direct };
    const key = normRepo(target);
    const loose = index.byNorm.get(key);
    if (loose) return { github: index.nameByNorm.get(key) ?? target, shas: loose };
  }
  // 2. 短名相同的
  const shas = index.byNorm.get(norm);
  if (!shas) return null;
  return { github: index.nameByNorm.get(norm) ?? null, shas };
}

/** 兼容旧调用：只要 sha 集合。 */
export function mirrorShasFor(giteeRepo, index, aliases = {}) {
  return mirrorTargetFor(giteeRepo, index, aliases)?.shas ?? null;
}

/**
 * 丢掉「Gitee 上只是镜像」的提交动作。
 *
 * 必须在切时段（digest）之前过滤：镜像提交如果算进时段，会让 Gitee 独有的提交
 * 跟一批不存在的工作连成一段，切出来的卡和实际动工节奏对不上。
 *
 * @param {Array<{repo: string, kind: string, component?: string|null}>} actions
 * @param {{byRepo: Map<string, Set<string>>, byNorm: Map<string, Set<string>>}} index
 * @param {Record<string, string>} [aliases]
 * @returns {{kept: Array<object>, dropped: number, repos: string[], hits: Map<string, {github: string|null, count: number}>}}
 */
export function dropMirroredActions(actions, index, aliases = {}) {
  const cache = new Map();
  const kept = [];
  const hits = new Map();
  let dropped = 0;
  for (const action of actions) {
    // 只处理提交：Issue / PR 在 Gitee 上本来就不抓，没有镜像可言
    if (action.kind !== '提交' || !action.component) {
      kept.push(action);
      continue;
    }
    if (!cache.has(action.repo)) {
      cache.set(action.repo, mirrorTargetFor(action.repo, index, aliases));
    }
    const target = cache.get(action.repo);
    if (target && target.shas.has(action.component)) {
      dropped += 1;
      const hit = hits.get(action.repo) ?? { github: target.github, count: 0 };
      hit.count += 1;
      hits.set(action.repo, hit);
      continue;
    }
    kept.push(action);
  }
  const repos = [...hits.entries()].map(([repo, hit]) => `${repo}(${hit.count})`);
  return { kept, dropped, repos, hits };
}

/**
 * 从（还没清理过的）列表里统计镜像关系，写成 res/mirrors.json 那种结构。
 *
 * 每次 collect 都会重算镜像关系，但「哪些仓库是镜像、镜像了多少提交」这个事实
 * 在提交被丢掉之后就查不到了。留一份登记表，站点的 GitHub 卡才能标出
 * 「这个仓库在 Gitee 也有同步」，也顺便解释 Gitee 那边为什么只剩几张卡。
 *
 * @param {Array<object>} list
 * @param {object} index
 * @param {Record<string, string>} [aliases]
 * @returns {Record<string, {github: string|null, commits: number, cards: number}>}
 */
export function summarizeMirrors(list, index, aliases = {}) {
  /** @type {Record<string, {github: string|null, commits: number, cards: number}>} */
  const out = {};
  for (const item of list) {
    if (item.platform !== 'gitee' || !item.meta?.repo) continue;
    const rows = item.meta?.changes ?? [];
    if (!rows.length) continue;
    const target = mirrorTargetFor(item.meta.repo, index, aliases);
    if (!target) continue;
    const covered = rows.filter((row) => row.component && target.shas.has(row.component)).length;
    if (!covered) continue;
    const entry = out[item.meta.repo] ?? { github: target.github, commits: 0, cards: 0 };
    entry.commits += covered;
    // 整张卡都是镜像才算一张「已并入」的卡
    if (covered === rows.length) entry.cards += 1;
    if (!entry.github && target.github) entry.github = target.github;
    out[item.meta.repo] = entry;
  }
  return out;
}

/**
 * 清掉历史数据里已经落库的「纯镜像」Gitee 卡。
 *
 * 抓取侧的过滤只对「本轮新生成的卡」生效：以前跑出来的镜像卡 id 是当时算的，
 * 这轮不会再生成同一张（时段起点会变），必须单独删。只删**整张卡都是镜像提交**
 * 的——半镜像的卡留给本轮重新生成的卡去覆盖（applyMerged 认同一仓库的重叠时段）。
 *
 * @param {Array<object>} list 会被原地修改
 * @param {{byRepo: Map<string, Set<string>>, byNorm: Map<string, Set<string>>}} index
 * @param {Record<string, string>} [aliases]
 * @returns {{removed: string[]}}
 */
export function pruneMirroredCards(list, index, aliases = {}) {
  const removed = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (item.platform !== 'gitee' || !item.meta?.repo) continue;
    const rows = item.meta.changes ?? [];
    if (!rows.length) continue;
    const shas = mirrorShasFor(item.meta.repo, index, aliases);
    if (!shas) continue;
    const allMirrored = rows.every((row) => row.component && shas.has(row.component));
    if (!allMirrored) continue;
    removed.push(item.id);
    list.splice(i, 1);
  }
  return { removed };
}
