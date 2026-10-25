/**
 * 站点静态资源：HTML 模板、CSS、前端 JS。
 *
 * 页面结构（对应需求）：
 *  - 主页：标题 + 斜体副标题 + 右上角小导航（搜索 / 分类）
 *  - 列表：紧凑条目，左上角平台图标+名称+时间，正文标题+1-3 行简介，右下角「跳转到 xxx」
 *  - 有图片时，条目整体向右挤，左侧用渐变图片与背景融合
 *  - 分页：每页最多 20 条，页码靠右
 *  - 分类页：左侧分类选项，右侧结果
 *  - 页脚：看过人数、监视时长、GitHub 链接、当前时间
 */

export const SITE = {
  title: '蟾蜍在互联网上的活跃记录',
  subtitle: 'Toad114514 的跨平台活跃存档 · 由 GitHub Actions 每小时自动巡检',
  description:
    '汇总哔哩哔哩、YouTube、OTTOhub、快手、GitHub、Gitee、互联网档案馆、Weblate、RetroAchievements、Steam 等平台上的最新动态。',
  repoUrl: 'https://github.com/Toad114514/i-am-active',
  authorUrl: 'https://github.com/Toad114514',
  owner: 'Toad114514',
};

export const PAGE_SIZE = 20;

/** 转义 HTML。 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 站内链接（相对路径，兼容 GitHub Pages 子路径部署）。 */
export function link(base, path) {
  const clean = String(path).replace(/^\/+/, '');
  return clean ? `${base}${clean}` : base || './';
}

/** 格式化时间显示。 */
export function formatTime(iso, { withDate = true } = {}) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes >= 0 && minutes < 60) return `${Math.max(minutes, 1)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 0 && hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days >= 0 && days < 30) return `${days} 天前`;

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withDate ? `${ymd} ${hm}` : ymd;
}

/** ISO 时间戳 → datetime 属性。 */
export function isoAttr(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** 年份（按本地时区）。 */
export function yearOf(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.getFullYear();
}
