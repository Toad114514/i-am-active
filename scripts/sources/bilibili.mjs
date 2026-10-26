/**
 * Bilibili 本人动态抓取（投稿视频 / 图文 / 纯文字 / 转发 / 专栏）。
 *
 * 关键点（均为实测）：
 *  - `web_location=333.1387` 是硬性要求，缺失时接口静默返回空 items，不报错。
 *  - 必须先拿 cookie：访问空间页拿 buvid3/b_nut，再调 /x/frontend/finger/spi 拿 b_3/b_4。
 *  - 接口对匿名请求存在概率性风控（-352 / code:0 但 items 为空），
 *    必须重试，且每次重试换一份全新的 buvid_fp 才有效。
 *  - 按 `data.offset` 翻页可以取到入站以来的全部动态（投稿视频本身就是一条
 *    DYNAMIC_TYPE_AV 动态，翻完动态 = 投稿 + 动态全覆盖）；
 *    增量轮传 sinceMs 早停，只翻第一页就够。
 *  - ⚠️ 游标字段是 `data.offset`，**不是** `next_offset`：只读后者会永远停在
 *    第一页（13 条），而且这个 bug 在「匿名」和「带登录 Cookie」两种情况下
 *    表现完全一样，很容易被误判成「匿名被降级」。
 */
import { CookieJar, getJsonWithJar, randomHex, sleep } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

/** 从 config.yaml 取本次运行的参数。 */
function settings() {
  const config = platform('bilibili');
  return {
    mid: String(config.mid),
    retries: Math.max(1, Number(config.retries) || 14),
    // 可选登录态（浏览器里复制形如 "SESSDATA=xxx; bili_jct=yyy" 的 Cookie）。
    // 实测（2026-10）：匿名请求被服务端降级——feed 固定只给最近一页十几条、
    // 不返回 next_offset，投稿列表接口直接 412/-352；带上登录 Cookie 才能翻完整个历史。
    cookie: String(config.cookie ?? '').trim(),
  };
}

const spaceUrl = (mid) => `https://space.bilibili.com/${mid}/dynamic`;

const feedUrl = (mid, offset = '') =>
  `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space` +
  `?host_mid=${mid}&offset=${encodeURIComponent(offset)}&web_location=333.1387` +
  `&features=itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,forwardListHidden,ugcDelete,onlyfansQaCard`;

/** 把 config 里的 Cookie 字符串拆成键值对（"a=1; b=2" → [['a','1'],['b','2']]）。 */
function parseCookiePairs(cookie) {
  const pairs = [];
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && value) pairs.push([name, value]);
  }
  return pairs;
}

/** 取一份全新的访客 cookie；配了登录态时把登录 Cookie 一起带上。 */
async function freshCookies(mid, loginCookie = '') {
  const jar = new CookieJar();
  try {
    const response = await fetch(spaceUrl(mid), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
    });
    jar.absorb(response);
  } catch {
    /* 空间页失败不致命，继续用 spi 补齐 */
  }
  try {
    const spi = await getJsonWithJar('https://api.bilibili.com/x/frontend/finger/spi', jar, {
      headers: { Referer: 'https://www.bilibili.com/' },
      retries: 1,
      timeoutMs: 12000,
    });
    if (spi?.data?.b_3) jar.set('buvid3', spi.data.b_3);
    if (spi?.data?.b_4) jar.set('buvid4', spi.data.b_4);
  } catch {
    /* spi 失败不致命 */
  }
  jar.set('buvid_fp', randomHex(32));
  for (const [name, value] of parseCookiePairs(loginCookie)) jar.set(name, value);
  return jar;
}

/** 单次请求的页大小约 20 条；翻页上限是防失控的保险丝（600 条 ≈ 30 页）。 */
const MAX_FEED_PAGES = 30;

/**
 * 拉取动态列表，带风控重试，按接口返回的游标翻页直到取完。
 *
 * 游标字段是 `data.offset`（老文档写的 `next_offset` 现在已经**不返回**了，
 * 只读 next_offset 会永远停在第一页、拿不到 13 条以外的内容）；同时看
 * `data.has_more`，末页它会是 false。
 *
 * @param {{sinceMs?: number|null}} [options]
 *   sinceMs 非 null 时启用增量早停：某一页里**最旧**的一条都比 since 还早，
 *   说明更早的页不会再有新内容（新动态永远排在最上面，置顶老卡不会挡住它后面的新条目），
 *   翻完这一页就收工 —— 没有早停的话每小时的增量轮也要把几百条历史翻一遍。
 * @returns {Promise<Array<object>>} 按时间倒序的全部动态原始条目
 */
async function fetchFeed({ sinceMs = null } = {}) {
  const { mid, retries, cookie } = settings();
  const all = [];
  const seenIds = new Set();
  let offset = '';
  let lastCode = null;

  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    let items = null;
    let nextOffset = null;
    let hasMore = false;
    // 每次尝试都用全新 cookie：风控针对的是指纹，换指纹才有效
    for (let attempt = 1; attempt <= retries; attempt++) {
      const jar = await freshCookies(mid, cookie);
      try {
        const data = await getJsonWithJar(feedUrl(mid, offset), jar, {
          headers: {
            Referer: spaceUrl(mid),
            Origin: 'https://space.bilibili.com',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
          retries: 0,
          timeoutMs: 20000,
        });
        const pageData = data?.data ?? {};
        const pageItems = pageData.items ?? [];
        nextOffset = pageData.next_offset ?? pageData.offset ?? null;
        hasMore = pageData.has_more !== false;
        if (pageItems.length > 0) {
          items = pageItems;
          break;
        }
        // items 为空：只有第 0 页且从未拿到过游标才可能是「一条动态都没有」；
        // 中间页的空十有八九是风控，落到下面的重试里换指纹再来
        lastCode = data?.code ?? 'empty';
      } catch (error) {
        lastCode = error.message;
      }
      if (attempt < retries) await sleep(500 + Math.random() * 700);
    }

    if (!items) {
      if (page === 0) {
        console.warn(`[bilibili] 重试 ${retries} 次仍未取到动态（最后状态 ${lastCode}）`);
        return [];
      }
      console.warn(
        `[bilibili] 第 ${page + 1} 页重试后仍为空（${lastCode}），` +
          `先收下已取到的 ${all.length} 条`,
      );
      break;
    }

    let oldestTs = Number.POSITIVE_INFINITY;
    for (const item of items) {
      if (item.id_str && seenIds.has(item.id_str)) continue;
      if (item.id_str) seenIds.add(item.id_str);
      all.push(item);
      const ts = Number(item?.modules?.module_author?.pub_ts ?? 0) * 1000;
      if (ts > 0 && ts < oldestTs) oldestTs = ts;
    }

    // 增量早停：整页都比 since 旧，后面全是更老的历史
    if (sinceMs !== null && Number.isFinite(oldestTs) && oldestTs < sinceMs) break;
    // 没有游标 / has_more=false / 游标没前进 = 真的翻完了
    if (!nextOffset || !hasMore) break;
    if (String(nextOffset) === offset) break;
    offset = String(nextOffset);
  }

  return all;
}

/** 从动态条目中提取正文。 */
function extractText(item) {
  const dyn = item?.modules?.module_dynamic ?? {};
  const direct = dyn.desc?.text;
  if (direct) return direct;
  // 图文动态正文在 opus.summary
  const opusText = dyn.major?.opus?.summary?.text;
  if (opusText) return opusText;
  // 转发动态的原内容
  const orig = item?.orig?.modules?.module_dynamic;
  if (orig) {
    if (orig.desc?.text) return orig.desc.text;
    const origOpus = orig.major?.opus?.summary?.text;
    if (origOpus) return origOpus;
  }
  return '';
}

/** 从动态条目中提取封面图。 */
function extractImage(item) {
  const dyn = item?.modules?.module_dynamic ?? {};
  const major = dyn.major ?? {};
  const opusPics = major.opus?.pics;
  if (Array.isArray(opusPics) && opusPics.length > 0) {
    return httpsify(opusPics[0].url) ?? null;
  }
  if (major.archive?.cover) return httpsify(major.archive.cover) ?? null;
  const orig = item?.orig?.modules?.module_dynamic?.major;
  if (orig?.opus?.pics?.[0]?.url) return httpsify(orig.opus.pics[0].url) ?? null;
  if (orig?.archive?.cover) return httpsify(orig.archive.cover) ?? null;
  return null;
}

/** 从动态条目中提取标题（视频用视频标题，其余用正文首行）。 */
function extractTitle(item) {
  const dyn = item?.modules?.module_dynamic ?? {};
  const archive = dyn.major?.archive ?? item?.orig?.modules?.module_dynamic?.major?.archive;
  if (archive?.title) return String(archive.title);
  const opusTitle = dyn.major?.opus?.title;
  if (opusTitle) return String(opusTitle);
  const text = extractText(item);
  const firstLine = text.split('\n').find((line) => line.trim());
  return firstLine ? firstLine.trim().slice(0, 60) : '动态';
}

/** 提取跳转链接。 */
function extractUrl(item) {
  const jump = item?.basic?.jump_url;
  if (jump) return httpsify(jump) ?? null;
  const archive = item?.modules?.module_dynamic?.major?.archive;
  if (archive?.jump_url) return httpsify(archive.jump_url) ?? null;
  const origJump = item?.orig?.basic?.jump_url;
  if (origJump) return httpsify(origJump) ?? null;
  const origArchive = item?.orig?.modules?.module_dynamic?.major?.archive;
  if (origArchive?.jump_url) return httpsify(origArchive.jump_url) ?? null;
  return `https://t.bilibili.com/${item?.id_str ?? ''}`;
}

/** http:// → https://（混合内容在 https 页面上会被浏览器拦截）。 */
function httpsify(url) {
  if (typeof url !== 'string' || !url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

/** 动态类型 → 中文标签。 */
function typeLabel(type) {
  switch (type) {
    case 'DYNAMIC_TYPE_AV':
      return '投稿视频';
    case 'DYNAMIC_TYPE_DRAW':
      return '图文动态';
    case 'DYNAMIC_TYPE_FORWARD':
      return '转发动态';
    case 'DYNAMIC_TYPE_WORD':
      return '纯文字动态';
    case 'DYNAMIC_TYPE_ARTICLE':
      return '专栏';
    default:
      return '动态';
  }
}

/**
 * @param {{since?: Date|null}} [context]
 * @returns {Promise<Array<object>>} 新的动态条目
 */
export async function fetchBilibili(context = {}) {
  const sinceMs = context.since ? new Date(context.since).getTime() : null;
  const items = await fetchFeed({ sinceMs });
  // 注意：since 是 Date，先转成时间戳再比较（旧实现在这里二次调用 getTime 会直接抛错）
  return items
    .map((item) => {
      const pubTs = item?.modules?.module_author?.pub_ts ?? 0;
      const text = extractText(item);
      const title = extractTitle(item);
      return {
        id: `bilibili:${item.id_str}`,
        platform: 'bilibili',
        type: typeLabel(item.type),
        title,
        summary: text ? text.slice(0, 180) : title,
        url: extractUrl(item),
        image: extractImage(item),
        timestamp: pubTs ? new Date(pubTs * 1000).toISOString() : null,
        meta: {
          bvid: item?.modules?.module_dynamic?.major?.archive?.bvid ?? null,
        },
      };
    })
    .filter((item) => {
      if (sinceMs === null || !item.timestamp) return true;
      return Date.parse(item.timestamp) >= sinceMs;
    });
}
