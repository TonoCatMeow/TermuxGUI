import fs from 'fs';
import http from 'http';
import path from 'path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
};

/**
 * Minimal dependency-free static file server for "static site" apps.
 * Serves `root` with index.html for directories, correct content types,
 * and path-traversal protection. Runs in-process — no child process needed.
 */
export function createStaticServer(root: string, onLog: (line: string) => void): http.Server {
  const rootResolved = path.resolve(root);

  return http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
        return;
      }

      let urlPath: string;
      try {
        urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
        return;
      }

      let filePath = path.resolve(rootResolved, `.${urlPath}`);
      if (!filePath.startsWith(rootResolved + path.sep) && filePath !== rootResolved) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
          stat = fs.statSync(filePath);
        }
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        onLog(`404 ${req.url}`);
        return;
      }

      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      onLog(`200 ${req.url}`);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error');
      } catch {
        /* socket already gone */
      }
      onLog(`500 ${req.url} — ${String(err)}`);
    }
  });
}
