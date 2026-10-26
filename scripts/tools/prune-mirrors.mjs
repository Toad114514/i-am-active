/**
 * 一次性维护工具：把 res/list.json 里「纯镜像」的 Gitee 卡清掉。
 *
 * 日常跑 `npm run collect` 时会自动做这件事（见 scripts/collect.mjs），这个脚本
 * 只是给「不想联网、只想整理现有数据」的场合用——它就本地跑一遍 sha 比对。
 *
 * 用法：
 *   node scripts/tools/prune-mirrors.mjs           # 只打印会删哪些
 *   node scripts/tools/prune-mirrors.mjs --write   # 真的写回 res/list.json
 *   node scripts/tools/prune-mirrors.mjs --registry # 从清理前的数据（git HEAD）重建
 *                                                  # res/mirrors.json 镜像登记表
 */
import { execFileSync } from 'node:child_process';
import { readList, writeList, writeMirrors } from '../lib/store.mjs';
import { config } from '../lib/config.mjs';
import {
  buildGitHubShaIndex,
  pruneMirroredCards,
  mirrorTargetFor,
  summarizeMirrors,
} from '../lib/mirrors.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const list = await readList();
const aliases = config.platforms?.gitee?.mirrors ?? {};
const index = buildGitHubShaIndex(list);

// 登记表要在「提交还没被丢掉」的数据上算，所以默认取 git HEAD 那一版 list.json
if (args.includes('--registry')) {
  let snapshot;
  try {
    snapshot = JSON.parse(
      execFileSync('git', ['show', 'HEAD:res/list.json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (error) {
    console.error(`读不到 HEAD 版本的 res/list.json：${error.message}`);
    process.exit(1);
  }
  const table = summarizeMirrors(snapshot, index, aliases);
  await writeMirrors(table);
  console.log(`已写入 res/mirrors.json，${Object.keys(table).length} 个镜像仓库：`);
  for (const [repo, entry] of Object.entries(table)) {
    console.log(`  ${repo.padEnd(22)} → ${entry.github ?? '(未对上)'}  ${entry.commits} 次提交 / ${entry.cards} 张卡`);
  }
  process.exit(0);
}

const giteeCards = list.filter((item) => item.platform === 'gitee' && item.meta?.repo);
const repos = [...new Set(giteeCards.map((item) => item.meta.repo))];
console.log(`Gitee 卡 ${giteeCards.length} 张，仓库 ${repos.length} 个：`);
for (const repo of repos) {
  const shas = mirrorTargetFor(repo, index, aliases)?.shas ?? null;
  const cards = giteeCards.filter((item) => item.meta.repo === repo);
  const bySha = new Set();
  for (const card of cards) for (const row of card.meta.changes ?? []) if (row.component) bySha.add(row.component);
  const hit = shas ? [...bySha].filter((sha) => shas.has(sha)).length : 0;
  const mirrored = shas ? `${hit}/${bySha.size} 条提交是镜像` : '未对上 GitHub 仓库（按独有处理）';
  console.log(`  ${repo.padEnd(22)} ${String(cards.length).padStart(2)} 张卡  ${mirrored}`);
}

const before = list.length;
const { removed } = pruneMirroredCards(list, index, aliases);
console.log(`\n可删除 ${removed.length} 张纯镜像卡；${before} → ${before - removed.length} 条`);

if (!write) {
  console.log('（未写回，加 --write 生效）');
} else if (removed.length) {
  await writeList(list);
  console.log('已写回 res/list.json');
} else {
  console.log('没有需要清理的卡');
}
