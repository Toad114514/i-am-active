/**
 * GitHub 活跃数据：提交 / 新建仓库 / 新建 PR / 新建 Issue。
 *
 * 关键点（实测）：
 *  - `/users/<u>/events/public` 的 PushEvent 里 `payload.commits` 恒为空数组，
 *    拿不到提交信息，所以提交改走 `/repos/<owner>/<repo>/commits?author=`。
 *  - 匿名 API 限流 60 次/小时；配置 GITHUB_TOKEN 后为 5000 次/小时。
 *  - 因此这里做增量：只查 `since` 之后有推送的仓库，且首次运行用较长回溯窗口。
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const github = platform('github');
const USER = String(github.user);
const PER_PAGE = Math.max(1, Number(github.perPage) || 30);
/** 首次运行回溯多久（天）。 */
const BACKFILL_DAYS = Math.max(1, Number(github.backfillDays) || 120);

function headers() {
  const token = String(github.token ?? '').trim();
  return token
    ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
    : { Accept: 'application/vnd.github+json' };
}

async function api(pathname, { retries = 2 } = {}) {
  return getJson(`https://api.github.com${pathname}`, {
    headers: headers(),
    timeoutMs: 20000,
    retries,
  });
}

function mapCommit(commit, repo) {
  const message = String(commit.commit?.message ?? '').split('\n')[0];
  return {
    id: `github:commit:${commit.sha}`,
    platform: 'github',
    type: '提交',
    title: message || '提交更新',
    summary: `在 ${repo} 中提交：${message}`,
    url: commit.html_url,
    image: null,
    timestamp: commit.commit?.author?.date ?? commit.commit?.committer?.date ?? null,
    meta: { sha: commit.sha.slice(0, 7), repo },
  };
}

function mapRepo(repo) {
  return {
    id: `github:repo:${repo.id}`,
    platform: 'github',
    type: '新建仓库',
    title: repo.name,
    summary: repo.description
      ? `新建仓库 ${repo.name}：${repo.description}`
      : `新建仓库 ${repo.name}`,
    url: repo.html_url,
    image: null,
    timestamp: repo.created_at,
    meta: { repo: repo.full_name, language: repo.language ?? null, stars: repo.stargazers_count },
  };
}

function mapIssue(event) {
  const payload = event.payload ?? {};
  const isPr = Boolean(payload.pull_request);
  const title = payload.issue?.title ?? '未命名';
  const url = payload.issue?.html_url ?? `https://github.com/${USER}`;

  return {
    id: `github:${isPr ? 'pr' : 'issue'}:${payload.issue?.id ?? event.id}`,
    platform: 'github',
    type: isPr ? '新建 PR' : '新建 Issue',
    title,
    summary: isPr ? `提交了 Pull Request：${title}` : `创建了 Issue：${title}`,
    url,
    image: null,
    timestamp: event.created_at,
    meta: { repo: event.repo?.name ?? null, action: payload.action ?? '' },
  };
}

/**
 * @param {{since?: Date|null}} [context] since 为上次成功抓取时间
 * @returns {Promise<Array<object>>}
 */
export async function fetchGitHub(context = {}) {
  const items = [];
  const since = context.since ?? null;
  const sinceParam = since ? `&since=${encodeURIComponent(since.toISOString())}` : '';

  let repos = [];
  try {
    repos = await api(`/users/${USER}/repos?per_page=100&sort=pushed&type=owner`);
  } catch (error) {
    console.warn(`[github] 仓库列表获取失败: ${error.message}`);
  }

  // 新建仓库
  for (const repo of repos) {
    if (!repo.fork) items.push(mapRepo(repo));
  }

  // 提交：只查 since 之后推送过的仓库；没有 since 时按回溯窗口筛。
  const cutoff = since ? since.getTime() : Date.now() - BACKFILL_DAYS * 86400_000;
  const candidates = repos
    .filter((repo) => {
      const pushed = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
      return pushed >= cutoff;
    })
    .slice(0, 25);

  for (const repo of candidates) {
    try {
      const commits = await api(
        `/repos/${repo.full_name}/commits?author=${USER}&per_page=${PER_PAGE}${sinceParam}`,
      );
      if (Array.isArray(commits)) {
        for (const commit of commits) items.push(mapCommit(commit, repo.full_name));
      }
    } catch (error) {
      if (error.status === 403 || error.status === 429) {
        console.warn(`[github] 触发 API 限流，停止拉取提交（建议配置 GITHUB_TOKEN）`);
        break;
      }
      console.warn(`[github] ${repo.full_name} 提交获取失败: ${error.message}`);
    }
  }

  // PR / Issue 事件
  try {
    const events = await api(`/users/${USER}/events/public?per_page=100`);
    for (const event of events) {
      if (event.type === 'PullRequestEvent' && event.payload?.action === 'opened') {
        items.push(mapIssue(event));
      } else if (event.type === 'IssuesEvent' && event.payload?.action === 'opened') {
        items.push(mapIssue(event));
      }
    }
  } catch (error) {
    console.warn(`[github] 事件获取失败: ${error.message}`);
  }

  return items;
}
