/**
 * 快手短视频。
 *
 * 实测结论（2026-10-26 全面复核，重要）：
 *  - profile SSR 页免登录可用，但**不含作品列表**（SPA 空壳，爬虫 UA 直接 63 字节拒）。
 *  - 作品列表真实端点 POST /rest/v/profile/feed 需要 `__NS_hxfalcon` 签名 + `kww` 指纹头，
 *    纯 HTTP 返回 result:50「签名验证失败」；GraphQL 免签名但匿名要滑块验证码（400002）。
 *  - 拿真实浏览器（Playwright）跑起来后签名能过（SPA 自算），cookie 也确认随请求发出
 *    （allHeaders 可见 12 条含 webday7_st 354 字符），但服务端仍一律 **result:109**。
 *    已逐项排除：时钟差 1 秒、出口 IP 为上海移动住宅宽带直连、cookie 全部有效未分区、
 *    UA 由头到尾锁死。Firefox 上同一账号「刷新即掉登录」，Chromium 里会话也判 109
 *    —— 即 C 端网页会话**签发出来就无效**，与浏览器/扩展/代理无关。
 *
 * 因此本模块在 CI 里抓不到作品，只保留「账号概况」降级路径（无 cookie 时通常返回空）。
 * 快手的真实数据靠**本地工具** scripts/tools/kuaishou-cp.mjs：
 *   走 cp.kuaishou.com 创作者后台的 POST /rest/cp/works/v2/video/pc/photo/list
 *   （**免签名**，result=1 直接给 total + 列表），跑完把 res/ 提交上来即可。
 */
import { getJson, http } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const kuaishou = platform('kuaishou');
const PROFILE_ID = String(kuaishou.profileId);
const PROFILE_URL = `https://www.kuaishou.com/profile/${PROFILE_ID}`;
const FEED_URL = 'https://www.kuaishou.com/rest/v/profile/feed';

/** 读取配置里的快手 Cookie（用于登录态请求）。 */
function cookieHeader() {
  const cookie = String(kuaishou.cookie ?? '').trim();
  return cookie || null;
}

/** 尝试带登录态请求作品列表。 */
async function fetchWithCookie(cookie) {
  const body = {
    page: 'profile',
    userId: PROFILE_ID,
    pageSize: 30,
    pcursor: '',
  };
  const response = await http(FEED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Referer: PROFILE_URL,
      Cookie: cookie,
      Origin: 'https://www.kuaishou.com',
    },
    body: JSON.stringify(body),
    timeoutMs: 20000,
    retries: 1,
  });
  return response.json();
}

/** 免登录抓取 profile SSR 页里的用户信息。 */
async function fetchProfileInfo() {
  try {
    const response = await http(PROFILE_URL, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeoutMs: 25000,
      retries: 1,
    });
    const html = await response.text();

    const pick = (pattern) => html.match(pattern)?.[1] ?? null;
    const nickname =
      pick(/<title[^>]*>([^<]*?)[^<]*<\/title>/)?.match(/(.*?)\s*-\s*快手/)?.[1] ??
      pick(/"userName":"([^"]+)"/) ??
      pick(/"user_name":"([^"]+)"/);
    const fans = pick(/"fan[sS]?":\s*"?(\d+)"?/);
    const photoCount = pick(/"(?:photo|work)[sS]?(?:Count|Num)":\s*"?(\d+)"?/);

    return { nickname, fans, photoCount, html };
  } catch {
    return { nickname: null, fans: null, photoCount: null, html: '' };
  }
}

/**
 * @returns {Promise<Array<object>>}
 */
export async function fetchKuaishou() {
  const cookie = cookieHeader();

  if (cookie) {
    try {
      const json = await fetchWithCookie(cookie);
      const list = json?.data?.visionProfilePhotoList ?? json?.data?.feed ?? [];
      const videos = Array.isArray(list) ? list : [];
      if (videos.length > 0) {
        return videos.map((video) => {
          const id = video.id ?? video.photoId ?? video.photo_id;
          const caption = video.caption ?? video.description ?? '未命名短视频';
          const cover =
            video.coverUrl ?? video.coverUrlList?.[0]?.url ?? video.photoUrl ?? null;
          return {
            id: `kuaishou:${id}`,
            platform: 'kuaishou',
            type: '短视频',
            title: caption.split('\n')[0].slice(0, 60) || '未命名短视频',
            summary: caption.slice(0, 180),
            url: `https://www.kuaishou.com/short-video/${id}`,
            image: cover,
            timestamp: video.timestamp
              ? new Date(Number(video.timestamp)).toISOString()
              : null,
            meta: { photoId: id },
          };
        });
      }
      console.warn(
        `[kuaishou] 带 cookie 请求未返回作品列表（result=${json?.result ?? '未知'}），降级到 profile 信息`,
      );
    } catch (error) {
      console.warn(`[kuaishou] 带 cookie 请求失败: ${error.message}`);
    }
  } else {
    console.warn(
      '[kuaishou] 未配置 KUAISHOU_COOKIE，只能获取账号概况（作品列表需登录态）',
    );
  }

  // 降级：账号概况
  const info = await fetchProfileInfo();
  if (!info.nickname && !info.photoCount) return [];

  return [
    {
      id: `kuaishou:profile:${info.photoCount ?? 'unknown'}`,
      platform: 'kuaishou',
      type: '账号概况',
      title: info.nickname ? `${info.nickname} 的快手账号` : '快手账号',
      summary:
        `作品 ${info.photoCount ?? '未知'} 个` +
        (info.fans ? `，粉丝 ${info.fans}` : '') +
        '（作品列表需配置 KUAISHOU_COOKIE 才能抓取）',
      url: PROFILE_URL,
      image: null,
      timestamp: null,
      meta: { nickname: info.nickname, fans: info.fans, photoCount: info.photoCount },
    },
  ];
}
