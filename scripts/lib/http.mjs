/**
 * 统一的 HTTP 客户端：超时、重试、UA、Cookie 罐子、限速。
 * 所有抓取器共用，便于统一处理风控与重试。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 简单的 Cookie 罐：支持 set-cookie 收集与请求头拼装。 */
export class CookieJar {
  constructor(initial = {}) {
    /** @type {Map<string,string>} */
    this.jar = new Map(Object.entries(initial));
  }

  absorb(response) {
    const cookies = response.headers?.getSetCookie?.() ?? [];
    for (const raw of cookies) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/max-age=0/i.test(raw) || /expires=thu, 01 jan 1970/i.test(raw)) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
    return this;
  }

  set(name, value) {
    this.jar.set(name, value);
    return this;
  }

  get(name) {
    return this.jar.get(name) ?? null;
  }

  header() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * 带超时与重试的 fetch。
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, retries?: number, retryDelayMs?: number}} [options]
 */
export async function http(url, options = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    retryDelayMs = 700,
    headers = {},
    ...rest
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        ...rest,
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new HttpError(`HTTP ${response.status} ${url}`, {
          status: response.status,
          body: body.slice(0, 400),
          url,
        });
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** 请求并解析 JSON。 */
export async function getJson(url, options = {}) {
  const response = await http(url, {
    ...options,
    headers: { Accept: 'application/json, text/plain, */*', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`响应不是合法 JSON: ${url}`, {
      body: text.slice(0, 400),
      url,
    });
  }
}

/** 请求并返回文本。 */
export async function getText(url, options = {}) {
  const response = await http(url, options);
  return response.text();
}

/** 带 cookie 罐的 GET。 */
export async function getJsonWithJar(url, jar, options = {}) {
  const cookie = jar.header();
  const response = await http(url, {
    ...options,
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  jar.absorb(response);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`响应不是合法 JSON: ${url}`, { body: text.slice(0, 400), url });
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成 32 位小写十六进制随机串（Bilibili buvid_fp 等）。 */
export function randomHex(length = 32) {
  let out = '';
  while (out.length < length) {
    out += Math.random().toString(16).slice(2);
  }
  return out.slice(0, length);
}
