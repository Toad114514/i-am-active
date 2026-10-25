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
- 启用的平台请填齐必填项（例如 `bilibili.mid`）。缺了不会让整轮任务失败：该平台会被
  跳过，日志里点名缺的是哪个键，其它平台照常抓取、站点照常部署。
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

但窗口有个下限 `minWindowMinutes`（默认 4320 = 3 天）：`lastRun` 在抓取失败时也会往前走，
如果某天 key 没配、被 401 打回来，窗口会一路缩到只剩两小时，那几天解锁的成就就永远补不回来。
每轮多回看几天只多花一次请求，id 稳定，去重不会产生重复条目。

### RetroAchievements 的游玩记录

`API_GetUserRecentAchievements` 只回「解锁了什么」。一场**没解锁成就**的游戏
（或者模拟器没开成就检测、用了别人的存档、ROM 版本没被追踪）在列表里完全看不见，
表现就是「昨天明明玩了 B3313，站点上却什么都没有」。所以还会顺带调
`API_GetUserRecentlyPlayedGames` 补一条**游玩记录**：

```json
{ "id": "retroachievements:play:12345:2026-10-24 09:30:00", "title": "玩了《B3313》" }
```

id 里带 `LastPlayed`，同一场游戏重复抓取只会命中同一条；换个时间再玩是新的一条。
旋钮：`retroachievements.playSessions`（关掉就只记成就）、`maxGames`（单轮最多看几款，默认 10）。

### RetroAchievements 排障

抓不到东西时 RA 不会报错，只会回空数组，所以每轮的现场信息会写进
`res/state.json` 的 `diagnostics.retroachievements`：key 有没有配（只记打码后的提示和长度）、
用户名校验过不过、窗口多少分钟、两个接口各自的原始条数 / 采用条数 / 错误信息。
看这一段就能分清是「没配 key」「key 失效」还是「窗口里真的没活动」。

本地自检（只读，不写 `res/`，也不打印 key）：

```bash
RA_API_KEY=xxxx node scripts/ra-doctor.mjs                 # 看最近 7 天
RA_API_KEY=xxxx node scripts/ra-doctor.mjs --minutes 43200  # 往前看 30 天
```

### Steam 的抓取范围

Steam 没有「我最近解锁了什么成就」这种接口，只能按 AppID 逐个查，所以流程是：

1. `IPlayerService/GetRecentlyPlayedGames` 拿到**最近两周玩过的游戏**（按两周时长排序，
   接口本身就固定两周，不能自定义区间）；
2. 用 `IPlayerService/GetOwnedGames` 补出 `rtime_last_played`（**最近游戏这个接口不返回这个
   字段**，只有 appid / 名称 / 时长），判断「这次会话是不是新的」，是就写一条**游玩记录**；
3. 对这些 AppID 逐个调 `ISteamUserStats/GetPlayerAchievements`，解锁时间落在
   「上次抓取时间 → 现在」之间的成就也写进列表，首轮回退 14 天。

第 3 步有两个容易踩的坑，都已处理：

- 这个接口的字段是 **`achieved` / `unlocktime`**，不是 `unlocked` / `unlockedtime`。
  按后者读会得到 `undefined`，每条成就都被当成「没解锁」，安静地一条都不写。
- 它只给 `apiname`（内部标识，形如 `ACH_WIN_ONE_GAME`），**不给**中文名和描述。
  所以真要写成就时会再调一次 `ISteamUserStats/GetSchemaForGame`，把
  `apiname → displayName / description / icon` 补上；拿不到就退回 `apiname`。

第 2 步是必要的：只启动游戏、坐在主菜单里没解锁任何成就是常态，只靠成就会一条都抓不到。
游玩记录的 id 是 `steam:play:<appid>:<会话时间>`，同一次会话重复运行不会重复写入；
也刻意不用「两周时长增量」当信号，否则后台一直挂着的游戏每轮都会涨，站点会被刷屏。

相关的几个旋钮：`steam.recentGames`（关掉就只查 `extraAppIds`）、
`steam.playSessions`（关掉就只记成就）、`steam.maxGames`（单轮最多查几款，默认 10）、
`steam.maxItems`（单轮最多写几条，默认 60）。
`extraAppIds` 用来长期跟踪某款想持续关注的老游戏。

前提是个人资料「游戏详情」设为公开，否则 `GetRecentlyPlayedGames` 只会返回空的
`{"response":{}}`——脚本会打一条提示，看起来像「没数据」而不是报错。

**成就接口对隐私的要求比游玩记录更严。** 实测：同一个 key，`GetOwnedGames` /
`GetRecentlyPlayedGames` 都能拿到数据，但 `GetPlayerAchievements` 直接回
`HTTP 403 {"playerstats":{"error":"Profile is not public"}}`。这时候游玩记录照常写，
只有成就是空的，所以别把它当成代码坏了。去 编辑个人资料 → 隐私设置，把
「我的个人资料」和「游戏详情」**都**设成公开；只开「游戏详情」不够。

另一个容易踩的坑：**游戏还开着的时候，Steam 往往要等你退出后才把这次会话同步到接口**。
所以刚启动游戏就触发抓取，很可能 `total_count=0` 或者「上次游玩」还是上一回的时间。
关掉游戏、等一两分钟再跑就正常了。日志里每款游戏都会打一行
「两周 X / 总计 Y / 上次游玩 Z」，对着看就知道是没同步还是真没玩。

排障可以直接跑自检，它把同一套请求在本地执行一遍并解释结果（只读，不写 `res/`）：

```bash
STEAM_API_KEY=xxx STEAM_ID64=7656119xxxxxxxxxx npm run steam:doctor
```

`steamId64` 是 17 位数字，超过 JS 的安全整数范围（2^53），所以配置层会把它保留成
字符串；写成不带引号的整数也不会被改成浮点。

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
