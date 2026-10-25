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
import { pathToFileURL } from 'node:url';

import { fetchBilibili } from './sources/bilibili.mjs';
import { fetchYouTube } from './sources/youtube.mjs';
import { fetchArchive } from './sources/archive.mjs';
import { fetchRetroAchievements, lastRaDiagnostics } from './sources/retroachievements.mjs';
import { fetchWeblate } from './sources/weblate.mjs';
import { fetchGitHub, lastGitHubDiagnostics } from './sources/github.mjs';
import { fetchGitee, lastGiteeDiagnostics } from './sources/gitee.mjs';
import { fetchSteam, lastSteamDiagnostics } from './sources/steam.mjs';
import { fetchOttoHub } from './sources/ottohub.mjs';
import { fetchKuaishou } from './sources/kuaishou.mjs';

/** 所有抓取器：每个平台一个独立模块，互不影响。 */
const SOURCES = [
  { id: 'bilibili', label: '哔哩哔哩', run: fetchBilibili },
  { id: 'youtube', label: 'YouTube', run: fetchYouTube },
  { id: 'ottohub', label: 'OTTOhub', run: fetchOttoHub },
  { id: 'kuaishou', label: '快手', run: fetchKuaishou },
  { id: 'github', label: 'GitHub', run: fetchGitHub, diagnostics: lastGitHubDiagnostics },
  { id: 'gitee', label: 'Gitee', run: fetchGitee, diagnostics: lastGiteeDiagnostics },
  { id: 'archive', label: '互联网档案馆', run: fetchArchive },
  { id: 'weblate', label: 'Weblate', run: fetchWeblate },
  {
    id: 'retroachievements',
    label: 'RetroAchievements',
    run: fetchRetroAchievements,
    diagnostics: lastRaDiagnostics,
  },
  { id: 'steam', label: 'Steam', run: fetchSteam, diagnostics: lastSteamDiagnostics },
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
export function applyMerged(list, item) {
  const winStart = Date.parse(item.meta?.windowStart ?? item.timestamp ?? '') || 0;
  const winEnd = Date.parse(item.meta?.windowEnd ?? item.timestamp ?? '') || Number.MAX_SAFE_INTEGER;

  const removed = [];
  /** 新卡的时段只是某张旧卡的尾巴（抓到残缺数据）→ 整张丢掉，保留旧的完整卡。 */
  let dropNew = false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const old = list[i];
    if (old.platform !== item.platform) continue;

    if (old.meta?.merge) {
      // 同一张卡：id 相同还要看数据完整度——翻页边界一变，同一时段的抓取结果可能
      // 只覆盖后半截，拿它覆盖完整卡就会把卡片「截断」（页面上表现为条数少了一截）。
      if (old.id === item.id) {
        const os = Date.parse(old.meta?.windowStart ?? '');
        const oe = Date.parse(old.meta?.windowEnd ?? '');
        const oldRows = old.meta?.changes?.length ?? 0;
        const newRows = item.meta?.changes?.length ?? 0;
        if (
          Number.isFinite(os) &&
          Number.isFinite(oe) &&
          os <= winStart &&
          oe >= winEnd &&
          oldRows > newRows
        ) {
          dropNew = true;
        }
        continue;
      }
      const os = Date.parse(old.meta?.windowStart ?? '');
      const oe = Date.parse(old.meta?.windowEnd ?? '');
      if (!Number.isFinite(os) || !Number.isFinite(oe)) continue;
      // 两个条目都带 meta.repo（GitHub / Gitee 的仓库卡）时，只跟自己仓库比：
      // 一张覆盖多年时段的仓库卡会把时间范围更窄的、别的仓库的卡也包进去，
      // 不加这层判断就会被误删。
      const bothHaveRepo = Boolean(item.meta?.repo) && Boolean(old.meta?.repo);
      const sameRepo = bothHaveRepo && old.meta.repo === item.meta.repo;
      const comparable = !bothHaveRepo || sameRepo;

      // 非仓库型汇总（Weblate 的译文时段）：时段之间本来就不该重叠。
      // 一旦重叠，说明是同一批数据的两次抓取——翻页边界不同，起点会差一截，
      // 于是同一段工作会变成两张卡（其中一张还短一截，看着像被截断）。
      // 处理原则是按「谁覆盖得更全」留一张：
      //   新卡完整包住旧卡 → 换掉旧的（数据更新了）
      //   旧卡完整包住新卡 → 新卡只是残缺的重复，整张丢弃
      if (!bothHaveRepo && os <= winEnd && oe >= winStart) {
        const newCoversOld = winStart <= os && winEnd >= oe;
        if (newCoversOld) {
          removed.push(old.id);
          list.splice(i, 1);
        } else {
          dropNew = true;
        }
        continue;
      }

      const subset = comparable && os >= winStart && oe <= winEnd;
      // 同一张卡换了 id 又和老的重叠（窗口边界滑动导致的），也应当替换掉，
      // 否则同一批工作会在列表里留下两张几乎一样的卡。
      const overlap = sameRepo && os <= winEnd && oe >= winStart;
      if (subset || overlap) {
        removed.push(old.id);
        list.splice(i, 1);
      }
      continue;
    }

    // 汇总卡只吸收自己仓库的逐条旧记录（老数据迁移）。
    // 不按仓库区分的话，一张覆盖很宽时段的卡会把别的仓库的记录一起吞掉。
    if (item.meta?.repo && old.meta?.repo && old.meta.repo !== item.meta.repo) continue;

    const t = old.timestamp ? Date.parse(old.timestamp) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t >= winStart && t <= winEnd) {
      removed.push(old.id);
      list.splice(i, 1);
    }
  }

  if (dropNew) return { added: false, updated: false, removed, skipped: true };

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

      const brandNew = [];
      let enrichedCount = 0;
      for (const item of plain) {
        if (!known.has(item.id)) {
          known.add(item.id);
          brandNew.push(item);
          continue;
        }
        // 同 id 已存在：只补本轮新出现的字段（例如后来才加上的 meta.backdrop /
        // meta.badge），已有值不动、顺序不动、也不算新增。否则老条目永远拿不到
        // 新加的展示字段——它们不会被重新「新增」，只会被去重跳过。
        const target = working.find((entry) => entry.id === item.id);
        if (!target) continue;
        let changed = false;
        for (const [key, value] of Object.entries(item.meta ?? {})) {
          if (value === undefined || value === null || value === '') continue;
          const current = target.meta?.[key];
          // backdrop / badge 是从源站「推导」出来的展示字段：规则一变（比如 RA 从
          // 游戏内截图改成优先封面）老条目就该跟着变，不然永远是旧图。
          const derived = key === 'backdrop' || key === 'badge' || key === 'backdropSource';
          if (derived || current === undefined || current === null || current === '') {
            if (current === value) continue;
            target.meta = { ...(target.meta ?? {}), [key]: value };
            changed = true;
          }
        }
        if (!target.image && item.image) {
          target.image = item.image;
          changed = true;
        } else if (
          // 站点自己托管的图（`media/` 相对路径）：必须覆盖老条目里那条
          // 「当初存下来的远程链接」——OTTOhub 的封面是带签名的，存的当天能看，
          // 第二天就 403，不覆盖的话老条目永远没有封面。
          item.image &&
          String(item.image).startsWith('media/') &&
          target.image !== item.image
        ) {
          target.image = item.image;
          changed = true;
        }
        if (changed) enrichedCount += 1;
      }
      fresh.push(...brandNew);
      touched.push(...brandNew);
      addedCount += brandNew.length;

      state.lastRun[source.id] = new Date().toISOString();
      // 抓取器如果留了现场信息（比如 Steam 为什么一条都没抓到），一起进 state.json，
      // 之后直接看仓库就能排障，不用翻 CI 日志。
      const diag = source.diagnostics?.();
      if (diag) state.diagnostics = { ...(state.diagnostics ?? {}), [source.id]: diag };
      addedTotal += addedCount;

      const extra = absorbed ? `，吸收旧记录 ${absorbed} 条` : '';
      const updateText = updatedCount ? `，更新汇总 ${updatedCount} 条` : '';
      const enrichText = enrichedCount ? `，补全 ${enrichedCount} 条老记录` : '';
      console.log(
        `[collect] ${source.label.padEnd(18)} 抓到 ${String(items.length).padStart(3)} 条，新增 ${String(addedCount).padStart(3)} 条${updateText}${enrichText}${extra} (${elapsed}s)`,
      );
    } catch (error) {
      failures.push({ id: source.id, message: error.message });
      console.error(`[collect] ${source.label.padEnd(18)} 失败: ${error.message}`);
    }
  }

  // RetroAchievements：把新成就登记进 res/ralist.json
  // 游玩记录不进：它的 id 已经自带 LastPlayed，重复抓到也只会命中同一条，不需要再留档。
  const raFresh = fresh.filter(
    (item) => item.platform === 'retroachievements' && item.meta?.kind !== 'play-session',
  );
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

// 直接 `node scripts/collect.mjs` 时才开始跑；被别的脚本 import（比如回归测试
// 单独验证 applyMerged）时只导出函数，不产生副作用。
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error('[collect] 致命错误:', error);
    process.exit(1);
  });
}
