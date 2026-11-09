'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const users = require('../src/repo/user.repo');
const notify = require('../src/notify');

function fixture(t, config = {}) {
  const db = getDb();
  const recipient = users.insert(db, { username: 'webhook-cleanup-recipient', role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  notify.setNotifyConfig(db, { enabled: true, webhookUrl: 'https://example.invalid', ...config });
  notify.deliver(db, { userId: recipient.id, recipientUser: recipient, kind: 'platform_agent', title: '测试通知', content: '响应清理失败' });
  t.after(async () => { await notify.startOutbox(db).stop(); closeDb(); });
  return { db, row: () => db.prepare('SELECT * FROM notification_outbox').get(),
    retry: () => db.prepare('UPDATE notification_outbox SET next_attempt_at=0').run() };
}
function response(ok, status, retryAfter = null) {
  return { ok, status, headers: { get: name => name === 'retry-after' ? retryAfter : null },
    body: { cancel: async () => { throw new Error('injected response cleanup failure'); } } };
}

test('webhook 200后清理失败仍完成入队投递，后续扫描不重发', async t => {
  const { db, row, retry } = fixture(t);
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return response(true, 200); });
  await notify.processOutbox(db);
  assert.equal(row().status, 'sent');
  assert.ok(row().webhook_sent_at);
  assert.equal(row().last_error, null);
  retry();
  await notify.processOutbox(db);
  assert.equal(calls, 1);
});

test('webhook清理失败不妨碍保存成功标记，命令失败重试不重发webhook', async t => {
  const { db, row, retry } = fixture(t, { command: 'unsafe;command' });
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return response(true, 200); });
  await notify.processOutbox(db);
  assert.equal(row().status, 'failed');
  assert.match(row().last_error, /unsafe notification command/);
  const sentAt = row().webhook_sent_at;
  assert.ok(sentAt);
  notify.setNotifyConfig(db, { enabled: true, webhookUrl: 'https://example.invalid' });
  retry();
  await notify.processOutbox(db);
  assert.equal(row().status, 'sent');
  assert.equal(row().webhook_sent_at, sentAt);
  assert.equal(calls, 1);
});

test('webhook 429清理失败仍保留HTTP错误和Retry-After通道暂停', async t => {
  const { db, row } = fixture(t);
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return response(false, 429, '120'); });
  const before = Date.now();
  await notify.processOutbox(db);
  assert.equal(row().status, 'failed');
  assert.equal(row().webhook_sent_at, null);
  assert.match(row().last_error, /webhook status 429/);
  assert.ok(row().next_attempt_at >= before + 120000);
  assert.ok(notify.outboxStats(db).pausedUntil.global >= before + 120000);
  await notify.processOutbox(db);
  assert.equal(calls, 1);
});
