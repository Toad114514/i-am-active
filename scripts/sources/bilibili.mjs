/**
 * Bilibili 本人动态抓取。
 *
 * 关键点（均为实测）：
 *  - `web_location=333.1387` 是硬性要求，缺失时接口静默返回空 items，不报错。
 *  - 必须先拿 cookie：访问空间页拿 buvid3/b_nut，再调 /x/frontend/finger/spi 拿 b_3/b_4。
 *  - 接口对匿名请求存在概率性风控（-352 / code:0 但 items 为空），
 *    必须重试，且每次重试换一份全新的 buvid_fp 才有效。
 */
import { CookieJar, getJsonWithJar, randomHex, sleep } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

/** 从 config.yaml 取本次运行的参数。 */
function settings() {
  const config = platform('bilibili');
  return {
    mid: String(config.mid),
    retries: Math.max(1, Number(config.retries) || 14),
  };
}

const spaceUrl = (mid) => `https://space.bilibili.com/${mid}/dynamic`;

const feedUrl = (mid) =>
  `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space` +
  `?host_mid=${mid}&offset=&web_location=333.1387` +
  `&features=itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,forwardListHidden,ugcDelete,onlyfansQaCard`;

/** 取一份全新的访客 cookie。 */
async function freshCookies(mid) {
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
  return jar;
}

/** 拉取动态列表，带风控重试。 */
async function fetchFeed() {
  const { mid, retries } = settings();
  let lastCode = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const jar = await freshCookies(mid);
    try {
      const data = await getJsonWithJar(feedUrl(mid), jar, {
        headers: {
          Referer: spaceUrl(mid),
          Origin: 'https://space.bilibili.com',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        retries: 0,
        timeoutMs: 20000,
      });
      const items = data?.data?.items ?? [];
      if (items.length > 0) return items;
      lastCode = data?.code ?? 'empty';
    } catch (error) {
      lastCode = error.message;
    }
    if (attempt < retries) await sleep(500 + Math.random() * 700);
  }
  console.warn(`[bilibili] 重试 ${retries} 次仍未取到动态（最后状态 ${lastCode}）`);
  return [];
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
  const items = await fetchFeed();
  // 注意：context.since 是 Date，先转成时间戳再比较（旧实现在这里二次调用 getTime 会直接抛错）
  const sinceMs = context.since ? new Date(context.since).getTime() : null;
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
