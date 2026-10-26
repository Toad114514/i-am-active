import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT = path.resolve(__dirname, '..', '..');
/** 数据目录 */
export const RES_DIR = path.join(ROOT, 'res');
/**
 * 「抓回来自己托管」的图片目录（相对仓库根）。
 *
 * 有的平台的图片地址带签名，几小时后就 403（OTTOhub 的封面就是这样），
 * 把 URL 原样存进 list.json 等于存了个明天就失效的链接。这类图在抓取时
 * 就地下载到 res/media/ 下，条目里只记站点相对路径（`media/xxx.jpg`），
 * build 时整目录复制进 dist/，于是线上永久有效。
 */
export const MEDIA_DIR = path.join(RES_DIR, 'media');
/** 构建输出目录 */
export const DIST_DIR = path.join(ROOT, 'dist');

export const LIST_FILE = path.join(RES_DIR, 'list.json');
export const RALIST_FILE = path.join(RES_DIR, 'ralist.json');
export const STATS_FILE = path.join(RES_DIR, 'stats.json');
/**
 * 镜像仓库登记表（res/mirrors.json）。
 *
 * Gitee 上有些仓库是 GitHub 的镜像同步，同一批提交只算一次（卡片留在 GitHub 那边）。
 * 但「这个仓库在 Gitee 也有」这件事本身是信息，丢掉之后站点上就看不出来了——
 * 存一份登记表，GitHub 卡才能标出「Gitee 同步」。
 */
export const MIRRORS_FILE = path.join(RES_DIR, 'mirrors.json');

/**
 * 读取 JSON 文件；不存在时返回 fallback。
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const raw = await readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[store] 解析 ${file} 失败，使用兜底值: ${error.message}`);
    return fallback;
  }
}

/** 原子写入 JSON（先写临时文件再 rename，避免半截文件）。 */
export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

/** 读取活动列表（res/list.json）。 */
export function readList() {
  return readJson(LIST_FILE, []);
}

/** 写入活动列表。 */
export function writeList(list) {
  return writeJson(LIST_FILE, list);
}

/** 读取 RetroAchievements 已获取成就记录（res/ralist.json）。 */
export function readRalist() {
  return readJson(RALIST_FILE, []);
}

/** 写入 RetroAchievements 已获取成就记录。 */
export function writeRalist(list) {
  return writeJson(RALIST_FILE, list);
}

/** 读取统计信息（res/stats.json）。 */
export function readStats() {
  return readJson(STATS_FILE, {
    monitoringSince: null,
    lastCollectedAt: null,
    collectRuns: 0,
  });
}

/** 写入统计信息。 */
export function writeStats(stats) {
  return writeJson(STATS_FILE, stats);
}

/** 读取镜像仓库登记表（res/mirrors.json）：{ '<gitee 全名>': { github, commits, cards } } */
export function readMirrors() {
  return readJson(MIRRORS_FILE, {});
}

/** 写入镜像仓库登记表。 */
export function writeMirrors(table) {
  return writeJson(MIRRORS_FILE, table);
}

/** 判断条目是否已存在（按 id 去重）。 */export function hasItem(list, id) {
  return list.some((item) => item.id === id);
}
