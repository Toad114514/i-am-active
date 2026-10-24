# 简介
这是一个用于展示我在各个互联网平台的活跃详情的页面，使用 Github Page 部署，静态网页框架未决定

# 界面布局和基础逻辑
 - 主页
   - 开头部分显示标题和副标题，副标题使用斜体，整个页面的右上角添加一个小导航，搜索，分类都在这
   - 列表，每一个项目较紧凑，列表的左上角用一个图标和文字显示对应的社交平台名称，紧跟着的是发布的时间。正文一个标题和 1-3 行的简介，右下角显示跳转到xxx，整个列表点击可以跳转到对应的页面。如果有图片那么整个框架右边挤，并在左边显示一个渐变的图片与背景融合
   - 分页，一个页面最多显示 20 个列表，页面导航靠右边显示
   - 结尾写上有多少人看过，开始监视了多久，我的 Github 链接和当前时间
 - 分类
   - 允许按年份，社交平台分类
   - 分类页面，在左边显示分类的选项，右边显示结果

# 列表
  - 在项目根目录下存放一个 res/list.json 的列表，他代表了这个活跃页面的列表每一个项目。之后添加新内容则是直接向这个列表前面追加

# 更新
  - 每2小时通过 Github Action 自动检测遍历所有的社交平台的活动，检测到有新活动时直接向 res/list,json 追加，追加之后再根据其生成网站，最后部属到 Github Pages
  - Action 也可通过手动触发

# 社交检测
  - 所有的社交媒体的查询逻辑都分开来。返回的是新的活动，如没有新的活动则返回空白表
  - 检测的平台及方案
    - Bilibili 本人动态，Rest api
      - 参考API文档 https://github.com/pskdje/bilibili-API-collect
    - Youtube 发布的视频，应该有api没有就换成网页
    - 互联网档案馆活跃数据，包括新增的details
      - 参考API https://archive.org/developers/index-apis.html，如果没啥用换成网站抓取
      - 账户 https://archive.org/details/@toad1145
    - RetroAchievements 本人的近期的获取成就
      - 这个比较特殊，只通过他们提供的 API 并不能判断获取了什么新的成就
      - 通过 res/ralist.json 来保存最近获取的成就，比对api返回的内容是否存在，如果存在则已拿过在列表写入了，跳过，没有则写入到 res/ralist.json 追加
      - 参考API https://api-docs.retroachievements.org/
    - Weblate 我在 TDE 项目最近翻译的译文
      - 接口 https://mirror.git.trinitydesktop.org/weblate/api/
      - 文档 https://docs.weblate.org/zh-cn/weblate-4.18.2/api.html
    - Github 本人的活跃数据，包括提交/创建仓库/新建pr/新建issues
    - Gitee 本人的活跃数据，只查提交 https://gitee.com/toadstool
    - Steam 的成就获取数据（maybe）
    - OttoHub 更新的视频，网页抓取, https://www.ottohub.cn/u/22067
    - 快手更新的短视频, 网页抓取，https://www.kuaishou.com/profile/3xn57ehqqzfdqie
