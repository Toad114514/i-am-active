/**
 * GitHub 活跃数据：提交 / 新建仓库 / 新建 PR / 新建 Issue。
 *
 * 输出的是「汇总条目」而不是逐条记录：同一次连续工作里对同一个仓库的
 * 所有操作并成一张卡（按仓库分组，组内按时间空档再切），明细放在卡片里
 * 可翻页查看，版式与 Weblate 的译文汇总一致。分组逻辑见 lib/digest.mjs。
 *
 * 关键点（实测）：
 *  - `/users/<u>/events/public` 的 PushEvent 里 `payload.commits` 恒为空数组，
 *    拿不到提交信息，所以提交改走 `/repos/<owner>/<repo>/commits?author=`。
 *  - 匿名 API 限流 60 次/小时；配置 GITHUB_TOKEN 后为 5000 次/小时。
 *  - 汇总条目每次都要用完整时段重算（只取增量会把条数算错，同一时段也会
 *    因为起点变化而反复换 id），所以这里**不按 since 过滤**，而是固定回看
 *    `lookbackDays` 天，代价只是每个仓库一次请求，和以前一样。
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';
import { buildRepoDigests } from '../lib/digest.mjs';

const github = platform('github');
const USER = String(github.user);
/** 单页最多 100 条（GitHub 上限）。 */
const PER_PAGE = Math.max(1, Math.min(100, Number(github.perPage) || 100));
/** 每个仓库最多翻几页，防止一次历史特别长的仓库把限流配额吃光。 */
const MAX_PAGES = Math.max(1, Number(github.maxPages) || 2);
/**
 * 汇总窗口（天）。0 = 全历史。
 *
 * 仓库卡是「这个仓库的全部操作」，所以默认不限时间：带上 since 的话，
 * 窗口边界每天推进一点，卡里最老的那几条提交会一天天静默消失。
 */
const LOOKBACK_DAYS = Math.max(0, Number(github.lookbackDays) || 0);
const LOOKBACK_MS = LOOKBACK_DAYS * 86400_000;
/** 同一仓库相邻两次操作的间隔超过这个值，就算另一次「动工」。 */
const SESSION_GAP_MS = Math.max(1, Number(github.sessionGapMinutes) || 90) * 60_000;
/** 单张卡最多保留多少条明细。 */
const MAX_ROWS = Math.max(1, Number(github.maxRows) || 300);
/** 最多查多少个有推送的仓库。 */
const MAX_REPOS = Math.max(1, Number(github.maxRepos) || 25);

let lastDiagnostics = null;

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

/** 仓库主页（汇总卡的标题链接、明细的兜底链接都用它）。 */
function repoHome(fullName) {
  return `https://github.com/${fullName}`;
}

function repoCreateAction(repo) {
  return {
    uid: `repo:${repo.id}`,
    repo: repo.full_name,
    repoUrl: repoHome(repo.full_name),
    kind: '新建仓库',
    ts: Date.parse(repo.created_at ?? ''),
    text: repo.name,
    component: repo.language ?? null,
    url: repo.html_url,
  };
}

function commitAction(commit, fullName) {
  const message = String(commit.commit?.message ?? '').split('\n')[0].trim();
  const date = commit.commit?.author?.date ?? commit.commit?.committer?.date ?? null;
  const sha = String(commit.sha ?? '');
  return {
    uid: `commit:${sha}`,
    repo: fullName,
    repoUrl: repoHome(fullName),
    kind: '提交',
    ts: Date.parse(date ?? ''),
    text: message,
    component: sha ? sha.slice(0, 7) : null,
    url: commit.html_url ?? `${repoHome(fullName)}/commits`,
  };
}

function issueAction(event) {
  const payload = event.payload ?? {};
  const isPr = Boolean(payload.pull_request);
  const issue = payload.issue ?? {};
  const number = issue.number;
  return {
    uid: `${isPr ? 'pr' : 'issue'}:${issue.id ?? event.id}`,
    repo: event.repo?.name ?? '',
    repoUrl: event.repo?.name ? repoHome(event.repo.name) : null,
    kind: isPr ? '新建 PR' : '新建 Issue',
    ts: Date.parse(event.created_at ?? ''),
    text: issue.title ?? '',
    component: number ? `#${number}` : null,
    url: issue.html_url ?? repoHome(event.repo?.name ?? USER),
  };
}

/** 拉一个仓库的提交；commits 为 null 表示没取全（撞限流或请求出错），本轮应跳过这个仓库。 */
async function fetchCommits(fullName, sinceIso) {
  const commits = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let batch;
    try {
      const since = sinceIso ? `&since=${encodeURIComponent(sinceIso)}` : '';
      batch = await api(
        `/repos/${fullName}/commits?author=${USER}&per_page=${PER_PAGE}&page=${page}${since}`,
      );
    } catch (error) {
      if (error.status === 403 || error.status === 429) return { commits: null, rateLimited: true };
      // 其它错误同样算「没取全」：宁可这轮不更新这张卡，也不能用缺页的数据覆盖它
      console.warn(`[github] ${fullName} 提交获取失败（本轮跳过该仓库）: ${error.message}`);
      return { commits: null, rateLimited: false };
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    commits.push(...batch);
    // 没取满一页说明已经到底；取满才继续翻
    if (batch.length < PER_PAGE) break;
  }
  return { commits, rateLimited: false };
}

/**
 * @returns {Promise<Array<object>>} 汇总条目（meta.merge = true）
 */
export async function fetchGitHub() {
  const cutoff = LOOKBACK_DAYS > 0 ? Date.now() - LOOKBACK_MS : Number.NEGATIVE_INFINITY;
  // 多要两天：窗口边界上的时段可能被截断，只保留「确实在窗口内结束」的，
  // 免得时段起点随抓取边界漂移，把同一批工作拆成两张卡。
  const safetyStart = Number.isFinite(cutoff) ? cutoff - 2 * 86400_000 : Number.NEGATIVE_INFINITY;
  const sinceIso = Number.isFinite(safetyStart) ? new Date(safetyStart).toISOString() : null;
  const actions = [];
  const diag = {
    lookbackDays: LOOKBACK_DAYS || 0,
    repos: 0,
    commits: 0,
    events: 0,
    truncated: 0,
  };

  let repos = [];
  try {
    repos = await api(`/users/${USER}/repos?per_page=100&sort=pushed&type=owner`);
    if (!Array.isArray(repos)) repos = [];
  } catch (error) {
    console.warn(`[github] 仓库列表获取失败: ${error.message}`);
    diag.error = error.message;
  }
  diag.repos = repos.length;

  // 新建仓库：fork 不算自己的创作
  for (const repo of repos) {
    if (repo.fork) continue;
    const created = Date.parse(repo.created_at ?? '');
    if (Number.isFinite(created) && created >= cutoff) actions.push(repoCreateAction(repo));
  }

  // 提交：仓库列表本身已按推送时间倒序，取最近动过的一批
  const candidates = repos
    .filter((repo) => {
      const pushed = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
      return pushed >= cutoff;
    })
    .slice(0, MAX_REPOS);

  let rateLimited = false;
  for (const repo of candidates) {
    const { commits, rateLimited: hit } = await fetchCommits(repo.full_name, sinceIso);
    if (hit) {
      console.warn('[github] 触发 API 限流，停止拉取提交（建议配置 GITHUB_TOKEN）');
      rateLimited = true;
      break;
    }
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
  if (rateLimited) diag.rateLimited = true;

  // PR / Issue：事件流只保留最近 90 天，窗口超出这个范围就只能拿到最近的
  try {
    const events = await api(`/users/${USER}/events/public?per_page=100`);
    if (Array.isArray(events)) {
      for (const event of events) {
        const action = event.type === 'PullRequestEvent' && event.payload?.action === 'opened'
          ? issueAction(event)
          : event.type === 'IssuesEvent' && event.payload?.action === 'opened'
            ? issueAction(event)
            : null;
        if (action && Number.isFinite(action.ts) && action.ts >= cutoff) {
          actions.push(action);
          diag.events += 1;
        }
      }
    }
  } catch (error) {
    console.warn(`[github] 事件获取失败: ${error.message}`);
    diag.eventsError = error.message;
  }

  const digests = buildRepoDigests({
    platform: 'github',
    actions: actions.filter((action) => action.ts >= safetyStart),
    gapMs: SESSION_GAP_MS,
    maxRows: MAX_ROWS,
    type: '仓库活动',
  });

  // 只为「窗口内结束」的时段出卡：起点更早的时段可能被窗口截断，
  // 交给上一轮已经落库的那张卡继续用，不重新生成。
  const settled = digests.filter((digest) => Date.parse(digest.meta.windowEnd) >= cutoff);
  diag.digests = settled.length;
  diag.actions = actions.length;
  lastDiagnostics = diag;
  return settled;
}

export function lastGitHubDiagnostics() {
  return lastDiagnostics;
}
