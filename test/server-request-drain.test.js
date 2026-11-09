'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
process.env.DB_PATH = ':memory:';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.MAINTENANCE_MODE = '0';

test('断连的登录仍在校验密码时，停止必须等待处理完再允许关闭数据库', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-request-drain-'));
  process.env.ILINK_STATE_DIR = path.join(temporary, 'ilink');
  const database = require('../src/db');
  const security = require('../src/security');
  const db = database.getDb();
  const user = require('../src/repo/user.repo').insert(db, {
    username: 'request-drain-admin', role: 'admin', displayName: '管理员',
    passwordHash: 'test-only-hash', salt: 'test-only-salt', createdAt: Date.now(),
  });
  const originalVerify = security.verifyPasswordAsync;
  let arrived, release;
  const entered = new Promise(resolve => { arrived = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  security.verifyPasswordAsync = async () => { arrived(); await held; return true; };
  const server = require('../server').start();
  let closed = false, request;
  t.after(async () => {
    release();
    request?.destroy();
    if (!closed) await new Promise(resolve => server.close(resolve));
    await server.stopBackground();
    security.verifyPasswordAsync = originalVerify;
    database.closeDb();
    const target = path.resolve(temporary);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('markly-request-drain-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  if (!server.listening) await once(server, 'listening');
  request = http.request({
    host: '127.0.0.1', port: server.address().port,
    path: '/api/auth/login', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  request.on('error', () => {});
  request.end(JSON.stringify({ username: user.username, password: 'isolated-password' }));
  await entered;
  const disconnected = new Promise(resolve => request.once('close', resolve));
  request.destroy();
  await disconnected;
  await new Promise(resolve => server.close(() => { closed = true; resolve(); }));
  const stopping = server.stopBackground();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped, false, 'HTTP 连接结束后仍有异步请求访问数据库');
  release();
  await stopping;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(user.id).n, 1,
    '登录回调必须在停止返回前完成持久化');
  database.closeDb();
  await new Promise(resolve => setTimeout(resolve, 20));
});
