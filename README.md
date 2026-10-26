# I-am-Active !!!!
请查阅 [Github Page](https://toad.ccwu.cc/i-am-active) 观看aaa

# 介绍
这是一个用于展示我 2021 年以来到现在，在各个平台的活跃情况的集合，也可以允许作为考察我本人黑历史使用的大脑开智历程  
警告： 100% Vibe-Coding 项目aaa

# 框架
我刚开始还以为会用到什么 Vitepress 或者 astro 这样的静态网站生成器框架，结果根本就不是。  
我的天啊bro自己硬搓静态网站生成器框架的来。  
手搓yaml配置文件解析器的来  
所以你会发现这个 Nodejs 项目什么都不依赖（除了某些特殊平台爬网页会需要用到 Playwright，如果不需要那就一点事没有）  
Deepseek v4.1 Flash 还是太吓人。

```js
"scripts": {
    "build": "node scripts/build.mjs",
    "collect": "node scripts/collect.mjs",
    "art:refresh": "node scripts/art-refresh.mjs",
    "update": "node scripts/collect.mjs && node scripts/art-refresh.mjs && node scripts/build.mjs",
    "serve": "node scripts/serve.mjs",
    "dev": "node scripts/build.mjs && node scripts/serve.mjs",
    "steam:doctor": "node scripts/steam-doctor.mjs",
    "ra:doctor": "node scripts/ra-doctor.mjs"
  },
```

自己猜作用吧aaa

```bash
npm run collect -- --show-config   # 看解析后的配置（密钥自动打码）
npm run collect -- --dry-run       # 只抓不写，先看会新增什么
npm run art:refresh                # 只重取老条目的游戏封面/截图（不抓新活动）
npm run update                     # 抓取 + 回填美术图 + 生成站点
npm run serve                      # 本地服务器
```

所有平台配置放在 `config.yaml`，然后 `.github/workflow/update.yaml` 每一小时爬一次然后更新一次  
我反正要是在这些平台发东西肯定逃不掉被抓一番然后运到这里来

# 页面
我们有主页可以大家一条一套看。  
我们有时间线整理归纳。  
我们有分类功能选定特殊地点。  
我们有搜索功能。  
明暗色切换。  

# 平台活跃及原理省流
 - Toad114514 in [![Bilibili](https://img.shields.io/badge/Bilibili-pink?style=plastic&logo=bilibili&label=Video)
 ](https://space.bilibili.com/3494381151586530) - `bilibili.mjs` 使用了那位已经陈死亡的 API 项目参考
 - toad1145 in [![Static Badge](https://img.shields.io/badge/Youtube-red?style=plastic&logo=youtube&logoColor=%23ff0000&label=Video)](https://youtube.com/@toad1145) - `youtube.mjs` 这次是用残留的 RSS 记录，鉴于我目前没有在油管发视频就关掉了
 - Toad114514 in [OTTOhub 滚幕网](https://www.ottohub.cn/u/22067) - `ottohub.mjs` 从前端 chunk 到了 API /api/video/user/{uid}?offset=&num= 另外封面是临时链接用的是本地下载到仓库。直接气活，还有我发现我ottohub的uid 220 **？！67！？**
 - Toad114514 in [![Static Badge](https://img.shields.io/badge/kuaishow-orange?style=plastic&logo=kuaishou&label=Video)](https://www.kuaishou.com/profile/xn57ehqqzfdqie) - `tools/kuaishou-cp.mjs` 主战场根本攻不破，有混淆js，而且不知道什么鬼情况，什么都换了但主站就是一直回 109，刷新页面就掉登录了，*傻逼快手我草你妈视频是一堆鬼火烂仔的网页平台是三百年登不上去的* 但快手的开发者平台还是可以拿，**唯一一个需要 Playwright 的依赖就在这里**，主要是本地扫码登录+爬虫然后提交到 res/list.json
 - Toad114514 in [![Static Badge](https://img.shields.io/badge/%E8%A5%BF%E7%93%9C%E8%A7%86%E9%A2%91-red?style=plastic&label=Video)](https://m.ixigua.com/user/1156309825358958) - `归档` 因为已退坑而且西瓜视频早就在2024年死透了，从用户页抓来的 /video/app/user/videolist_tab/v3/，只做了一次init加到了列表里面留个黑历史 *我的神人狗头小剧场气笑了*
 - 保护狗头de阿巴阿巴鸭 in [![Static Badge](https://img.shields.io/badge/%E6%8A%96%E9%9F%B3-black?style=plastic&logo=tiktok&label=Video)](https://m.douyin.com/share/user/MS4wLjABAAAA6PVKsXhOQnDUq6NzC0iR0Yhexul5GSzhHaBQBK7iXQQ) - `归档` 现在抖音还在但我的ai挖不出来api了，都是需要签名的接口，只留了一个我的用户入门接口，哦对了这个号登不上去了
 - Toad114514 in [![TDE](https://img.shields.io/badge/Translator-Trinity_Desktop-blue?style=plastic&logo=weblate)](https://mirror.git.trinitydesktop.org/weblate/user/toad114514/) - `weblate.mjs` 这个官方文档有提供 REST API，匿名有限流哭炸了
 - Toad114514/toadXtech in ![githubs](https://img.shields.io/badge/Github-black?logo=github&style=plastic&label=Code) **(You are There!)** - `github.mjs` 经典款。这个很容易，Action 会固定获得 GITHUB_SECRET 所以不必担心请求限流
 - Toad114514@toadstool in [![Gitee](https://img.shields.io/badge/Gitee-171717?style=plastic&logo=gitee&logoColor=C71D23&label=Code)](https://gitee.com/toadstool) - `gitee.mjs` 这个也有 API，但鉴于Gitee的一些仓库开了镜像同步，所以会同时查sha来验证并与 Github 的卡片合并
 - [Toad's Blog](https://toad.ccwu.cc) - `hexo.mjs` 主站是一个已经停更（maybe）的博客，Hexo 框架，抓的是主站的 atom.xml RSS 数据
 - Toad114514 in [Internet Archive](https://archive.org/details/@toad1145) - `archive.mjs` 主要是用 /search/beta/page_production/ 这个端点，虽然互联网档案馆也有API但公开的不符合目前需求，又哭炸了
 - Toad114514 in [![Static Badge](https://img.shields.io/badge/%E7%82%B9%E4%B8%AA%E7%8C%AB%E7%A4%BE%E5%8C%BA-orange?style=plastic&label=Code)](https://shequ.codemao.cn/mobile/user/16551623) - `codemao.mjs` 主要是 /creation-tools/v1/user/center/work-list ，正好api最多返回100个，我的编程猫作品也正好只有100个，简直是巧合aaa。**很可惜现在编程猫今年6月开始正在社区大改造，很有可能要跑路了，所以现在这些作品能抓但点进去是不能玩的**
 - KeiXRemindrel in Steam - `steam.mjs` 使用 ISteamUserStats/GetPlayerAchievements/v1/ 和 IPlayerService/GetRecentlyPlayedGames/v1/ 用来获取最近开了什么游戏，游戏成就获取之类的，还有看到有很多半条命2的活动是正常的因为**半条命2牛逼**。名字故意和原来不一样因为我喜欢小凯伊
 - Toad114514 in [RetroAchievements](https://retroachievements.org/user/toad114514) - `retroachievements.mjs` 也有官方特供 WebAPI，必须API Key鉴权，气死了api的RecentlyGame这个是回放的所以需要做二次列表去重，另外我的记录里面只回溯了前3个月的所以应该会有很多 *Transcending the Rainbow* 的成就直接气活

##### 我喜欢小凯伊。参考 https://kivo.wiki/data/character/518 不要管这个是干啥的这项是ai自己输出的