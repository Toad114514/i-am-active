/**
 * Gitee 活跃数据：只查提交。
 * 使用 Gitee API v5 公开接口，无需 token。
 * 同样支持增量：只查 since 之后有推送的仓库。
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const gitee = platform('gitee');
const USER = String(gitee.user);
const PER_PAGE = Math.max(1, Number(gitee.perPage) || 30);
/** 首次运行回溯多久（天）。 */
const BACKFILL_DAYS = Math.max(1, Number(gitee.backfillDays) || 365);

async function api(pathname) {
  return getJson(`https://gitee.com/api/v5${pathname}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: 20000,
    retries: 2,
  });
}

function mapCommit(commit, repoName) {
  const message = String(commit.commit?.message ?? '').split('\n')[0];
  return {
    id: `gitee:commit:${commit.sha ?? commit.commit?.sha}`,
    platform: 'gitee',
    type: '提交',
    title: message || '提交更新',
    summary: `在 ${repoName} 中提交：${message}`,
    url: commit.html_url ?? `https://gitee.com/${repoName}/commits`,
    image: null,
    timestamp: commit.commit?.author?.date ?? commit.commit?.committer?.date ?? null,
    meta: { sha: (commit.sha ?? '').slice(0, 7), repo: repoName },
  };
}

/**
 * @param {{since?: Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchGitee(context = {}) {
  const items = [];
  const since = context.since ?? null;
  const sinceParam = since ? `&since=${encodeURIComponent(since.toISOString())}` : '';

  let repos;
  try {
    repos = await api(`/users/${USER}/repos?per_page=100&sort=updated&type=all`);
  } catch (error) {
    console.warn(`[gitee] 仓库列表获取失败: ${error.message}`);
    return [];
  }

  const cutoff = since ? since.getTime() : Date.now() - BACKFILL_DAYS * 86400_000;
  const candidates = repos.filter((repo) => {
    const pushed = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
    return pushed >= cutoff;
  });

  for (const repo of candidates) {
    try {
      const commits = await api(
        `/repos/${repo.full_name}/commits?per_page=${PER_PAGE}${sinceParam}`,
      );
      if (Array.isArray(commits)) {
        for (const commit of commits) items.push(mapCommit(commit, repo.full_name));
      }
    } catch (error) {
      console.warn(`[gitee] ${repo.full_name} 提交获取失败: ${error.message}`);
    }
  }

  return items;
}
