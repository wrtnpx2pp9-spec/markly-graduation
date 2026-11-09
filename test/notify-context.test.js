'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-notify-context-'));
process.env.DB_PATH = path.join(dir, 'app.db');
const { getDb, closeDb } = require('../src/db');
const db = getDb();
const notify = require('../src/notify');
const settings = require('../src/repo/setting.repo');

test('批次通知上下文复用已读取的配置，普通入队数据保持不变', () => {
  const user = { id: 'context-user', username: 'context-user', role: 'supervisee', display_name: '配置测试' };
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(user.id, user.username, user.role, 'hash', 'salt', user.display_name, Date.now());
  notify.setNotifyConfig(db, { enabled: true, webhookUrl: 'http://127.0.0.1:1/hook' });
  const context = notify.createDeliveryContext(db);
  const originalGet = settings.get;
  let readsAfterContext = 0;
  settings.get = (...args) => { readsAfterContext++; return originalGet(...args); };
  try {
    notify.deliver(db, { userId: user.id, recipientUser: user, kind: 'test', title: '批次通知', content: '内容' }, context);
  } finally { settings.get = originalGet; }
  assert.equal(readsAfterContext, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id='context-user'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE channel='global'").get().count, 1);
});

test.after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
