/**
 * Steam 成就获取记录（可选）。
 *
 * 关键点（实测）：
 *  - 正确的接口名是 `ISteamUserStats/GetPlayerAchievements/v1/`（不是 ISteamUser），
 *    `GetOwnedGames` 属于 `IPlayerService`。
 *  - 必须提供 apiKey 与 steamId64，否则 400/403。
 *  - 未配置密钥时安静跳过（config.yaml 里默认 enabled: false）。
 */
import { getJson } from '../lib/http.mjs';
import { platform } from '../lib/config.mjs';

const STEAM_API = 'https://api.steampowered.com';

/** 从配置解析 SteamID64 与要关注的 AppID 列表。 */
function steamConfig() {
  const config = platform('steam');
  const appIds = (Array.isArray(config.appIds) ? config.appIds : [config.appIds])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  return {
    apiKey: String(config.apiKey ?? '').trim(),
    steamId64: String(config.steamId64 ?? '').trim(),
    appIds,
  };
}

/**
 * @returns {Promise<Array<object>>}
 */
export async function fetchSteam() {
  const { apiKey, steamId64, appIds } = steamConfig();
  if (!apiKey || !steamId64) {
    console.warn('[steam] 缺少 steam.apiKey 或 steam.steamId64，跳过');
    return [];
  }

  const items = [];

  for (const appid of appIds) {
    const params = new URLSearchParams({
      steamid: steamId64,
      appid: String(appid),
      key: apiKey,
      l: 'schinese',
    });
    try {
      const data = await getJson(
        `${STEAM_API}/ISteamUserStats/GetPlayerAchievements/v1/?${params}`,
        { timeoutMs: 20000, retries: 1 },
      );
      const stats = data?.playerstats ?? {};
      const gameName = stats.gameName ?? `App ${appid}`;
      for (const achievement of stats.achievements ?? []) {
        if (!achievement.unlocked || !achievement.unlockedtime) continue;
        items.push({
          id: `steam:${appid}:${achievement.achievementid}`,
          platform: 'steam',
          type: '成就解锁',
          title: achievement.name || achievement.apiname || '未命名成就',
          summary:
            achievement.description ||
            `在《${gameName}》中解锁成就「${achievement.name ?? ''}」`,
          url: `https://steamcommunity.com/profiles/${steamId64}/stats/${appid}/achievements`,
          image: achievement.iconurl || achievement.icon || null,
          timestamp: new Date(achievement.unlockedtime * 1000).toISOString(),
          meta: { appid, achievementId: achievement.achievementid, gameName },
        });
      }
    } catch (error) {
      console.warn(`[steam] appid=${appid} 获取失败: ${error.message}`);
    }
  }

  return items;
}
