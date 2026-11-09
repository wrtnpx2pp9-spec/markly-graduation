'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const db = getDb();
const wechatRepo = require('../src/repo/wechat.repo');
const notify = require('../src/notify');
const { createWechat } = require('../src/wechat');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-wechat-log-'));
  const manager = createWechat(db, { stateDir: dir });
  await manager.setConfig({ enabled: true, mode: 'mock' });
  db.prepare("INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES ('log-user','log-user','supervisee','hash','salt','测试用户',1,?)").run(Date.now());
  wechatRepo.bindUserWxid(db, { userId: 'log-user', wxid: 'test-wxid', contextToken: 'test-context' });
  const errors = [];
  const originalLog = wechatRepo.logDelivery;
  const originalError = console.error;
  wechatRepo.logDelivery = () => { throw new Error('delivery log unavailable'); };
  console.error = (...args) => errors.push(args.join(' '));
  t.after(async () => {
    wechatRepo.logDelivery = originalLog;
    console.error = originalError;
    notify.setWechat(null);
    await manager.stop();
    db.exec('DELETE FROM notification_outbox; DELETE FROM wechat_bindings; DELETE FROM users;');
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('markly-wechat-log-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { manager, instance: manager.userInstance('log-user'), errors };
}

test('微信发送成功后收发日志失败不会把通知重新入队', async t => {
  const { manager, instance, errors } = await fixture(t);
  const sent = [];
  instance.sendText = async (text, opts) => { sent.push({ text, clientId: opts.clientId }); };
  notify.setWechat(manager);
  db.prepare("INSERT INTO notification_outbox(id,channel,payload,status,next_attempt_at,created_at,delivery_key) VALUES ('log-success','wechat',?,'pending',0,?,'wechat:log-user')")
    .run(JSON.stringify({ recipient: { id: 'log-user' }, title: '独立测试通知' }), Date.now());

  assert.equal((await notify.processOutbox(db)).sent, 1);
  assert.deepEqual({ ...db.prepare("SELECT status,attempts FROM notification_outbox WHERE id='log-success'").get() }, { status: 'sent', attempts: 1 });
  assert.equal((await notify.processOutbox(db)).scanned, 0);
  assert.deepEqual(sent, [{ text: '【Markly】独立测试通知', clientId: 'outbox-log-success' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /delivery log error: delivery log unavailable/);
});

test('微信发送失败后的日志异常不覆盖原错误或阻止凭据失效处理', async t => {
  const { manager, instance, errors } = await fixture(t);
  const original = Object.assign(new Error('session expired'), { code: 'ILINK_SESSION', kind: 'session' });
  instance.sendText = async () => { throw original; };

  await assert.rejects(manager.sendToUser(db, 'log-user', '独立失败测试'), error => error === original);
  assert.equal(wechatRepo.getByUserId(db, 'log-user').contextToken, '');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /delivery log error: delivery log unavailable/);
});

test.after(() => closeDb());
