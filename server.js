'use strict';
/**
 * Markly —— 生活记录与学习监督
 * 组合根：装配数据库、应用、调度器，启动 HTTP 服务。
 * 启动：npm start  或  node --no-warnings server.js
 * 访问：http://127.0.0.1:8787
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const { gzip } = require('node:zlib');
const { promisify } = require('node:util');
const { URL } = require('url');
const { getDb, closeDb, createApp } = require('./src/app');
const scheduler = require('./src/scheduler');
const notify = require('./src/notify');
const { createWechat } = require('./src/wechat');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function bodyLimitForPath(pathname) {
  if (['/api/plan-import', '/api/internal/plan-drafts'].includes(pathname)) return 3e6;
  if (pathname === '/api/plan-bundles' || /^\/api\/plan-drafts\/[^/]+$/.test(pathname)) return 8e6;
  return 1e6;
}

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function readBody(req, pathname) {
  return new Promise((resolve, reject) => {
    const maxBytes = bodyLimitForPath(pathname || req.url?.split('?')[0] || '');
    const declaredLength = Number(req.headers?.['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      // Do not buffer a body we already know is too large.  Continue consuming
      // the stream so a normal 413 response can be sent on a keep-alive socket.
      // These listeners also prevent a client abort after the early rejection
      // from becoming an unhandled IncomingMessage error.
      req.on('aborted', () => {});
      req.on('error', () => {});
      req.resume?.();
      reject(requestError('request body too large', 413));
      return;
    }
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      if (byteLength > maxBytes) {
        // Retain neither the oversized chunk nor previous chunks.  Draining is
        // preferable to destroying the request: clients receive a clear 413.
        fail(requestError('request body too large', 413));
        req.resume?.();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      if (!byteLength) { settled = true; return resolve({}); }
      try {
        // Buffer.concat preserves UTF-8 sequences split across TCP chunks;
        // fatal decoding keeps malformed bytes from silently becoming U+FFFD.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, byteLength));
        const parsed = JSON.parse(text);
        settled = true;
        resolve(parsed);
      } catch { fail(requestError('invalid json', 400)); }
    });
    req.on('aborted', () => fail(requestError('request aborted', 400)));
    req.on('error', error => fail(error));
  });
}

function parseRequestUrl(req) {
  try { return new URL(req.url, `http://${req.headers?.host || '127.0.0.1'}`); }
  catch { return null; }
}

function staticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return null; }
  if (!decoded.startsWith('/') || decoded.includes('\0')) return null;
  const filePath = path.resolve(PUBLIC_DIR, '.' + decoded);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : filePath;
}

const compress = promisify(gzip);
const gzipCache = new Map(), gzipPending = new Map();
let gzipCacheBytes = 0;
const GZIP_CACHE_LIMIT = 8 * 1024 * 1024;
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);

function encodingFor(value, compressible) {
  if (!value) return 'identity';
  const weights = new Map();
  for (const part of String(value).toLowerCase().split(',')) {
    const [rawName, ...parameters] = part.trim().split(';');
    const name = rawName.trim();
    if (!name) continue;
    const quality = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
    const q = quality === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) ? Number(quality.slice(2)) : 0;
    weights.set(name, q);
  }
  const zipped = compressible ? (weights.get('gzip') ?? weights.get('*') ?? 0) : 0;
  const identity = weights.get('identity') ?? (weights.get('*') === 0 ? 0 : 1);
  if (zipped > 0 && (!weights.has('identity') || zipped >= identity)) return 'gzip';
  return identity > 0 ? 'identity' : zipped > 0 ? 'gzip' : null;
}

async function compressedAsset(buffer, digest) {
  const cached = gzipCache.get(digest);
  if (cached) { gzipCache.delete(digest); gzipCache.set(digest, cached); return cached; }
  if (gzipPending.has(digest)) return gzipPending.get(digest);
  const pending = compress(buffer).then(result => {
    if (result.length <= GZIP_CACHE_LIMIT) {
      while (gzipCache.size && (gzipCache.size >= 64 || gzipCacheBytes + result.length > GZIP_CACHE_LIMIT)) {
        const oldest = gzipCache.keys().next().value;
        gzipCacheBytes -= gzipCache.get(oldest).length;
        gzipCache.delete(oldest);
      }
      gzipCache.set(digest, result); gzipCacheBytes += result.length;
    }
    return result;
  }).finally(() => gzipPending.delete(digest));
  gzipPending.set(digest, pending);
  return pending;
}

function staticHeaders(filePath, buffer, encoding) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // HTML must always be fresh.  Other assets can be retained locally, but
    // validate using an ETag so unchanged scripts/styles do not cross the wire.
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=0, must-revalidate',
    // Hash the actual representation, including its content coding. A deploy
    // that preserves timestamps or file size must still invalidate old assets.
    'ETag': `"${buffer.length.toString(16)}-${crypto.createHash('sha256').update(buffer).digest('hex')}"`,
    'Content-Length': buffer.length,
    'Vary': 'Accept-Encoding',
    ...(encoding === 'gzip' ? { 'Content-Encoding': 'gzip' } : {}),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function etagMatches(value, etag) {
  return String(value || '').split(',').some(candidate => {
    const tag = candidate.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const filePath = staticPath(pathname);
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
  const serveFile = (target, allowAppFallback) => fs.stat(target, (statError, stat) => {
    if (statError || !stat.isFile()) {
      // Hash navigation is normally used by this app, but preserving an
      // extensionless fallback keeps existing bookmarked SPA URLs working.
      if (allowAppFallback && !path.extname(pathname)) return serveFile(path.join(PUBLIC_DIR, 'index.html'), false);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return res.end('Not found');
    }
    const encoding = encodingFor(req.headers?.['accept-encoding'], COMPRESSIBLE.has(path.extname(target).toLowerCase()));
    if (!encoding) {
      res.writeHead(406, { 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-store' });
      return res.end();
    }
    fs.readFile(target, async (readError, source) => {
      if (readError) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        return res.end('Not found');
      }
      try {
        const buf = encoding === 'gzip' ? await compressedAsset(source, crypto.createHash('sha256').update(source).digest('hex')) : source;
        if (res.destroyed || res.writableEnded) return;
        const headers = staticHeaders(target, buf, encoding);
        if (etagMatches(req.headers?.['if-none-match'], headers.ETag)) {
          delete headers['Content-Length'];
          res.writeHead(304, headers);
          return res.end();
        }
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : buf);
      } catch (error) {
        console.error('[static]', error.message);
        if (!res.headersSent) sendJson(res, 500, { error: '资源读取失败，请稍后重试' });
      }
    });
  });
  serveFile(filePath, true);
}

function start() {
  // Recovery must be able to start the HTTP process without opening/migrating
  // the restored database or replaying any queued external side effects.
  const maintenance = process.env.MAINTENANCE_MODE === '1';
  const db = maintenance ? null : getDb();
  const wechat = db ? createWechat(db) : null;
  wechat?.start().catch((error) => console.error('[wechat] 启动失败:', error.message));
  const app = db ? createApp(db, { wechat }) : null;
  const schedulerTimer = db ? scheduler.start(db) : null;
  const outboxWorker = db ? notify.startOutbox(db) : null;
  app?.deps?.planAgent?.start?.();

  const inFlightRequests = new Set();
  let stopping = false;
  const handleRequest = async (req, res) => {
    if (stopping) {
      req.resume();
      res.setHeader('Connection', 'close');
      return sendJson(res, 503, { error: '服务正在停止，请稍后再试。' });
    }
    const u = parseRequestUrl(req);
    if (!u) {
      console.error('[server] invalid request URL');
      if (!res.headersSent) sendJson(res, 400, { error: '请求地址不正确' });
      return;
    }
    const pathname = u.pathname;
    if (maintenance) {
      res.setHeader('Retry-After', '60');
      req.resume();
      if (pathname === '/healthz') return sendJson(res, 503, { status: 'maintenance' });
      if (pathname.startsWith('/api/')) return sendJson(res, 503, { error: '服务正在维护，请稍后再试。' });
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('服务正在维护，请稍后再试。');
    }
    if (pathname === '/healthz') {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }
      try {
        db.prepare('SELECT 1').get();
        return sendJson(res, 200, { status: 'ok' });
      } catch {
        return sendJson(res, 503, { status: 'unavailable' });
      }
    }
    if (pathname.startsWith('/api/')) {
      try {
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, pathname) : {};
        await app.dispatch(req.method, pathname, req, res, Object.fromEntries(u.searchParams) || {}, body);
      } catch (e) {
        console.error('[server] api error:', e);
        if (!res.headersSent) sendJson(res, e.statusCode || 500, e.statusCode === 400 ? { error: '请求格式不正确' } : e.statusCode === 413 ? { error: '请求体过大' } : { error: '服务器内部错误' });
      }
      return;
    }
    serveStatic(req, res, pathname);
  };
  const server = http.createServer((req, res) => {
    // Socket closure does not settle async handlers (password checks, imports,
    // model callbacks). Keep them alive until they stop accessing this DB.
    const pending = handleRequest(req, res).catch(error => {
      console.error('[server] request error:', error);
      if (!res.destroyed && !res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    }).finally(() => inFlightRequests.delete(pending));
    inFlightRequests.add(pending);
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  let backgroundStop;
  server.stopBackground = () => {
    if (backgroundStop) return backgroundStop;
    stopping = true;
    clearInterval(schedulerTimer);
    backgroundStop = Promise.all([
      outboxWorker?.stop(), app?.deps?.planAgent?.stop?.(), app?.deps?.platformAgent?.stop?.(), wechat?.stop(),
      Promise.allSettled([...inFlightRequests]),
    ]);
    return backgroundStop;
  };
  server.on('close', () => { server.stopBackground().catch(error => console.error('[shutdown]', error.message)); });

  server.listen(PORT, HOST, () => {
    console.log('========================================');
    console.log('  Markly · 生活记录与学习监督');
    const actualPort = server.address().port;
    console.log('  本机访问:   http://127.0.0.1:' + actualPort);
    console.log('  局域网访问: http://<本机IP>:' + actualPort);
    console.log('  数据库:     ' + require('./src/db').DB_PATH);
    if (maintenance) console.log('  维护模式:   已暂停业务访问、数据库初始化和全部后台任务');
    console.log('========================================');
  });
  return server;
}

module.exports = { start, parseRequestUrl, bodyLimitForPath, readBody, staticPath, serveStatic };

if (require.main === module) {
  const server = start();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const httpClosed = new Promise(resolve => server.close(resolve));
    Promise.all([httpClosed, server.stopBackground()]).then(() => { closeDb(); process.exit(0); })
      .catch(error => { console.error('[shutdown]', error.message); process.exit(1); });
    // 不在尚有网络回调时关闭数据库。强制退出后的租约可由下一次启动回收。
    setTimeout(() => process.exit(1), 45000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
