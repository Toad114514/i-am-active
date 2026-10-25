/**
 * 抓取入口：遍历所有平台 → 与 res/list.json 比对 → 新条目追加到列表最前。
 *
 * 用法：
 *   node scripts/collect.mjs            # 抓取全部平台
 *   node scripts/collect.mjs bilibili   # 只抓指定平台
 *   node scripts/collect.mjs --dry-run  # 只打印，不写文件
 *   node scripts/collect.mjs --no-state # 忽略增量状态，全量抓取
 *   node scripts/collect.mjs --show-config # 打印解析后的 config.yaml（密钥打码）
 *
 * 平台开关、账号、抓取参数全部来自根目录 config.yaml（见 scripts/lib/config.mjs）。
 *
 * 两类条目：
 *   - 普通条目：一件作品/一次提交一条，按 id 去重后追加。
 *   - 汇总条目（meta.merge === true）：抓取器把一段时间内的碎活动聚成一条。
 *     它不按 id 追加，而是「同 id 覆盖」，并把落在 meta.windowStart~windowEnd
 *     里的同平台旧记录吸收掉——这样历史遗留的逐条记录也会被并进汇总里。
 */
import {
  readList,
  writeList,
  readRalist,
  writeRalist,
  readStats,
  writeStats,
} from './lib/store.mjs';
import { readState, writeState, lastRunOf } from './lib/state.mjs';
import { config, maskSecrets } from './lib/config.mjs';

import { fetchBilibili } from './sources/bilibili.mjs';
import { fetchYouTube } from './sources/youtube.mjs';
import { fetchArchive } from './sources/archive.mjs';
import { fetchRetroAchievements } from './sources/retroachievements.mjs';
import { fetchWeblate } from './sources/weblate.mjs';
import { fetchGitHub } from './sources/github.mjs';
import { fetchGitee } from './sources/gitee.mjs';
import { fetchSteam } from './sources/steam.mjs';
import { fetchOttoHub } from './sources/ottohub.mjs';
import { fetchKuaishou } from './sources/kuaishou.mjs';

/** 所有抓取器：每个平台一个独立模块，互不影响。 */
const SOURCES = [
  { id: 'bilibili', label: '哔哩哔哩', run: fetchBilibili },
  { id: 'youtube', label: 'YouTube', run: fetchYouTube },
  { id: 'ottohub', label: 'OTTOhub', run: fetchOttoHub },
  { id: 'kuaishou', label: '快手', run: fetchKuaishou },
  { id: 'github', label: 'GitHub', run: fetchGitHub },
  { id: 'gitee', label: 'Gitee', run: fetchGitee },
  { id: 'archive', label: '互联网档案馆', run: fetchArchive },
  { id: 'weblate', label: 'Weblate', run: fetchWeblate },
  { id: 'retroachievements', label: 'RetroAchievements', run: fetchRetroAchievements },
  { id: 'steam', label: 'Steam', run: fetchSteam },
];

/** 补齐条目缺失的字段，并做基本清洗。 */
function normalize(item) {
  const title = String(item.title ?? '').trim() || '未命名活动';
  const summary = String(item.summary ?? '').trim();
  return {
    id: item.id,
    platform: item.platform,
    type: item.type ?? '活动',
    title: title.slice(0, 120),
    summary: summary.slice(0, 400),
    url: item.url ?? null,
    image: item.image ?? null,
    timestamp: item.timestamp ?? null,
    meta: item.meta ?? {},
  };
}

/** 时间排序：新的在前；无时间的排到末尾。 */
function sortItems(items) {
  return [...items].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
    const tb = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
    if (ta === tb) return 0;
    return tb - ta;
  });
}

/**
 * 把一条汇总条目并入列表。
 *  - 吸收窗口内同平台的逐条旧记录（历史数据迁移）；
 *  - 同 id 覆盖为最新版本（同一批活动继续增长时更新条数，而不是再插一条）。
 * @returns {{added: boolean, updated: boolean, removed: string[]}}
 */
function applyMerged(list, item) {
  const winStart = Date.parse(item.meta?.windowStart ?? item.timestamp ?? '') || 0;
  const winEnd = Date.parse(item.meta?.windowEnd ?? item.timestamp ?? '') || Number.MAX_SAFE_INTEGER;

  const removed = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const old = list[i];
    if (old.platform !== item.platform) continue;

    if (old.meta?.merge) {
      // 旧汇总被新汇总完整覆盖（例如同一批活动继续增长，时段起点没变）→ 只留新的
      if (old.id === item.id) continue;
      const os = Date.parse(old.meta?.windowStart ?? '');
      const oe = Date.parse(old.meta?.windowEnd ?? '');
      if (Number.isFinite(os) && Number.isFinite(oe) && os >= winStart && oe <= winEnd) {
        removed.push(old.id);
        list.splice(i, 1);
      }
      continue;
    }

    const t = old.timestamp ? Date.parse(old.timestamp) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t >= winStart && t <= winEnd) {
      removed.push(old.id);
      list.splice(i, 1);
    }
  }

  const index = list.findIndex((entry) => entry.id === item.id);
  if (index >= 0) {
    list[index] = normalize(item);
    return { added: false, updated: true, removed };
  }
  list.unshift(normalize(item));
  return { added: true, updated: false, removed };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noState = args.includes('--no-state') || config.collect.incremental === false;
  const only = args.filter((a) => !a.startsWith('--'));

  if (args.includes('--show-config')) {
    console.log(JSON.stringify(maskSecrets(config), null, 2));
    if (config.warnings.length) {
      console.log('\n提醒：');
      for (const warning of config.warnings) console.log(`  - ${warning}`);
    }
    return;
  }

  for (const warning of config.warnings) {
    console.warn(`[collect] 配置提醒：${warning}`);
  }

  const list = await readList();
  // 工作副本：dry-run 时直接丢弃，不落盘
  const working = [...list];
  const known = new Set(working.map((item) => item.id));
  const stats = await readStats();
  const state = await readState();

  const selected = only.length ? SOURCES.filter((s) => only.includes(s.id)) : SOURCES;
  if (selected.length === 0) {
    console.error(`没有匹配的抓取器。可用：${SOURCES.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  // config.yaml 里 enabled: false 的平台直接跳过；命令行显式点名时仍然执行
  const sources = selected.filter((source) => {
    if (config.platforms[source.id]?.enabled !== false) return true;
    if (only.includes(source.id)) {
      console.warn(`[collect] ${source.label} 在 config.yaml 中已禁用，但命令行显式指定，仍执行`);
      return true;
    }
    console.log(`[collect] ${source.label.padEnd(18)} 已在 config.yaml 中禁用，跳过`);
    return false;
  });

  const fresh = [];
  const touched = [];
  const failures = [];
  let addedTotal = 0;

  for (const source of sources) {
    const startedAt = Date.now();
    const since = noState ? null : lastRunOf(state, source.id);
    try {
      const items = await source.run({ since });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      const merged = items.filter((item) => item.meta?.merge === true);
      const plain = items.filter((item) => item.meta?.merge !== true);

      let addedCount = 0;
      let updatedCount = 0;
      let absorbed = 0;

      for (const item of merged) {
        const result = applyMerged(working, item);
        for (const id of result.removed) known.delete(id);
        absorbed += result.removed.length;
        if (result.added) {
          known.add(item.id);
          fresh.push(item);
          touched.push(item);
          addedCount += 1;
        } else if (result.updated) {
          touched.push(item);
          updatedCount += 1;
        }
      }

      const brandNew = plain.filter((item) => !known.has(item.id));
      for (const item of brandNew) known.add(item.id);
      fresh.push(...brandNew);
      touched.push(...brandNew);
      addedCount += brandNew.length;

      state.lastRun[source.id] = new Date().toISOString();
      addedTotal += addedCount;

      const extra = absorbed ? `，吸收旧记录 ${absorbed} 条` : '';
      const updateText = updatedCount ? `，更新汇总 ${updatedCount} 条` : '';
      console.log(
        `[collect] ${source.label.padEnd(18)} 抓到 ${String(items.length).padStart(3)} 条，新增 ${String(addedCount).padStart(3)} 条${updateText}${extra} (${elapsed}s)`,
      );
    } catch (error) {
      failures.push({ id: source.id, message: error.message });
      console.error(`[collect] ${source.label.padEnd(18)} 失败: ${error.message}`);
    }
  }

  // RetroAchievements：把新成就登记进 res/ralist.json
  const raFresh = fresh.filter((item) => item.platform === 'retroachievements');
  if (raFresh.length > 0 && !dryRun) {
    const ralist = await readRalist();
    const knownRa = new Set(ralist.map((entry) => entry.id));
    for (const item of raFresh) {
      if (knownRa.has(item.id)) continue;
      knownRa.add(item.id);
      ralist.unshift({
        id: item.id,
        title: item.title,
        gameTitle: item.meta?.gameTitle ?? null,
        unlockedAt: item.timestamp,
        recordedAt: new Date().toISOString(),
      });
    }
    await writeRalist(ralist.slice(0, 500));
    console.log(`[collect] ralist.json 现有 ${Math.min(ralist.length, 500)} 条记录`);
  }

  // 普通新条目统一插到最前面（汇总条目已就位）
  const normalized = sortItems(fresh.filter((item) => item.meta?.merge !== true).map(normalize));
  if (normalized.length) working.unshift(...normalized);

  console.log(`\n[collect] 合计新增 ${addedTotal} 条`);
  for (const item of sortItems(touched).slice(0, 20)) {
    console.log(`  + [${item.platform}] ${item.title}  ${item.timestamp ?? ''}`);
  }
  if (touched.length > 20) {
    console.log(`  … 还有 ${touched.length - 20} 条`);
  }

  if (dryRun) {
    console.log('\n[collect] --dry-run，未写入任何文件');
    return;
  }

  await writeList(working);
  console.log(`\n[collect] res/list.json 现有 ${working.length} 条`);

  await writeState(state);
  await writeStats({
    monitoringSince: stats.monitoringSince ?? new Date().toISOString(),
    lastCollectedAt: new Date().toISOString(),
    collectRuns: (stats.collectRuns ?? 0) + 1,
    lastRunNewCount: normalized.length,
    lastRunFailures: failures,
  });

  if (failures.length > 0) {
    console.log(`\n[collect] ${failures.length} 个平台抓取失败（其余平台已正常写入）`);
  }
}

main().catch((error) => {
  console.error('[collect] 致命错误:', error);
  process.exit(1);
});
