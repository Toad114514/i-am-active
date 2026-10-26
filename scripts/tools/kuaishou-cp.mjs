// 快手作品全量采集（走 cp.kuaishou.com 创作者后台）
//
// ⚠️ 这是**本地工具**，CI（update.yml → scripts/collect.mjs）不会运行它：
//   它需要 Playwright + 一个已经扫码登录过的浏览器 profile，而 CI 既装不了
//   Chromium 也无法扫码。所以快手的更新流程是「本地跑这个脚本 → 提交 res/」。
//
// 为什么绕到创作者后台：
//   C 端 www.kuaishou.com 的 rest/v/profile/feed 与 GraphQL 都必须带
//   __NS_hxfalcon 签名（浏览器混淆 JS 现算，纯 HTTP 一律 result:50），
//   且实测该页面会话「签发出来就被服务端判 result:109」——cookie 齐、签名齐、
//   时钟差 1 秒、住宅 IP 直连，依然 109（Firefox 与 Chromium 复现一致）。
//   cp.kuaishou.com 是独立产品线，登录态由自己维护，它的
//   POST /rest/cp/works/v2/video/pc/photo/list **免签名**：result=1 直接返回
//   total + list，一条就带齐标题/封面/播放/点赞/评论/时长/发布时间。
//
// 前置：先用有头模式扫码登录一次（profile 会持久化，之后可无头复用）
//   PLAYWRIGHT_PATH=... KS_HEADED=1 node scripts/tools/kuaishou-cp.mjs
//
// 用法：node scripts/tools/kuaishou-cp.mjs          # 采集 + 镜像封面 + 并入 res/list.json
//       node scripts/tools/kuaishou-cp.mjs --dry    # 只采集，不写 res/
//
// 环境变量：
//   PLAYWRIGHT_PATH   playwright 包入口（默认用本机 workbuddy 运行时里那份）
//   KS_PROFILE        浏览器 profile 目录（默认 ~/.cache/ks-cp）
//   KS_HEADED=1       有头模式（需要重新扫码时用）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pwPath =
  process.env.PLAYWRIGHT_PATH ||
  path.join(os.homedir(), '.workbuddy/binaries/node/workspace/node_modules/playwright/index.js');
const { chromium } = (await import(pwPath)).default;

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_DIR = process.env.KS_PROFILE || path.join(os.homedir(), '.cache/ks-cp');
const RAW_OUT = path.join(ROOT, '.tmp/kuaishou-works.json');
const MEDIA_DIR = path.join(ROOT, 'res/media/kuaishou');
const LIST_FILE = path.join(ROOT, 'res/list.json');
const FIXED_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const DRY = process.argv.includes('--dry');
const HEADED = process.env.KS_HEADED === '1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(`${PROFILE_DIR}/${f}`); } catch {}
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: !HEADED,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=zh-CN', '--no-proxy-server', '--disable-dev-shm-usage'],
  userAgent: FIXED_UA,
  viewport: { width: 1560, height: 1400 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});

const page = ctx.pages()[0] || (await ctx.newPage());

// ---- 抓一次 photo/list 的请求与响应，作为翻页模板 ----
let template = null; // { url, postData, headers }
const pages = []; // 每页的 data { list, nextCursor, total }

ctx.on('request', (req) => {
  if (!/\/rest\/cp\/works\/v2\/video\/pc\/photo\/list/.test(req.url())) return;
  if (template) return;
  template = { url: req.url(), postData: req.postData(), headers: req.headers() };
});

ctx.on('response', async (res) => {
  if (!/\/rest\/cp\/works\/v2\/video\/pc\/photo\/list/.test(res.url())) return;
  try {
    const j = JSON.parse(await res.text());
    if (j?.result === 1 && j.data) {
      pages.push(j.data);
      log(`  接口: result=1 total=${j.data.total} 本页=${j.data.list?.length} nextCursor=${j.data.nextCursor}`);
    } else {
      log(`  接口异常: result=${j?.result} message=${j?.message}`);
    }
  } catch {}
});

log('打开作品管理 …');
await page.goto('https://cp.kuaishou.com/article/manage/video', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('goto:', e.message.slice(0, 100)));
await sleep(12000);

const needLogin = await page.evaluate(() => /扫码登录|立即登录|登录快手/.test(document.body.innerText || '')).catch(() => true);
if (needLogin) {
  log('❌ 未登录（profile 里的 cp 会话失效），请重新跑有头模式扫码：KS_HEADED=1');
  await page.screenshot({ path: '/home/toad/.cache/tmp/ks-cp-relogin.png' }).catch(() => {});
  await ctx.close();
  process.exit(1);
}

if (!pages.length) {
  log('❌ 没等到 photo/list 响应');
  await ctx.close();
  process.exit(1);
}

// ---- 翻页补齐（total 大于首页条数时） ----
const collected = new Map();
for (const p of pages) for (const it of p.list || []) collected.set(String(it.workId), it);
let total = pages[0].total ?? collected.size;
let cursor = pages[pages.length - 1].nextCursor;
log(`首页 ${collected.size}/${total} 条`);

let guard = 0;
while (collected.size < total && template && cursor && guard < 40) {
  guard += 1;
  const body = (() => {
    try {
      const b = JSON.parse(template.postData || '{}');
      for (const k of ['cursor', 'nextCursor', 'pcursor']) if (k in b) b[k] = String(cursor);
      return b;
    } catch {
      return null;
    }
  })();
  if (!body) break;
  if (!('cursor' in body) && !('nextCursor' in body) && !('pcursor' in body)) {
    body.cursor = String(cursor);
  }
  const json = await page.evaluate(async ({ url, payload }) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) });
    return r.json();
  }, { url: template.url, payload: body }).catch((e) => (log('  翻页异常:', e.message.slice(0, 80)), null));

  if (!json || json.result !== 1 || !json.data) { log('  翻页返回异常，停止'); break; }
  const got = json.data.list || [];
  let added = 0;
  for (const it of got) if (!collected.has(String(it.workId))) { collected.set(String(it.workId), it); added += 1; }
  total = json.data.total ?? total;
  log(`  翻页 +${added} → ${collected.size}/${total}`);
  if (!got.length || !json.data.nextCursor || json.data.nextCursor === cursor) break;
  cursor = json.data.nextCursor;
  await sleep(800);
}

// ---- 落地原始数据 ----
fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });
const raw = [...collected.values()];
fs.writeFileSync(RAW_OUT, JSON.stringify({ collectedAt: new Date().toISOString(), source: 'cp.kuaishou.com', count: raw.length, works: raw }, null, 2));
log(`原始数据 → ${RAW_OUT}（${raw.length} 条）`);

// ---- 镜像封面（CDN 链接带签名，几小时就失效，必须落本地）----
async function mirrorCover(workId, url) {
  if (!url) return null;
  const file = path.join(MEDIA_DIR, `${workId}.jpg`);
  try {
    const st = fs.statSync(file);
    if (st.size > 1024) return `media/kuaishou/${workId}.jpg`;
  } catch {}
  try {
    const r = await fetch(url, { headers: { 'User-Agent': FIXED_UA }, signal: AbortSignal.timeout(20000) });
    const type = r.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error(`不是图片(${type || '无'})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) throw new Error(`太小(${buf.length})`);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    return `media/kuaishou/${workId}.jpg`;
  } catch (e) {
    log(`  封面 ${workId} 失败: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// ---- 转成站点条目 ----
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/**
 * 标题：取首行、剥掉 #话题标签 再截断。
 * 卡片上标题和摘要同时显示，标题里留一串标签会很难看；
 * 但也不能「遇到 # 就切」——`shop #1` 这种带编号的会只剩 `shop`。
 */
const titleOf = (full) => {
  const first = full.split('\n')[0];
  const stripped = first.replace(/\s*#[^\s#]+/g, '').replace(/\s+/g, ' ').trim();
  const s = stripped || first;
  if (s.length <= 60) return s || '未命名短视频';
  const head = s.slice(0, 60);
  const sp = head.lastIndexOf(' ');
  return (sp > 33 ? head.slice(0, sp) : head).trim();
};
const items = [];
for (const w of raw) {
  const workId = String(w.workId || w.photoId || '');
  if (!workId) continue;
  const full = clean(w.title);
  const ts = Number(w.uploadTime);
  const image = DRY ? null : await mirrorCover(workId, w.publishCoverUrl);
  items.push({
    id: `kuaishou:${workId}`,
    platform: 'kuaishou',
    type: '视频',
    title: titleOf(full),
    summary: full.slice(0, 180),
    url: `https://www.kuaishou.com/short-video/${workId}`,
    image,
    timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
    meta: {
      workId,
      duration: w.durationSecond ?? null,
      playCount: w.playCount ?? null,
      likeCount: w.likeCount ?? null,
      commentCount: w.commentCount ?? null,
      archived: true,
    },
  });
}
log(`生成条目 ${items.length} 条，有封面 ${items.filter((x) => x.image).length} 条`);

if (DRY) {
  await ctx.close();
  log('--dry，未写入 res/');
  process.exit(0);
}

// ---- 并入 res/list.json（同 id 只补字段，不覆盖已有非空值）----
const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
const byId = new Map(list.map((x) => [x.id, x]));
let added = 0;
let enriched = 0;
for (const it of items) {
  const cur = byId.get(it.id);
  if (!cur) {
    list.push(it);
    byId.set(it.id, it);
    added += 1;
    continue;
  }
  let changed = false;
  for (const [k, v] of Object.entries(it.meta)) {
    if (v === null || v === undefined || v === '') continue;
    if (cur.meta?.[k] === undefined || cur.meta?.[k] === null || cur.meta?.[k] === '') { cur.meta = { ...(cur.meta ?? {}), [k]: v }; changed = true; }
  }
  if (!cur.image && it.image) { cur.image = it.image; changed = true; }
  if (changed) enriched += 1;
}

const sorted = list.sort((a, b) => {
  const ta = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
  const tb = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
  return tb - ta;
});
fs.writeFileSync(LIST_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
log(`✅ 并入 list.json：新增 ${added} 条，补全 ${enriched} 条，总计 ${sorted.length} 条`);

await ctx.close();
log('done');
