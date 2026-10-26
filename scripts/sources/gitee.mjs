/**
 * Gitee 活跃数据：提交（Gitee API v5 公开接口，无需 token）。
 *
 * 和 GitHub 一样输出「按仓库 + 时间时段」的汇总条目（见 lib/digest.mjs），
 * 不再一个提交一条。
 *
 * 注意：和 GitHub 不同，Gitee 这里不按 since 增量抓——汇总条目每次都要用
 * 完整时段重算，只取增量会让条数失真、时段起点乱跳。固定回看 lookbackDays 天。
 *
 * 镜像仓库（tpaxs / Staxle / milk-fk 这类 GitHub 同步过来的）里的提交不算 Gitee
 * 的独立活动，切时段前就按 sha 丢掉，见 lib/mirrors.mjs。
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';
import { buildRepoDigests } from '../lib/digest.mjs';
import { dropMirroredActions } from '../lib/mirrors.mjs';

const gitee = platform('gitee');
const USER = String(gitee.user);
const PER_PAGE = Math.max(1, Math.min(100, Number(gitee.perPage) || 100));
const MAX_PAGES = Math.max(1, Number(gitee.maxPages) || 2);
/** 汇总窗口（天），0 = 全历史。仓库卡是「该仓库的全部操作」，所以默认不限时间。 */
const LOOKBACK_DAYS = Math.max(0, Number(gitee.lookbackDays) || 0);
const LOOKBACK_MS = LOOKBACK_DAYS * 86400_000;
const SESSION_GAP_MS = Math.max(1, Number(gitee.sessionGapMinutes) || 90) * 60_000;
const MAX_ROWS = Math.max(1, Number(gitee.maxRows) || 300);
const MAX_REPOS = Math.max(1, Number(gitee.maxRepos) || 25);
/** 镜像声明：Gitee 仓库短名（或全名）→ GitHub 仓库，见 config.yaml。 */
const MIRRORS = gitee.mirrors ?? {};

let lastDiagnostics = null;

async function api(pathname) {
  return getJson(`https://gitee.com/api/v5${pathname}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: 20000,
    retries: 2,
  });
}

function repoHome(fullName) {
  return `https://gitee.com/${fullName}`;
}

function commitAction(commit, fullName) {
  const message = String(commit.commit?.message ?? '').split('\n')[0].trim();
  const date = commit.commit?.author?.date ?? commit.commit?.committer?.date ?? null;
  const sha = String(commit.sha ?? commit.commit?.sha ?? '');
  return {
    uid: `commit:${sha}`,
    repo: fullName,
    repoUrl: repoHome(fullName),
    kind: '提交',
    ts: Date.parse(date ?? ''),
    text: message,
    component: sha ? sha.slice(0, 7) : null,
    url: commit.html_url ?? (sha ? `${repoHome(fullName)}/commit/${sha}` : `${repoHome(fullName)}/commits`),
  };
}

async function fetchCommits(fullName, sinceIso) {
  const commits = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let batch;
    try {
      const since = sinceIso ? `&since=${encodeURIComponent(sinceIso)}` : '';
      batch = await api(`/repos/${fullName}/commits?per_page=${PER_PAGE}&page=${page}${since}`);
    } catch (error) {
      // 任何一页失败都算这个仓库没取全：宁可这轮不更新它的卡片，
      // 也不能用「缺了几页」的数据去覆盖原来完整的卡（会静默丢历史）。
      console.warn(`[gitee] ${fullName} 提交获取失败（本轮跳过该仓库）: ${error.message}`);
      return null;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    commits.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return commits;
}

/**
 * @param {object} [options]
 * @param {() => {byRepo: Map<string, Set<string>>, byNorm: Map<string, Set<string>>}} [options.githubShas]
 *   取 GitHub 已落库的提交 sha 索引（在 Gitee 跑之前调用，此时 GitHub 这轮的结果已经并入列表）
 * @returns {Promise<Array<object>>} 汇总条目（meta.merge = true）
 */
export async function fetchGitee({ githubShas } = {}) {
  const cutoff = LOOKBACK_DAYS > 0 ? Date.now() - LOOKBACK_MS : Number.NEGATIVE_INFINITY;
  const safetyStart = Number.isFinite(cutoff) ? cutoff - 2 * 86400_000 : Number.NEGATIVE_INFINITY;
  const sinceIso = Number.isFinite(safetyStart) ? new Date(safetyStart).toISOString() : null;
  const diag = { lookbackDays: LOOKBACK_DAYS || 0, repos: 0, commits: 0, truncated: 0 };
  const actions = [];

  let repos;
  try {
    repos = await api(`/users/${USER}/repos?per_page=100&sort=updated&type=all`);
  } catch (error) {
    console.warn(`[gitee] 仓库列表获取失败: ${error.message}`);
    diag.error = error.message;
    lastDiagnostics = diag;
    return [];
  }
  if (!Array.isArray(repos)) repos = [];
  diag.repos = repos.length;

  const candidates = repos
    .filter((repo) => {
      const pushed = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
      return pushed >= cutoff;
    })
    .slice(0, MAX_REPOS);

  for (const repo of candidates) {
    const commits = await fetchCommits(repo.full_name, sinceIso);
    if (commits === null) {
      diag.skipped = (diag.skipped ?? 0) + 1;
      continue;
    }
    if (commits.length >= PER_PAGE * MAX_PAGES) diag.truncated += 1;
    for (const commit of commits) {
      const action = commitAction(commit, repo.full_name);
      if (Number.isFinite(action.ts)) actions.push(action);
    }
    diag.commits += commits.length;
  }

  // 镜像仓库的提交在这里就出局：它们已经在 GitHub 卡里了，再算一遍等于同一件
  // 工作出现两次。必须在切时段之前过滤，否则镜像提交会把 Gitee 独有的提交
  // 连成一段不存在的「连续动工」。
  let usable = actions;
  if (typeof githubShas === 'function') {
    const { kept, dropped, repos, hits } = dropMirroredActions(actions, githubShas(), MIRRORS);
    usable = kept;
    if (dropped > 0) {
      diag.mirrored = dropped;
      // 交给 collect 写进 res/mirrors.json：卡片并掉了，但「Gitee 上也有这个仓库」
      // 这条信息要留在站点上（GitHub 卡会标「Gitee 同步」）。
      diag.mirrorHits = Object.fromEntries(
        [...hits.entries()].map(([repo, hit]) => [repo, { github: hit.github, commits: hit.count }]),
      );
      console.log(`[gitee] 跳过 ${dropped} 条镜像提交（已在 GitHub 卡里）: ${repos.join(', ')}`);
    }
  }

  const digests = buildRepoDigests({
    platform: 'gitee',
    actions: usable.filter((action) => action.ts >= safetyStart),
    gapMs: SESSION_GAP_MS,
    maxRows: MAX_ROWS,
    type: '仓库活动',
  });

  const settled = digests.filter((digest) => Date.parse(digest.meta.windowEnd) >= cutoff);
  diag.actions = usable.length;
  diag.digests = settled.length;
  lastDiagnostics = diag;
  return settled;
}

export function lastGiteeDiagnostics() {
  return lastDiagnostics;
}
