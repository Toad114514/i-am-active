/**
 * YouTube 频道新视频。
 * 默认用频道 RSS（无需 API Key）；config.yaml 里配了 apiKey 就走 Data API v3。
 */
import { getText, getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const rssUrl = (channelId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

const decodeXml = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const tagText = (block, tag) => {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1].trim()) : null;
};

const tagAttrs = (block, tag) => {
  const match = block.match(new RegExp(`<${tag}([^>]*?)/?>`));
  if (!match) return null;
  const attrs = {};
  for (const m of match[1].matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
};

/**
 * @param {{since?: Date|null}} [context]
 * @returns {Promise<Array<object>>}
 */
export async function fetchYouTube(context = {}) {
  const config = platform('youtube');
  const channelId = String(config.channelId ?? '');
  const apiKey = String(config.apiKey ?? '').trim();

  // 配了 key 就优先 Data API（描述更完整），失败再退回 RSS
  if (apiKey) {
    const viaApi = await fetchYouTubeViaDataApi({ apiKey, channelId, since: context.since });
    if (viaApi.length > 0) return viaApi;
  }

  let xml;
  try {
    xml = await getText(rssUrl(channelId), { timeoutMs: 20000, retries: 2 });
  } catch {
    return [];
  }

  const head = xml.slice(0, Math.max(xml.indexOf('<entry>'), 0));
  const channelTitle = tagText(head, 'title') ?? 'YouTube';
  const sinceMs = context.since ? new Date(context.since).getTime() : null;

  const items = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1];
    const groupMatch = block.match(/<media:group>([\s\S]*?)<\/media:group>/);
    const group = groupMatch ? groupMatch[1] : block;
    const link = tagAttrs(block, 'link');
    const thumb = tagAttrs(group, 'media:thumbnail');
    const stats = tagAttrs(group, 'media:statistics');
    const videoId = tagText(block, 'yt:videoId');
    const description = tagText(group, 'media:description') ?? '';

    items.push({
      id: `youtube:${videoId}`,
      platform: 'youtube',
      type: '视频',
      title: tagText(block, 'title') ?? '未命名视频',
      summary: description.slice(0, 180) || `${channelTitle} 的新视频`,
      url: link?.href ?? `https://www.youtube.com/watch?v=${videoId}`,
      image: thumb?.url ?? null,
      timestamp: tagText(block, 'published'),
      meta: {
        videoId,
        views: stats?.views ? Number(stats.views) : null,
        updated: tagText(block, 'updated'),
      },
    });
  }

  return items.filter((item) => {
    if (sinceMs === null || !item.timestamp) return true;
    return Date.parse(item.timestamp) >= sinceMs;
  });
}

/**
 * YouTube Data API v3（config.yaml 里配了 youtube.apiKey 时启用），可拿到更完整的描述。
 */
export async function fetchYouTubeViaDataApi({ apiKey, channelId, since } = {}) {
  if (!apiKey) return [];
  const url =
    `https://www.googleapis.com/youtube/v3/search?key=${apiKey}` +
    `&channelId=${channelId}&order=date&part=snippet&type=video&maxResults=20`;
  let data;
  try {
    data = await getJson(url, { timeoutMs: 20000, retries: 1 });
  } catch (error) {
    console.warn(`[youtube] Data API 失败（${error.message}），退回 RSS`);
    return [];
  }
  const sinceMs = since ? new Date(since).getTime() : null;
  return (data.items ?? [])
    .map((entry) => ({
      id: `youtube:${entry.id.videoId}`,
      platform: 'youtube',
      type: '视频',
      title: entry.snippet?.title ?? '未命名视频',
      summary: (entry.snippet?.description ?? '').slice(0, 180),
      url: `https://www.youtube.com/watch?v=${entry.id.videoId}`,
      image:
        entry.snippet?.thumbnails?.high?.url ?? entry.snippet?.thumbnails?.default?.url ?? null,
      timestamp: entry.snippet?.publishedAt ?? null,
      meta: { videoId: entry.id.videoId, source: 'data-api' },
    }))
    .filter((item) => {
      if (sinceMs === null || !item.timestamp) return true;
      return Date.parse(item.timestamp) >= sinceMs;
    });
}
