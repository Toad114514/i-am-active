/**
 * 抓取状态：记录各平台上次成功抓取的时间，用于增量拉取。
 * 存放在 res/state.json（与 list.json 分开，list.json 只放活动条目）。
 */
import { readJson, writeJson } from './store.mjs';
import path from 'node:path';
import { RES_DIR } from './store.mjs';

const STATE_FILE = path.join(RES_DIR, 'state.json');

/** 默认状态。 */
export function emptyState() {
  return {
    /** 各平台最后一次成功抓取时间（ISO） */
    lastRun: {},
    /** 各平台已知的条目 id（防止同一批内容反复入库） */
    knownIds: {},
  };
}

/** 读取状态。 */
export async function readState() {
  const state = await readJson(STATE_FILE, null);
  if (!state) return emptyState();
  return { ...emptyState(), ...state };
}

/** 写入状态。 */
export function writeState(state) {
  return writeJson(STATE_FILE, state);
}

/**
 * 取某平台的上次抓取时间；没有则回退到 defaultSince。
 * @returns {Date|null}
 */
export function lastRunOf(state, platform, defaultSince = null) {
  const value = state?.lastRun?.[platform];
  if (!value) return defaultSince ? new Date(defaultSince) : null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
