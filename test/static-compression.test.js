'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { serveStatic } = require('../server');

function request(pathname, method = 'GET', headers = {}) {
  return new Promise(resolve => serveStatic({ method, headers }, {
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders || {}; },
    end(body) { resolve({ status: this.status, headers: this.headers, body: body || Buffer.alloc(0) }); },
  }, pathname));
}

test('gzip reduces static transfer, round-trips the source and keeps HEAD/304 representation headers consistent', async () => {
  const original = await request('/style.css');
  const zipped = await request('/style.css', 'GET', { 'accept-encoding': 'br, gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['Content-Encoding'], 'gzip');
  assert.equal(zipped.headers.Vary, 'Accept-Encoding');
  assert.ok(zipped.body.length < original.body.length / 2);
  assert.equal(zipped.headers['Content-Length'], zipped.body.length);
  assert.deepEqual(gunzipSync(zipped.body), original.body);
  assert.notEqual(zipped.headers.ETag, original.headers.ETag);
  const head = await request('/style.css', 'HEAD', { 'accept-encoding': 'gzip' });
  assert.deepEqual(head.headers, zipped.headers);
  assert.equal(head.body.length, 0);
  const cached = await request('/style.css', 'GET', { 'accept-encoding': 'gzip', 'if-none-match': 'W/' + zipped.headers.ETag });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers['Content-Length'], undefined);
  assert.equal(cached.headers['Content-Encoding'], 'gzip');
  assert.equal(cached.headers.Vary, 'Accept-Encoding');
  assert.equal((await request('/style.css', 'GET', { 'accept-encoding': 'gzip', 'if-none-match': original.headers.ETag })).status, 200);
});

test('encoding negotiation honors exclusions and identity preference without compressing binary assets', async () => {
  for (const value of ['gzip;q=0', '*;q=1,gzip;q=0', 'gzip;q=0.4,identity;q=0.8', 'br', 'gzip;q=invalid']) {
    const response = await request('/js/core.js', 'GET', { 'accept-encoding': value });
    assert.equal(response.status, 200, value);
    assert.equal(response.headers['Content-Encoding'], undefined, value);
  }
  for (const value of ['gzip;q=0,identity;q=0', '*;q=0', 'br,identity;q=0']) {
    assert.equal((await request('/js/core.js', 'GET', { 'accept-encoding': value })).status, 406, value);
  }
  assert.equal((await request('/js/core.js', 'GET', { 'accept-encoding': '*;q=0, gzip;q=0.5' })).headers['Content-Encoding'], 'gzip');
  assert.equal((await request('/js/core.js', 'GET', { 'accept-encoding': 'gzip ;q=1, identity;q=0' })).headers['Content-Encoding'], 'gzip');
  assert.equal((await request('/icons/icon-192.png', 'GET', { 'accept-encoding': 'gzip' })).headers['Content-Encoding'], undefined);
});

test('ETags follow actual bytes even when deployed file length and timestamps are unchanged', async t => {
  const originalRead = fs.readFile;
  const target = path.join(process.cwd(), 'public', 'style.css');
  let contents = Buffer.from('body { color: red; }');
  t.mock.method(fs, 'readFile', (file, ...args) => {
    if (file === target) return queueMicrotask(() => args.at(-1)(null, contents));
    return originalRead.call(fs, file, ...args);
  });
  const first = await request('/style.css');
  contents = Buffer.from('body { color: tan; }');
  const next = await request('/style.css', 'GET', { 'if-none-match': first.headers.ETag });
  assert.equal(next.status, 200);
  assert.equal(first.body.length, next.body.length);
  assert.notEqual(first.headers.ETag, next.headers.ETag);
  assert.equal(next.body.toString(), 'body { color: tan; }');
});
