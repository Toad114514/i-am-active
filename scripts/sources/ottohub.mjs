/**
 * OTTOhub 滚幕网：用户更新的视频。
 * 前端 chunk 里定位到的真实端点：GET /api/video/user/{uid}?offset=&num=
 *
 * 封面这里有个坑：`cover_url` 是**带签名的临时链接**
 * （`...?sign=<32 位>&t=<过期时间戳>`），把 URL 原样存进 list.json 之后，
 * 几个小时内还能看，过期后整站都是 403（页面上表现为「一条封面都不显示」，
 * 而 `<img onerror>` 又会把图片块整个摘掉，看着就像从来没抓到过封面）。
 *
 * 所以这里改成「抓取时就地下载」：封面落到 res/media/ottohub/<vid>.jpg，
 * 条目里只记站点相对路径 `media/ottohub/<vid>.jpg`，由 build.mjs 复制到
 * dist/media/ 一起发布。已经存在的文件不再重复下载（vid 是稳定的键）。
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { getJson, http } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';
import { MEDIA_DIR } from '../lib/store.mjs';

const API = 'https://api.ottohub.cn';
const UID = Number(platform('ottohub').uid);

/** 封面在站点里的相对目录（相对站点根，build 时换成 `${BASE}/media/...`）。 */
const COVER_DIR = 'media/ottohub';
const COVER_ABS_DIR = path.join(MEDIA_DIR, 'ottohub');

/** OTTOhub 的时间是 "YYYY-MM-DD HH:mm:ss"（UTC+8）。 */
function parseTime(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(' ', 'T');
  const date = new Date(`${normalized}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 按 content-type 猜扩展名（下载回来的图基本都是 jpeg/webp）。 */
function extOf(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

/** 已下载过就不重复拉（封面按 vid 缓存，换封面属于罕见情况）。 */
async function alreadyMirrored(vid) {
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    try {
      const info = await stat(path.join(COVER_ABS_DIR, `${vid}.${ext}`));
      if (info.size > 512) return `${COVER_DIR}/${vid}.${ext}`;
    } catch {
      /* 不存在，试下一个后缀 */
    }
  }
  return null;
}

/**
 * 把带签名的封面下载到本地；失败返回 null（条目不带图，剩下照常）。
 * @returns {Promise<string|null>} 站点相对路径
 */
async function mirrorCover(video) {
  const vid = video?.vid;
  if (!vid) return null;
  const existing = await alreadyMirrored(vid);
  if (existing) return existing;

  const url = video.cover_url;
  if (!url) return null;
  try {
    const response = await http(url, {
      timeoutMs: 30000,
      retries: 1,
      headers: { Referer: 'https://www.ottohub.cn/' },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    // 403 页面也返回 200 的情况（防盗链回一张小图）在这里挡掉
    if (buffer.length < 512) throw new Error(`内容太小（${buffer.length} 字节）`);
    const ext = extOf(response.headers.get('content-type'));
    await mkdir(COVER_ABS_DIR, { recursive: true });
    await writeFile(path.join(COVER_ABS_DIR, `${vid}.${ext}`), buffer);
    return `${COVER_DIR}/${vid}.${ext}`;
  } catch (error) {
    console.warn(`[ottohub] 封面 ${vid} 下载失败: ${error.message}`);
    return null;
  }
}

/**
 * @param {{since?: Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchOttoHub(context = {}) {
  // num 上限为 12，超过会返回 {"status":"error","message":"too_big_num"}
  const url = `${API}/api/video/user/${UID}?offset=0&num=12`;
  let json;
  try {
    json = await getJson(url, {
      headers: { Accept: 'application/json', Referer: 'https://www.ottohub.cn/' },
      timeoutMs: 20000,
      retries: 2,
    });
  } catch (error) {
    console.warn(`[ottohub] 请求失败: ${error.message}`);
    return [];
  }

  const videos = json?.data?.video_list ?? [];

  /*
   * 不再按 since 过滤：这个接口一次最多给 12 条「最新的视频」，本身就已经是
   * 一个很窄的窗口；而封面的签名会过期，老条目恰恰最需要被重新下载一次封面。
   * 条目按 id 去重，重复返回只会命中同一条，不会产生重复记录。
   */
  const items = [];
  for (const video of videos) {
    items.push({
      id: `ottohub:${video.vid}`,
      platform: 'ottohub',
      type: '视频',
      title: video.title || '未命名视频',
      summary:
        `发布于 OTTOhub「${video.username ?? 'Toad114514'}」` +
        (video.view_count ? `，${video.view_count} 次播放` : '') +
        (video.duration ? `，时长 ${video.duration}s` : ''),
      url: `https://www.ottohub.cn/video/${video.vid}`,
      // 站点相对路径（不是 http 开头），build 时会加上 BASE 前缀
      image: await mirrorCover(video),
      timestamp: parseTime(video.time),
      meta: {
        vid: video.vid,
        duration: video.duration ?? null,
        viewCount: video.view_count ?? null,
        likeCount: video.like_count ?? null,
        // 封面是本地托管的 → collect 允许覆盖老条目里已经过期的远程签名链接
        coverMirrored: true,
      },
    });
  }
  return items;
}
