/**
 * 平台注册表：所有平台的展示元数据（名称、图标、颜色、主页）。
 * 站点渲染与抓取器共用这一份定义。
 *
 * 主页地址在文件末尾按 config.yaml 里的账号派生，改账号只需要改配置。
 */
import { platform } from './config.mjs';

const icon = (paths, extra = '') =>
  `<svg class="picon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"${extra}>${paths}</svg>`;

/**
 * @typedef {object} Platform
 * @property {string} id          唯一标识
 * @property {string} name        显示名
 * @property {string} short       短名（用于「跳转到 xxx」）
 * @property {string} color       主题色
 * @property {string} icon        内联 SVG
 * @property {string} homepage    平台主页
 */

/** @type {Record<string, Platform>} */
export const PLATFORMS = {
  bilibili: {
    id: 'bilibili',
    name: '哔哩哔哩',
    short: '哔哩哔哩',
    color: '#fb7299',
    homepage: 'https://space.bilibili.com/3494381151586530',
    icon: icon(
      '<path d="M17.813 3.162h3.308a.5.5 0 0 1 .5.5v3.161a.5.5 0 0 1-.5.5h-3.308l-1.283 1.534a.5.5 0 0 1-.417.197h-1.406a.5.5 0 0 1-.417-.197L12.92 7.323H9.613L8.33 5.789a.5.5 0 0 0-.417-.197H6.906a.5.5 0 0 0-.417.197L5.206 7.323H1.879a.5.5 0 0 1-.5-.5V3.662a.5.5 0 0 1 .5-.5h3.308a.5.5 0 0 1 .417.197l1.283 1.534h2.226l1.283-1.534a.5.5 0 0 1 .417-.197zM7.859 10.86a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8zm8.282 0a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z"/>',
    ),
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    short: 'YouTube',
    color: '#ff0000',
    homepage: 'https://youtube.com/@toad1145',
    icon: icon(
      '<path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>',
    ),
  },
  archive: {
    id: 'archive',
    name: '互联网档案馆',
    short: '档案馆',
    color: '#4a4a4a',
    homepage: 'https://archive.org/details/@toad1145',
    icon: icon(
      '<path d="M4 4h16v3H4V4zm1 4h14l1 12H4L5 8zm4 2v2h6v-2H9zm0 4v2h6v-2H9z"/>',
    ),
  },
  retroachievements: {
    id: 'retroachievements',
    name: 'RetroAchievements',
    short: 'RA',
    // 官方是深红（#8b0000），但那个色在深色底上对比度只有 1.9，平台名几乎看不见。
    // #c73e3e 在深/浅两套主题下都够亮，看着仍然是 RA 的暗红。
    color: '#c73e3e',
    homepage: 'https://retroachievements.org/user/toad114514',
    icon: icon(
      '<path d="M7 4h10v3a5 5 0 0 1-4 4.9V14h3v2h-4v2h4v2H8v-2h4v-2H8v-2h3v-2.1A5 5 0 0 1 7 7V4zm2 2v1a3 3 0 0 0 6 0V6H9z"/>',
    ),
  },
  weblate: {
    id: 'weblate',
    name: 'Weblate',
    short: 'Weblate',
    color: '#2a6db0',
    homepage: 'https://mirror.git.trinitydesktop.org/weblate/user/toad114514/',
    icon: icon(
      '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3a15.7 15.7 0 0 0-.8-4.2A8 8 0 0 1 18.9 11zM12 4c.8 1.3 1.5 3.5 1.7 7h-3.4c.2-3.5.9-5.7 1.7-7zM4.3 13h3c.1 1.6.4 3 1 4.2A8 8 0 0 1 4.3 13zm3-2h-3a8 8 0 0 1 4-4.2A15.7 15.7 0 0 0 7.3 11zM12 20c-.8-1.3-1.5-3.5-1.7-7h3.4c-.2 3.5-.9 5.7-1.7 7zm3.7 1.2c.6-1.2.9-2.6 1-4.2h3a8 8 0 0 1-4 4.2z"/>',
    ),
  },
  github: {
    id: 'github',
    name: 'GitHub',
    short: 'GitHub',
    color: '#8b949e',
    homepage: 'https://github.com/Toad114514',
    icon: icon(
      '<path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.5 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"/>',
    ),
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    short: 'Gitee',
    color: '#c71d23',
    homepage: 'https://gitee.com/toadstool',
    icon: icon(
      '<path d="M12 2.5a9.5 9.5 0 0 0-9.5 9.5A9.5 9.5 0 0 0 12 21.5a9.5 9.5 0 0 0 8.4-5.1l-2.2-1.3a6.9 6.9 0 0 1-1.6 1.2 7.2 7.2 0 1 1 0-1.9l-4-2.3 1.2-1.5 5.6 3.3a9.4 9.4 0 0 0-1.9-1.3 7.2 7.2 0 0 1 6.7 4.7l2.3-1a9.5 9.5 0 0 0-8.5-5.6h-.9a9.5 9.5 0 0 0-3.5.7L9 4.9h3.1a9.5 9.5 0 0 1 5.6 2.4l1.4-1.7A11.4 11.4 0 0 0 12 2.5z"/>',
    ),
  },
  steam: {
    id: 'steam',
    name: 'Steam',
    short: 'Steam',
    color: '#66c0f4',
    homepage: 'https://steamcommunity.com/id/toad1145',
    icon: icon(
      '<path d="M12 2a10 10 0 0 1 9.96 9.2l-4.14 1.72a3.6 3.6 0 0 0-6.3-1.4l.02.05a3.6 3.6 0 1 0 3.3 5.1l4.2-1.75A10 10 0 1 1 12 2zm-4.3 13.9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm8.9-4.9a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z"/>',
    ),
  },
  ottohub: {
    id: 'ottohub',
    name: 'OTTOhub 滚幕网',
    short: 'OTTOhub',
    color: '#f0a500',
    homepage: 'https://www.ottohub.cn/u/22067',
    icon: icon(
      '<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm5.5 3.5v7l6-3.5-6-3.5z"/>',
    ),
  },
  kuaishou: {
    id: 'kuaishou',
    name: '快手',
    short: '快手',
    color: '#ff4906',
    homepage: 'https://www.kuaishou.com/profile/xn57ehqqzfdqie',
    icon: icon(
      '<path d="M9.6 2.5 13 6.3l3.3-1.4 2 3.4-3.3 1.4.9 4.6-3.7.7-.9-4.5-4 2.6 1 5.4-3.7.7-1-5.4-4.5 3 1.7-3.4 4.4-2.9L7.4 4l3.7-.7z"/>',
    ),
  },
  ixigua: {
    id: 'ixigua',
    name: '西瓜视频',
    short: '西瓜视频',
    color: '#f85959',
    homepage: 'https://m.ixigua.com/user/1156309825358958',
    icon: icon(
      '<path d="M12 3c2.6 3.1 4.2 5.6 5.3 7.9-2 .6-3.4 1.4-4.4 2.6 1-.5 2-.8 3.1-.8-2.4 4.3-4.1 6.6-5.2 8.3-1.1-1.7-2.6-4-4.4-8.1 2.6 0 4.8-.6 6.7-1.9-3-.6-5.1-1.8-6.4-3.6C8.4 8.2 10 5.8 12 3z"/>',
    ),
  },
  douyin: {
    id: 'douyin',
    name: '抖音',
    short: '抖音',
    color: '#111111',
    homepage:
      'https://www.douyin.com/user/MS4wLjABAAAA6PVKsXhOQnDUq6NzC0iR0Yhexul5GSzhHaBQBK7iXQQ',
    icon: icon(
      '<path d="M14.1 2h2.6c.2 1.5 1.1 2.7 2.6 3v2.6c-1.6 0-3-.5-4.2-1.4v6.3c0 4.3-3.5 7.5-7.8 7.5S2 17 2 12.7s3.5-7.5 7.8-7.5c.4 0 .8 0 1.2.1v2.7c-.4-.1-.8-.1-1.2-.1-2.6 0-4.7 2-4.7 4.5s2.1 4.5 4.7 4.5 4.8-2 4.8-4.6V2z"/>',
    ),
  },
  hexo: {
    id: 'hexo',
    name: "Toad's Blog",
    short: '博客',
    // Hexo 官方蓝；和「其他」的蓝灰、GitHub 的灰区分得开
    color: '#0e83cd',
    homepage: 'https://toad.ccwu.cc/',
    icon: icon(
      '<path d="M4 3h11l5 5v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm10 2v4h4l-4-4zM6.5 12h11v1.8h-11V12zm0 4h11v1.8h-11V16z"/>',
    ),
  },
  codemao: {
    id: 'codemao',
    name: '编程猫',
    short: '编程猫',
    /*
     * 品牌色是亮黄（#ffbe00 那种），但这个色要同时当「平台名」的文字色和
     * 时间线上的圆点：亮黄在白底上对比度只有 1.8，平台名几乎看不见
     * （和 RA 的 #8b0000 一样的坑，方向相反）。压成暗金后深色主题 6.1:1、
     * 亮色主题 3.0:1，两边都还能读，也不会跟 OTTOhub 的 #f0a500 混成一个色。
     */
    color: '#cc8b00',
    homepage: 'https://shequ.codemao.cn/mobile/user/16551623',
    // 猫头（编程猫的吉祥物是只猫）：两只耳朵 + 圆脸，眼睛用 evenodd 挖空
    icon: icon(
      '<path fill-rule="evenodd" d="M12 3.6c-4.9 0-8.6 3.3-8.6 7.5v3.1c0 3.5 3.9 6.3 8.6 6.3s8.6-2.8 8.6-6.3v-3.1c0-4.2-3.7-7.5-8.6-7.5zM4.9 5.4 3.6 1.6l4.2 2L4.9 5.4zm14.2 0-2.9-1.8 4.2-2-1.3 3.8zM9.2 10.1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5.6 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>',
    ),
  },
};

/** 平台 id 顺序（与页面展示顺序一致）。 */
export const PLATFORM_ORDER = [
  'bilibili',
  'youtube',
  'ottohub',
  'kuaishou',
  'ixigua',
  'douyin',
  'github',
  'gitee',
  'codemao',
  'archive',
  'weblate',
  'hexo',
  'retroachievements',
  'steam',
];

/**
 * 活动类型：分类页的第三个维度（年份 / 平台 / 活动类型）。
 *
 * 问的是「这条活动本身是在干嘛」：打游戏、发视频、写代码、存档资料。
 * 不是按平台归类——Weblate 虽然是「网站」，但干的事是给 TDE 翻译代码里的
 * 字符串，所以归「代码」；互联网档案馆只放东西，所以归「归档」。
 * 平台名单只在这里维护一份，页面渲染和前端筛选都走 kindOf()。
 */
export const KINDS = [
  { id: 'game', name: '游戏', color: '#c73e3e', hint: 'RetroAchievements / Steam' },
  { id: 'video', name: '视频', color: '#fb7299', hint: '哔哩哔哩 / YouTube / OTTOhub / 快手' },
  { id: 'code', name: '代码', color: '#8b949e', hint: 'GitHub / Gitee / Weblate / 编程猫' },
  { id: 'article', name: '文章', color: '#2fa46a', hint: "Toad's Blog" },
  { id: 'archive', name: '归档', color: '#4a4a4a', hint: '互联网档案馆 / 西瓜视频 / 抖音' },
  { id: 'other', name: '其他', color: '#6b7691', hint: '未归类的平台' },
];

/** 平台 → 活动类型。没登记的落到「其他」。 */
const PLATFORM_KIND = {
  retroachievements: 'game',
  steam: 'game',
  bilibili: 'video',
  youtube: 'video',
  ottohub: 'video',
  kuaishou: 'video',
  github: 'code',
  gitee: 'code',
  weblate: 'code',
  // 编程猫上那些作品就是当年写的代码/小游戏（Kitten4 源码编辑器、Nemo），
  // 归「代码」而不是「归档」：归档是按「放东西进去」算的，这里是自己做的作品。
  codemao: 'code',
  hexo: 'article',
  archive: 'archive',
  // 西瓜/抖音都停更且账号已不可用，能抓到的只是「存档」，不是新动态
  ixigua: 'archive',
  douyin: 'archive',
};

/** @returns {string} 活动类型 id（game / video / code / archive / other） */
export function kindOf(platformId) {
  return PLATFORM_KIND[platformId] ?? 'other';
}

/** 活动类型元数据；未知 id 退回「其他」。 */
export function getKind(kindId) {
  return KINDS.find((kind) => kind.id === kindId) ?? KINDS[KINDS.length - 1];
}

/** 主页地址推导：账号类信息统一以 config.yaml 为准。 */
const HOMEPAGE_BUILDERS = {
  bilibili: (c) => (c.mid ? `https://space.bilibili.com/${c.mid}` : null),
  youtube: (c) => (c.handle ? `https://youtube.com/${c.handle}` : null),
  ottohub: (c) => (c.uid ? `https://www.ottohub.cn/u/${c.uid}` : null),
  kuaishou: (c) => (c.profileId ? `https://www.kuaishou.com/profile/${c.profileId}` : null),
  // 西瓜/抖音没有抓取器（账号已停更，数据是 2026-10 一次性导入的存档），
  // 主页直接写在 PLATFORMS 里，不依赖 config。
  github: (c) => (c.user ? `https://github.com/${c.user}` : null),
  gitee: (c) => (c.user ? `https://gitee.com/${c.user}` : null),
  codemao: (c) => (c.userId ? `https://shequ.codemao.cn/mobile/user/${c.userId}` : null),
  archive: (c) => (c.user ? `https://archive.org/details/@${c.user}` : null),
  weblate: (c) => (c.baseUrl && c.user ? `${String(c.baseUrl).replace(/\/+$/, '')}/user/${c.user}/` : null),
  hexo: (c) => String(c.siteUrl || 'https://toad.ccwu.cc').replace(/\/+$/, '') + '/',
  retroachievements: (c) => (c.user ? `https://retroachievements.org/user/${c.user}` : null),
  steam: (c) => (c.steamId64 ? `https://steamcommunity.com/profiles/${c.steamId64}` : null),
};

for (const [id, build] of Object.entries(HOMEPAGE_BUILDERS)) {
  if (!PLATFORMS[id]) continue;
  const url = build(platform(id));
  if (url) PLATFORMS[id].homepage = url;
}

export function getPlatform(id) {
  return PLATFORMS[id] ?? {
    id,
    name: id,
    short: id,
    color: '#888',
    homepage: '#',
    icon: icon('<circle cx="12" cy="12" r="9"/>'),
  };
}

/** 平台图标的内联 SVG 字符串。 */
export function platformIcon(id) {
  return getPlatform(id).icon;
}
