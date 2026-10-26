/**
 * 配置加载：根目录 config.yaml 是唯一的配置来源。
 *
 * 设计要点：
 *  - 没有 config.yaml 也能跑：全部字段回落到这里的内置默认值（与改造前硬编码一致）。
 *  - 值里可以写 `${ENV_NAME}` 或 `${ENV_NAME:-默认值}`，运行时从环境变量取，
 *    这样密钥能放 GitHub Actions Secrets，而不用写进仓库。
 *  - 启用的平台必须填齐必填项，缺了直接报错并指明是哪个键，避免抓取时静默返回空。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 可用环境变量 CONFIG_FILE 指向别的配置文件（测试/多环境用）。 */
export const configPath = process.env.CONFIG_FILE
  ? path.resolve(process.env.CONFIG_FILE)
  : path.join(ROOT, 'config.yaml');

/** 内置默认值：字段与改造前各抓取器里的硬编码常量一一对应。 */
const DEFAULTS = {
  site: {
    base: '/i-am-active',
  },
  collect: {
    /** true = 每个平台只抓上次运行以来的增量 */
    incremental: true,
  },
  platforms: {
    bilibili: {
      enabled: true,
      mid: '3494381151586530',
      /** 匿名请求概率性风控，需要多次换指纹重试 */
      retries: 14,
      /** 可选登录态；没有时匿名抓最近一页 */
      cookie: '',
    },
    youtube: {
      enabled: true,
      /** 频道 ID（不是 handle）；只用于抓取 */
      channelId: 'UCuNJ-CHkXLcOf41aoip4x5w',
      /** 频道 handle，用于拼主页地址 */
      handle: '@toad1145',
      /** 可选：配了就走 Data API，没配就走 RSS */
      apiKey: '',
    },
    ottohub: {
      enabled: true,
      uid: 22067,
    },
    kuaishou: {
      enabled: true,
      profileId: 'xn57ehqqzfdqie',
      /** 需要登录态时填 Cookie（一般做不到，留空则该平台无数据） */
      cookie: '',
    },
    github: {
      enabled: true,
      user: 'Toad114514',
      /** 可选：不填就是匿名 60 次/小时，很容易限流 */
      token: '',
      /**
       * 汇总窗口（天），0 = 全历史。仓库卡是「这个仓库的全部操作」，
       * 所以默认不限时间——带 since 的话窗口边界每天推进一点，
       * 卡里最老的几条提交会一天天静默消失。
       */
      lookbackDays: 0,
      /** 同一仓库相邻两次操作间隔超过这个分钟数，就算另一次动工 */
      sessionGapMinutes: 90,
      /** 单页条数（GitHub 上限 100）+ 每个仓库最多翻几页 */
      perPage: 100,
      maxPages: 2,
      /** 单张汇总卡最多保留多少条明细 */
      maxRows: 300,
      /** 最多查多少个仓库 */
      maxRepos: 40,
    },
    gitee: {
      enabled: true,
      user: 'toadstool',
      lookbackDays: 0,
      sessionGapMinutes: 90,
      perPage: 100,
      maxPages: 2,
      maxRows: 300,
      maxRepos: 40,
      /** 镜像仓库声明：Gitee 短名 → GitHub 仓库（只写改过名的，短名相同会自动认） */
      mirrors: {},
    },
    archive: {
      enabled: true,
      user: 'toad1145',
    },
    codemao: {
      enabled: true,
      userId: '',
      /** 首轮全量 init 时每页条数与最多翻几页（接口上限 100） */
      pageSize: 100,
      maxPages: 3,
      /** 之后每轮只取第一页这么多条，盯新作品 */
      incrementalLimit: 20,
    },
    weblate: {
      enabled: true,
      baseUrl: 'https://mirror.git.trinitydesktop.org/weblate',
      user: 'toad114514',
      /** 相邻改动间隔超过这个分钟数就算新的「翻译时段」，一个时段汇总成一条 */
      sessionGapMinutes: 120,
      lookbackDays: 7,
      /** 单条汇总最多保留多少行逐条明细 */
      maxRows: 400,
      maxPages: 4,
      pageSize: 50,
    },
    hexo: {
      enabled: true,
      /** hexo-generator-feed 的 Atom；本站点只有 atom.xml 有内容 */
      feedUrl: 'https://toad.ccwu.cc/atom.xml',
      /** feed 里的链接写的是 github.io，展示统一换成自定义域 */
      siteUrl: 'https://toad.ccwu.cc',
    },
    retroachievements: {
      enabled: true,
      user: 'Toad114514',
      /** https://retroachievements.org/settings 的 Keys 区域生成 */
      webApiKey: '',
      /** 首轮回溯多少天；之后按上次运行时间收窄 m 参数 */
      lookbackDays: 60,
      /** 每轮至少回看多少分钟（默认 3 天）：上次运行失败时也能把漏掉的补回来 */
      minWindowMinutes: 4320,
      maxItems: 60,
      /** 先用 GetUserProfile 校验用户名与 key */
      profileCheck: true,
      /** 记录「最近玩过的游戏」，没解锁成就也能看见 */
      playSessions: true,
      /** 单轮最多看几款最近玩过的游戏 */
      maxGames: 10,
      /** 取游戏截图/封面当条目背景（每款游戏一次 API_GetGame 请求） */
      gameArt: true,
      /** 单轮最多给几款游戏取图，防止条目爆炸时打太多请求 */
      maxGameArt: 20,
    },
    steam: {
      enabled: false,
      steamId64: '',
      apiKey: '',
      recentGames: true,
      playSessions: true,
      maxGames: 10,
      maxItems: 60,
      extraAppIds: [],
    },
  },
};

/** 启用的平台必须提供的字段（密钥类不在此列，缺了由对应模块给出提示）。 */
const REQUIRED = {
  bilibili: ['mid'],
  youtube: ['channelId'],
  ottohub: ['uid'],
  kuaishou: ['profileId'],
  github: ['user'],
  gitee: ['user'],
  archive: ['user'],
  codemao: ['userId'],
  weblate: ['baseUrl', 'user'],
  retroachievements: ['user'],
  steam: ['steamId64'],
};

const SECRET_KEYS = new Set(['token', 'apiKey', 'webApiKey', 'cookie']);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 深合并：用户配置覆盖默认值，缺的键保留默认。 */
function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** 把字符串里的 ${VAR} / ${VAR:-默认} 换成环境变量值。 */
function resolveEnvString(value) {
  return value.replace(ENV_REF, (_, name, fallback) => {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined) return fromEnv;
    return fallback !== undefined ? fallback : '';
  });
}

/**
 * 整个值就是一个 ${VAR} 时，允许按字面量还原类型（数字/布尔）。
 *
 * 超过 2^53 的整数（SteamID64 是 17 位）在 JS 里存不精确：
 * Number('76561198012345678') 会变成 76561198012345680，末尾两位被抹掉，
 * 于是请求带着错的 ID 去查，Steam 只会回「查不到」。这类值一律保留字符串。
 */
function coerce(text) {
  if (/^(true|false)$/.test(text)) return text === 'true';
  if (/^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  return text;
}

function resolveEnvDeep(value) {
  if (typeof value === 'string') {
    const single = value.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/);
    if (single) {
      const fromEnv = process.env[single[1]];
      const resolved = fromEnv !== undefined ? fromEnv : (single[2] ?? '');
      return coerce(resolved);
    }
    return resolveEnvString(value);
  }
  if (Array.isArray(value)) return value.map(resolveEnvDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveEnvDeep(item);
    return out;
  }
  return value;
}

/** 读取并解析配置；文件不存在则只用默认值。 */
export function loadConfig() {
  const warnings = [];
  let userConfig = {};

  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8');
    let parsed;
    try {
      parsed = parseYaml(text, { file: path.basename(configPath) });
    } catch (error) {
      throw new Error(`配置文件解析失败 → ${error.message}`);
    }
    if (parsed !== null && !isPlainObject(parsed)) {
      throw new Error(`配置文件顶层必须是映射（key: value），实际是 ${typeof parsed}`);
    }
    userConfig = parsed ?? {};
  } else {
    warnings.push(`未找到 ${path.basename(configPath)}，全部使用内置默认值`);
  }

  const merged = merge(DEFAULTS, userConfig);

  for (const key of Object.keys(merged.platforms)) {
    if (!(key in DEFAULTS.platforms)) {
      warnings.push(`config.yaml 里的未知平台 "${key}" 会被忽略`);
    }
  }

  const config = resolveEnvDeep(merged);

  // 平台必填项校验：只校验启用的平台。
  // 缺字段时**不禁用整个任务**，只把该平台标记为不可用并在 warnings 里说清楚——
  // 否则一个 Secret 没配好就会连带 build 一起失败，站点整轮停止更新（真踩过）。
  const invalid = new Set();
  for (const [id, platform] of Object.entries(config.platforms)) {
    if (!(id in DEFAULTS.platforms)) continue;
    if (!isPlainObject(platform)) {
      throw new Error(
        `config.yaml: 平台 ${id} 必须写成映射（缩进的 key: value），实际是 ${JSON.stringify(platform)}`,
      );
    }
    if (platform.enabled === false) continue;
    for (const field of REQUIRED[id] ?? []) {
      const value = platform[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        invalid.add(id);
        warnings.push(
          `平台 ${id} 已启用，但缺少必填项 ${id}.${field}，本轮跳过该平台（其它平台照常）`,
        );
      }
    }
  }

  config.invalidPlatforms = [...invalid];
  config.warnings = warnings;
  return config;
}

export const config = loadConfig();

/** 取某个平台的配置（未知平台返回空对象，便于安全读取）。 */
export function platform(id) {
  return config.platforms[id] ?? {};
}

/** 启用的平台 id 列表，顺序与内置定义一致；缺必填项的平台会被排除。 */
export function enabledPlatformIds() {
  const invalid = new Set(config.invalidPlatforms ?? []);
  return Object.keys(DEFAULTS.platforms).filter(
    (id) => config.platforms[id]?.enabled !== false && !invalid.has(id),
  );
}

/** 把密钥打码，用于 --show-config 打印。 */
export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && typeof item === 'string' && item) {
      out[key] = `${item.slice(0, 4)}****（已设置，长度 ${item.length}）`;
    } else {
      out[key] = maskSecrets(item);
    }
  }
  return out;
}

export { DEFAULTS };
