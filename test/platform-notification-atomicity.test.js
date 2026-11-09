'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const users = require('../src/repo/user.repo');
const config = require('../src/plan-agent/config');
const pi = require('../src/plan-agent/pi-runtime');

test('运营通知入队失败整体回滚，同一运行可以重试且成功后不重复发送', async t => {
  const db = getDb();
  const originalPassword = process.env.ADMIN_AGENT_SECONDARY_PASSWORD;
  process.env.ADMIN_AGENT_SECONDARY_PASSWORD = 'isolated-notification-password';
  const originalRun = pi.run;
  const service = require('../src/platform-agent/service').create(db);
  t.after(async () => {
    await service.stop();
    pi.run = originalRun;
    if (originalPassword === undefined) delete process.env.ADMIN_AGENT_SECONDARY_PASSWORD;
    else process.env.ADMIN_AGENT_SECONDARY_PASSWORD = originalPassword;
    closeDb();
  });
  const add = (username, role) => users.insert(db, { username, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const admin = add('notification-atomic-admin', 'admin');
  const recipient = add('notification-atomic-recipient', 'supervisee');
  config.init(db);
  db.prepare('UPDATE plan_agent_config SET config_json=? WHERE id=1').run(JSON.stringify({ ...config.get(db), enabled: true, provider: 'injected', model: 'fake-model' }));
  require('../src/notify').setNotifyConfig(db, { enabled: true, webhookUrl: 'https://example.invalid' });
  db.exec("CREATE TRIGGER fail_platform_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'injected platform outbox failure'); END");
  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  pi.run = async args => {
    const tool = args.tools.find(item => item.name === 'send_platform_notification');
    const params = { userId: recipient.id, title: '测试通知', content: '测试事务回滚' };
    await assert.rejects(tool.execute('failed-send', params), /injected platform outbox failure/);
    assert.equal(count('notifications'), 0, 'failed enqueue must roll back the site notification');
    assert.equal(count('activity_events'), 0, 'failed enqueue must roll back notification activity');
    assert.equal(count('notification_outbox'), 0);
    db.exec('DROP TRIGGER fail_platform_outbox');
    assert.equal((await tool.execute('retry-send', params)).details.ok, true);
    assert.equal((await tool.execute('duplicate-send', params)).details.ok, false);
    assert.equal(count('notifications'), 1);
    assert.equal(count('activity_events'), 1);
    assert.equal(count('notification_outbox'), 1);
  };
  const token = require('../src/security').createSession(db, admin.id);
  const grant = service.reauth(admin, 'isolated-notification-password', token).reauthToken;
  const result = await service.run(admin, { instruction: '验证平台通知保存', allowNotifications: true }, token, grant);
  assert.deepEqual(result.sent, [{ userId: recipient.id, displayName: recipient.display_name }]);
});
