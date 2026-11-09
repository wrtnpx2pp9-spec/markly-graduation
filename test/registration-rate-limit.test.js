'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-registration-limit-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const { getDb, closeDb } = require('../src/db');
const users = require('../src/repo/user.repo');
const { createApp } = require('../src/app');
const db = getDb();
users.insert(db, { username: 'admin', role: 'admin', displayName: '管理员', passwordHash: 'x', salt: 'x', createdAt: Date.now() });
const app = createApp(db);

async function call(body, serial = '198.51.100.9') {
  let result;
  await app.dispatch('POST', '/api/auth/register', { socket: { remoteAddress: serial }, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { statusCode: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}

test('invalid forms have a separate bucket and do not consume valid application quota', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call({})).statusCode, 400);
  assert.equal((await call({})).statusCode, 429);
  const base = { password: 'Temporary-2468', displayName: '林老师', role: 'supervisor', age: 28, gender: 'female', contact: 'contact@example.test', consent: true };
  for (let i = 0; i < 5; i++) assert.equal((await call({ ...base, username: `rate${i}` })).statusCode, 201);
  assert.equal((await call({ ...base, username: 'rate-over' })).statusCode, 429);
});

test.after(() => { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });
