// Serves the built site (dist/) the three ways it gets hosted, to check
// that it works at any path:
//
//   /              plain root
//   /webcam-ink/   a GitHub Pages project path (no slash redirects to slash)
//   /lab/ink       a rewrite with no trailing slash and no redirect
//
//     npm run build && node tools/serve-paths.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.argv[2] ?? 5182);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.json': 'application/json',
};

async function send(res, relative) {
  const path = normalize(join(dist, relative));
  if (!path.startsWith(dist)) return false;
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(await readFile(path));
  return true;
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let relative = null;
  if (path === '/webcam-ink') {
    res.writeHead(301, { location: '/webcam-ink/' });
    res.end();
    return;
  }
  if (path === '/lab/ink') relative = 'index.html';
  else if (path.startsWith('/lab/ink/')) relative = path.slice('/lab/ink/'.length) || 'index.html';
  else if (path.startsWith('/webcam-ink/')) relative = path.slice('/webcam-ink/'.length) || 'index.html';
  else relative = path.slice(1) || 'index.html';

  if (!(await send(res, relative))) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(port, () => console.log(`serving dist at http://localhost:${port}/, /webcam-ink/ and /lab/ink`));
