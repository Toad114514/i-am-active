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
