/**
 * 美术图回填：把已经进了列表的老条目，按**当前**的取图规则重取一次背景图。
 *
 * 为什么需要单独一个脚本：
 *   增量抓取只看「最近回看窗口」里的活动（RA 默认 3 天），而背景图优先级
 *   这类展示规则是会变的（RA 从「标题画面优先」改成「封面优先」）。规则一改，
 *   窗口里的新条目当场就用上新图，但更老的条目永远停在旧规则那张图上——
 *   它们不会再次被抓到，也就没有机会被「补全」。
 *
 * 只处理 RetroAchievements：
 *   RA 的封面/截图要按 gameId 现查（API_GetGame），存下来的是当时的 URL；
 *   Steam 的头图是 `apps/<appid>/header.jpg`，纯推导、不会过期，没有回填的必要。
 *
 * 幂等：只重查 `backdropSource` 缺失或是 `title` 的游戏（`title` 就是旧规则
 * 留下的痕迹，而 `ingame` 说明这款游戏确实没有封面，再查也一样）。
 * 因此第一次跑完之后，后续每次都是空跑，不会每小时去骚扰 API。
 *
 * 用法：
 *   node scripts/art-refresh.mjs            # 回填并写回 res/list.json
 *   node scripts/art-refresh.mjs --dry-run  # 只打印，不写文件
 */
import { readList, writeList } from './lib/store.mjs';
import { gameArtFor } from './sources/retroachievements.mjs';

/** 单轮最多重查多少款游戏（防止某天列表里突然堆了一堆老 gameId）。 */
const MAX_GAMES = 30;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

async function main() {
  const list = await readList();
  const raItems = list.filter((item) => item.platform === 'retroachievements');

  // gameId → 该游戏下所有条目
  const byGame = new Map();
  for (const item of raItems) {
    const gameId = Number(item.meta?.gameId);
    if (!gameId) continue;
    if (!byGame.has(gameId)) byGame.set(gameId, []);
    byGame.get(gameId).push(item);
  }

  // 只挑「可能被新规则改善」的游戏
  const stale = [...byGame.entries()].filter(([, items]) =>
    items.some((item) => {
      const source = item.meta?.backdropSource ?? null;
      return !source || source === 'title';
    }),
  );

  if (!stale.length) {
    console.log('[art] 没有需要回填的条目（全部已是当前优先级下的图）');
    return;
  }

  const todo = stale.slice(0, MAX_GAMES);
  if (stale.length > todo.length) {
    console.log(`[art] 待回填 ${stale.length} 款游戏，本轮只处理前 ${todo.length} 款`);
  }

  let updatedItems = 0;
  let updatedGames = 0;
  let failures = 0;

  for (const [gameId, items] of todo) {
    const art = await gameArtFor(gameId);
    if (!art?.backdrop) {
      failures += 1;
      console.log(`[art] 游戏 ${gameId}：没取到图（可能 key 未配置），保持原样`);
      continue;
    }

    // 先把「改动前」的图源记下来，循环里就被覆盖了
    const from = [...new Set(items.map((i) => i.meta?.backdropSource ?? '无'))].join('/');
    let changed = 0;
    for (const item of items) {
      const before = item.meta?.backdrop ?? null;
      const beforeSource = item.meta?.backdropSource ?? null;
      item.meta = {
        ...(item.meta ?? {}),
        backdrop: art.backdrop,
        backdropSource: art.source ?? null,
      };
      // 成就条目缺角标时顺手补上（只用成就自己的徽章，不拿游戏图顶）
      if (item.meta.achievementId && !item.meta.badge) {
        item.meta.badge = item.meta.badgeUrl ?? item.image ?? null;
      }
      if (before !== art.backdrop || beforeSource !== (art.source ?? null)) changed += 1;
    }

    if (changed) {
      updatedGames += 1;
      updatedItems += changed;
      console.log(`[art] 游戏 ${gameId}：图源 ${from} → ${art.source}，更新 ${changed} 条`);
    } else {
      console.log(`[art] 游戏 ${gameId}：已经是 ${art.source}，无需改动`);
    }
  }

  console.log(
    `\n[art] 共检查 ${todo.length} 款游戏，更新 ${updatedGames} 款 / ${updatedItems} 条` +
      (failures ? `，${failures} 款取图失败` : ''),
  );

  if (dryRun) {
    console.log('[art] --dry-run，未写入任何文件');
    return;
  }
  if (!updatedItems) return;

  await writeList(list);
  console.log('[art] res/list.json 已写回');
}

main().catch((error) => {
  console.error('[art] 失败:', error.message);
  process.exit(1);
});
