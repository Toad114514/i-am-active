/**
 * 本地预览服务器：把 dist/ 挂到 /i-am-active/ 下（与线上路径一致）。
 * 用法：node scripts/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DIST_DIR } from './lib/store.mjs';

const PORT = Number(process.argv[2] || 8080);
const BASE = process.env.SITE_BASE || '/i-am-active';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const body = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/' || pathname === BASE) {
      res.writeHead(302, { Location: `${BASE}/` });
      res.end();
      return;
    }
    if (!pathname.startsWith(BASE)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — 请访问 ' + BASE + '/');
      return;
    }
    pathname = pathname.slice(BASE.length) || '/';

    let filePath = path.join(DIST_DIR, pathname);
    // 防目录穿越
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end('403');
      return;
    }

    if (existsSync(filePath) && (await stat(filePath)).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      filePath = path.join(DIST_DIR, '404.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(filePath));
      return;
    }

    await serveFile(res, filePath);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error));
  }
});

server.listen(PORT, () => {
  console.log(`[serve] http://localhost:${PORT}${BASE}/`);
});
