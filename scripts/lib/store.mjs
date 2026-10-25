import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT = path.resolve(__dirname, '..', '..');
/** 数据目录 */
export const RES_DIR = path.join(ROOT, 'res');
/** 构建输出目录 */
export const DIST_DIR = path.join(ROOT, 'dist');

export const LIST_FILE = path.join(RES_DIR, 'list.json');
export const RALIST_FILE = path.join(RES_DIR, 'ralist.json');
export const STATS_FILE = path.join(RES_DIR, 'stats.json');

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

/** 判断条目是否已存在（按 id 去重）。 */
export function hasItem(list, id) {
  return list.some((item) => item.id === id);
}
