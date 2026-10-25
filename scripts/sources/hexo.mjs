/**
 * 主站博客（Hexo + Butterfly）：https://toad.ccwu.cc/
 *
 * 数据源就是 hexo-generator-feed 生成的 Atom：`https://toad.ccwu.cc/atom.xml`。
 * 其它常见路径（/rss.xml /feed.xml /rss2.xml /feed/ /index.xml）在这个站上全是 404，
 * 只有 atom.xml 有内容（整站 25 篇文章，feed 全量覆盖，和 sitemap 对得上）。
 *
 * 两个坑：
 * 1. feed 里的链接是 `http://toad114514.github.io/...`（部署时没改 url），
 *    展示统一换成自定义域 toad.ccwu.cc（SITE）。
 * 2. 正文首图多为图床外链（imgtp.com / 3001.net / githubusercontent），
 *    **imgtp.com 已经 403 了**（带不带 Referer 都 403，图床跑路）。
 *    所以首图沿用 OTTOhub 的做法：抓取时就地下载到 res/media/hexo/，
 *    下载不到（403 / 非图片 / 太小）就干脆不带图，别让页面挂个破图。
 *    已经落地过的跳过，之后每轮抓取不会再发图片请求。
 *
 * 不做 since 过滤：文章最新一篇是 2024-08，比任何 lastRun 都早，
 * 按增量过滤会一条都进不来；条目按 id 去重，重复返回不产生重复记录。
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { http } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';
import { MEDIA_DIR } from '../lib/store.mjs';

const CONF = platform('hexo');
const FEED_URL = String(CONF.feedUrl || 'https://toad.ccwu.cc/atom.xml');
/** feed 里的链接统一换成这个域名。 */
const SITE = String(CONF.siteUrl || 'https://toad.ccwu.cc').replace(/\/+$/, '');

const COVER_DIR = 'media/hexo';
const COVER_ABS_DIR = path.join(MEDIA_DIR, 'hexo');

const ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&nbsp;': ' ',
  '&amp;': '&',
};

/** XML/HTML 实体解回文本（&amp; 放最后，避免二次解码）。 */
function decode(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(?:lt|gt|quot|#39|#x27|#x2F|nbsp|amp);/g, (m) => ENTITIES[m] ?? m);
}

/** 正文 → 纯文本摘要。 */
function toPlainText(html) {
  let text = String(html).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Hexo 的 content 里可能塞着「已被转义过的标签」(&lt;b&gt;)，先剥一层、
  // 解码后再剥一层才能把它们全部去掉，否则摘要里会漏出原始 HTML。
  for (let round = 0; round < 2; round += 1) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    text = decode(text);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** ISO 时间串；1970 之类的假时间视为无效（Hexo 没写 date 的页面会落到 1970）。 */
function isoOrNull(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).getUTCFullYear() < 2000 ? null : new Date(time).toISOString();
}

/** 取正文里第一张图，转成绝对地址。 */
function firstImage(content, link) {
  const src = content.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  if (!src) return null;
  try {
    return new URL(decode(src), link).href;
  } catch {
    return null;
  }
}

/** 文章路径 → 封面文件名（/2024/08/20/termux-all/ → termux-all）。 */
function slugOf(pathname) {
  const parts = String(pathname).split('/').filter(Boolean);
  return (parts.at(-1) || 'index').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
}

function extOf(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

async function alreadyMirrored(slug) {
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    try {
      const info = await stat(path.join(COVER_ABS_DIR, `${slug}.${ext}`));
      if (info.size > 512) return `${COVER_DIR}/${slug}.${ext}`;
    } catch {
      /* 不存在，试下一个后缀 */
    }
  }
  return null;
}

/** 首图落地；拿不到就返回 null（条目不带图，页面走图标背景）。 */
async function mirrorCover(slug, url) {
  if (!slug || !url) return null;
  const existing = await alreadyMirrored(slug);
  if (existing) return existing;

  try {
    // 注意别带 Referer：3001.net 这类图床对带 Referer 的外链直接 403，
    // 不带反而正常。localhost/自定义域都不是它的白名单。
    const response = await http(url, { timeoutMs: 20000, retries: 1 });
    const type = response.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error(`不是图片（${type || '无 content-type'}）`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) throw new Error(`内容太小（${buffer.length} 字节）`);
    const ext = extOf(type);
    await mkdir(COVER_ABS_DIR, { recursive: true });
    await writeFile(path.join(COVER_ABS_DIR, `${slug}.${ext}`), buffer);
    return `${COVER_DIR}/${slug}.${ext}`;
  } catch (error) {
    // 图床跑路（403）属正常情况，不刷成错误
    console.warn(`[hexo] 首图 ${slug} 不可用：${error.message}`);
    return null;
  }
}

/** 解析 Atom（零依赖，正则够用：hexo-generator-feed 的输出格式很固定）。 */
function parseFeed(xml) {
  const entries = [];
  const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    const title = decode(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || '').trim();
    const link = decode(block.match(/<link[^>]*href="([^"]+)"/)?.[1] || '').trim();
    const contentRaw = block.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '';
    entries.push({
      title,
      link,
      published: block.match(/<published>([\s\S]*?)<\/published>/)?.[1] || '',
      updated: block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] || '',
      content: contentRaw.trim(),
      tags: [...block.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => decode(m[1])),
    });
  }
  return entries;
}

/**
 * @returns {Promise<Array<object>>}
 */
export async function fetchHexo() {
  let xml;
  try {
    const response = await http(FEED_URL, {
      timeoutMs: 25000,
      retries: 2,
      headers: { Accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
    });
    xml = await response.text();
  } catch (error) {
    console.warn(`[hexo] Atom 抓取失败：${error.message}`);
    return [];
  }

  const entries = parseFeed(xml);
  const items = [];

  for (const entry of entries) {
    let pathname = null;
    try {
      pathname = new URL(entry.link).pathname;
    } catch {
      /* 链接异常，跳过 */
    }
    if (!pathname) continue;

    const slug = slugOf(pathname);
    const plain = toPlainText(entry.content);
    const tags = [...new Set(entry.tags.filter(Boolean))];

    items.push({
      id: `hexo:${pathname}`,
      platform: 'hexo',
      type: '博客文章',
      title: entry.title || slug,
      summary: [tags.length ? `分类：${tags.join(' / ')}` : null, plain.slice(0, 110)]
        .filter(Boolean)
        .join(' · '),
      url: `${SITE}${pathname}`,
      image: await mirrorCover(slug, firstImage(entry.content, entry.link || SITE)),
      timestamp: isoOrNull(entry.published),
      meta: {
        slug,
        tags,
        updated: isoOrNull(entry.updated),
        coverMirrored: true,
      },
    });
  }

  return items;
}
