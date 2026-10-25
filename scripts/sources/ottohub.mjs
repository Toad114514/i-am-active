/**
 * OTTOhub 滚幕网：用户更新的视频。
 * 前端 chunk 里定位到的真实端点：GET /api/video/user/{uid}?offset=&num=
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const API = 'https://api.ottohub.cn';
const UID = Number(platform('ottohub').uid);

/** OTTOhub 的时间是 "YYYY-MM-DD HH:mm:ss"（UTC+8）。 */
function parseTime(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(' ', 'T');
  const date = new Date(`${normalized}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  const sinceMs = context.since ? new Date(context.since).getTime() : null;

  return videos
    .map((video) => ({
      id: `ottohub:${video.vid}`,
      platform: 'ottohub',
      type: '视频',
      title: video.title || '未命名视频',
      summary:
        `发布于 OTTOhub「${video.username ?? 'Toad114514'}」` +
        (video.view_count ? `，${video.view_count} 次播放` : '') +
        (video.duration ? `，时长 ${video.duration}s` : ''),
      url: `https://www.ottohub.cn/video/${video.vid}`,
      image: video.cover_url ?? null,
      timestamp: parseTime(video.time),
      meta: {
        vid: video.vid,
        duration: video.duration ?? null,
        viewCount: video.view_count ?? null,
        likeCount: video.like_count ?? null,
      },
    }))
    .filter((item) => {
      if (sinceMs === null || !item.timestamp) return true;
      return Date.parse(item.timestamp) >= sinceMs;
    });
}
