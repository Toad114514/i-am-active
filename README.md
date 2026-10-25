# 棍母
请查阅 Github Page 观看aaa

100% Vibe-Coding 项目aaa

## 配置

所有平台的账号、开关、抓取参数都在根目录 `config.yaml`，脚本里不再写死。

```bash
npm run collect -- --show-config   # 看解析后的配置（密钥自动打码）
npm run collect -- --dry-run       # 只抓不写，先看会新增什么
npm run update                     # 抓取 + 生成站点
```

几条规则：

- `enabled: false` 的平台会被完全跳过，其它平台不受影响。
- 值里可以写 `${环境变量名}`，运行时替换；写 `${VAR:-默认}` 则变量缺省时用默认值。
  密钥请这样引用，不要直接写进仓库。
- 启用的平台必须填齐必填项（例如 `bilibili.mid`），缺了会在启动时报错并指明是哪个键。
- 想换配置文件位置：`CONFIG_FILE=/path/to/config.yaml npm run collect`。

### 需要配置的密钥（GitHub Actions 里存成同名 Secret）

| 变量 | 用在哪 | 说明 |
| --- | --- | --- |
| `RA_API_KEY` | RetroAchievements | 在 <https://retroachievements.org/settings> 的 Keys 区域生成 Web API Key。**没有它该平台会直接跳过**（官方 API 必须带 key，网页有 Cloudflare 挑战，没有免 key 的退路） |
| `GITHUB_TOKEN` | GitHub | 不配只有 60 次/小时，很容易限流；配了 5000 次/小时 |
| `YT_API_KEY` | YouTube | 可选。配了走 Data API v3，不配走频道 RSS（RSS 无需密钥） |
| `STEAM_API_KEY` / `STEAM_ID64` | Steam | 可选，默认 `enabled: false` |
| `KUAISHOU_COOKIE` | 快手 | 作品列表需要登录态，没有 cookie 只能拿到作品数变化提示 |

### RetroAchievements 的去重

RA 的 API 只能给出「最近一段时间解锁的成就」，看不出哪条是新的，所以除了
`res/list.json` 的 id 去重，还会把新成就追加进 `res/ralist.json` 留档：

```json
{ "id": "retroachievements:98012:2026-10-25 09:30:00", "title": "Beginner I", "gameTitle": "Pokemon Pinball mini", "unlockedAt": "2026-10-25T09:30:00Z" }
```

抓取窗口由 `lookbackDays` 控制（首轮默认回溯 60 天），之后每次运行会用
`res/state.json` 里记录的上次时间自动收窄查询范围，避免重复拉一大批旧数据。

### Steam 的抓取范围

Steam 没有「我最近解锁了什么成就」这种接口，只能按 AppID 逐个查，所以流程是：

1. `IPlayerService/GetRecentlyPlayedGames` 拿到**最近两周玩过的游戏**（按两周时长排序，
   接口本身就固定两周，不能自定义区间）；
2. 对这些 AppID 逐个调 `ISteamUserStats/GetPlayerAchievements`；
3. 只把解锁时间落在「上次抓取时间 → 现在」之间的成就写进列表，首轮回退 14 天。
   这样第一次跑不会把某款游戏攒了几年的成就一次性灌进来。

相关的三个旋钮：`steam.recentGames`（关掉就只查 `extraAppIds`）、
`steam.maxGames`（单轮最多查几款，默认 10）、`steam.maxItems`（单轮最多写几条，默认 60）。
`extraAppIds` 用来长期跟踪某款想持续关注的老游戏。

前提是个人资料「游戏详情」设为公开，否则 `GetRecentlyPlayedGames` 只会返回空的
`{"response":{}}`——脚本会打一条提示，看起来像「没数据」而不是报错。

## 自动更新与部署

`.github/workflows/update.yml` 每 2 小时跑一次（`0 */2 * * *`），也可以在
Actions 页面点 **Run workflow** 手动触发；推到 `main` 时也会重建一次。

一次运行做四件事：抓取各平台 → 有新增就把 `res/*.json` 提交回 `main` →
生成 `dist/` → 部署到 GitHub Pages。只有 `res/` 真的变了才会产生提交，
所以不会每 2 小时堆一个空 commit。

首次启用需要两个一次性设置：

1. **Settings → Pages → Source 选 GitHub Actions**（不是分支，否则 `deploy-pages` 会报 `Get Pages site failed`）。
2. **Settings → Secrets and variables → Actions** 里加上表里的密钥。`GITHUB_TOKEN` 由 Actions 自动提供，不用手动建。

私密平台数据（`res/`）是用工作流自带的 `GITHUB_TOKEN` 提交的，这类提交不会再次
触发工作流，因此不存在自激循环；`concurrency` 也限制了同一时刻只有一个实例在写数据。
