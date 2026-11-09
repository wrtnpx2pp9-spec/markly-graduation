'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { bodyLimitForPath, readBody, staticPath, serveStatic } = require('../server');

function bodyStream(chunks, headers = {}) {
  const req = Readable.from(chunks);
  req.headers = headers;
  req.url = '/api/tasks';
  return req;
}

function staticRequest(method, pathname, headers = {}) {
  return new Promise(resolve => {
    const res = {
      writeHead(status, responseHeaders = {}) { this.status = status; this.headers = responseHeaders; },
      end(body) { resolve({ status: this.status, headers: this.headers || {}, body: body || Buffer.alloc(0) }); },
    };
    serveStatic({ method, headers }, res, pathname);
  });
}

test('请求体按字节限流，并能正确拼接被分包的 UTF-8 JSON', async () => {
  const encoded = Buffer.from('{"title":"你好"}');
  const body = await readBody(bodyStream([encoded.subarray(0, 12), encoded.subarray(12)]), '/api/tasks');
  assert.deepEqual(body, { title: '你好' });
  await assert.rejects(readBody(bodyStream([Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])]), '/api/tasks'), { statusCode: 400 });
  await assert.rejects(readBody(bodyStream([], { 'content-length': '1000001' }), '/api/tasks'), { statusCode: 413 });
  assert.equal(bodyLimitForPath('/api/plan-import'), 3e6);
  assert.equal(bodyLimitForPath('/api/plan-drafts/example'), 8e6);
});

test('非法 JSON 必须结束请求并返回 400，不得让请求永久等待', { timeout: 2000 }, async () => {
  for (const content of ['{', '{"title":}', '{"title":"未闭合}', '   ', '{"x":1} trailing']) {
    await assert.rejects(readBody(bodyStream([Buffer.from(content)])), { statusCode: 400 });
  }
  assert.deepEqual(await readBody(bodyStream([])), {});
  assert.deepEqual(await readBody(bodyStream([Buffer.from('{"title":"正常请求"}')])), { title: '正常请求' });
});

test('请求体解析保留合法 JSON 值，由路由层校验对象结构', { timeout: 2000 }, async () => {
  for (const content of ['null', 'true', 'false', '1', '"title"', '[]', '[{}]']) {
    assert.deepEqual(await readBody(bodyStream([Buffer.from(content)])), JSON.parse(content));
  }
});

test('没有 Content-Length 的超大流仍受限制，中断请求及时拒绝', { timeout: 2000 }, async () => {
  await assert.rejects(readBody(bodyStream([Buffer.alloc(600000), Buffer.alloc(400001)])), { statusCode: 413 });
  const req = new PassThrough();
  req.headers = {};
  const result = assert.rejects(readBody(req), { statusCode: 400 });
  req.write('{"title":');
  req.emit('aborted');
  req.end();
  await result;
});

test('静态资源支持 ETag、HEAD，且不把缺失资源或越界路径伪装成首页', async () => {
  const asset = await staticRequest('GET', '/js/core.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.ETag, /^"[\da-f]+-[\da-f]+"$/);
  assert.equal(asset.headers['Cache-Control'], 'public, max-age=0, must-revalidate');
  assert.equal(Number(asset.headers['Content-Length']), asset.body.length);

  const cached = await staticRequest('GET', '/js/core.js', { 'if-none-match': asset.headers.ETag });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers['Content-Length'], undefined);

  const head = await staticRequest('HEAD', '/js/core.js');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['Content-Length']), asset.body.length);
  assert.equal((await staticRequest('GET', '/js/not-found.js')).status, 404);
  assert.equal((await staticRequest('POST', '/')).status, 405);
  assert.equal(staticPath('/%2e%2e/server.js'), null);
  assert.equal(staticPath('/js/core.js'), path.join(process.cwd(), 'public', 'js', 'core.js'));
});
