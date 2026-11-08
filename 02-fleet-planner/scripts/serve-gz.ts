// Static server for dist/ that compresses like GitHub Pages (gzip for text, JSON, wasm and .glb), served under the
// Pages base path. Used by e2e, perf and the local click-through, because `vite preview` does not compress.
// Usage: tsx scripts/serve-gz.ts dist [port]   (port also from E2E_WEB_PORT; default 5180)
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const BASE_PATH = '/weekend-projects/02-fleet-planner/';
const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? process.env.E2E_WEB_PORT ?? 5180);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.gif': 'image/gif', '.txt': 'text/plain',
};
const GZIP = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.glb', '.bin', '.wasm', '.txt']);
const cache = new Map<string, Buffer>();

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/' || url.pathname === BASE_PATH.slice(0, -1)) {
    res.writeHead(302, { location: BASE_PATH });
    return res.end();
  }
  if (!url.pathname.startsWith(BASE_PATH)) {
    res.writeHead(404);
    return res.end('not under base path');
  }
  let rel = decodeURIComponent(url.pathname.slice(BASE_PATH.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403);
    return res.end();
  }
  let stamp = '';
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    res.writeHead(404);
    return res.end('not found');
  }
  const ext = extname(file).toLowerCase();
  const headers: Record<string, string> = { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' };
  let body: Buffer = readFileSync(file);
  if (GZIP.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    const key = `${file}@${stamp}`;
    let gz = cache.get(key);
    if (!gz) {
      gz = gzipSync(body, { level: 6 });
      cache.set(key, gz);
    }
    body = gz;
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
  }
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(port, '127.0.0.1', () => console.log(`serve-gz: http://localhost:${port}${BASE_PATH} (root ${root})`));
