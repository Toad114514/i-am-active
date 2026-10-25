/**
 * 互联网档案馆（Internet Archive）账号新增上传。
 *
 * 关键点（实测）：
 *  - advancedsearch.php / scrape / user.php 都查不到该账号的上传，
 *    真正可用的是网页版用户主页用的 page_production 端点。
 *  - `page_target` 必须带 `@` 前缀，否则 400。
 *  - `page_type=account_details` 时不能带 service_backend=metadata。
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const BASE = 'https://archive.org';
const SEARCH = `${BASE}/services/search/beta/page_production/`;
const USER_ITEM_IDENTIFIER = String(platform('archive').user);

const thumbnail = (identifier) => `${BASE}/services/img/${encodeURIComponent(identifier)}`;
const detailsUrl = (identifier) => `${BASE}/details/${encodeURIComponent(identifier)}`;

/**
 * @param {{since?: Date|null}} [context] since 之前的条目已在库中，可跳过
 * @returns {Promise<Array<object>>}
 */
export async function fetchArchive(context = {}) {
  const params = new URLSearchParams({
    page_type: 'account_details',
    page_target: `@${USER_ITEM_IDENTIFIER}`,
    page_elements: JSON.stringify(['uploads']),
    hits_per_page: '50',
    page: '1',
    sort: 'publicdate:desc',
  });

  let json;
  try {
    json = await getJson(`${SEARCH}?${params}`, { timeoutMs: 25000, retries: 2 });
  } catch {
    return [];
  }

  const body = json?.response?.body ?? {};
  const hits = body?.page_elements?.uploads?.hits?.hits ?? [];
  const account = body?.account_extra_info?.account_details ?? {};
  const sinceMs = context.since ? new Date(context.since).getTime() : null;

  return hits
    .map((hit) => {
      const fields = hit.fields ?? {};
      const identifier = fields.identifier;
      const collections = fields.collection ?? [];
      const mediatype = fields.mediatype ?? 'data';
      const label =
        mediatype === 'movies'
          ? '影片'
          : mediatype === 'audio'
            ? '音频'
            : mediatype === 'data'
              ? '资料'
              : '条目';

      return {
        id: `archive:${identifier}`,
        platform: 'archive',
        type: label,
        title: fields.title ?? identifier,
        summary:
          (fields.description ?? '').slice(0, 180) ||
          `新增${label}：${fields.title ?? identifier}`,
        url: detailsUrl(identifier),
        image: thumbnail(identifier),
        timestamp: fields.addeddate ?? fields.publicdate ?? null,
        meta: {
          identifier,
          mediatype,
          collections: Array.isArray(collections) ? collections : [collections].filter(Boolean),
          downloads: fields.downloads ?? null,
          itemSize: fields.item_size ?? null,
          screenName: account.screenname ?? null,
        },
      };
    })
    .filter((item) => {
      if (sinceMs === null || !item.timestamp) return true;
      return Date.parse(item.timestamp) >= sinceMs;
    });
}
