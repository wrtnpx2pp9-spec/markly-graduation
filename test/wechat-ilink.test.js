'use strict';
/**
 * 微信 iLink 通知通道测试：
 *   1) 每个用户通过独立 iLink 实例完成扫码绑定
 *   2) 扫码后向自己的机器人发送 1 → 完成微信绑定
 *   3) 绑定后主动推送文本（模拟微信收件箱可查）
 *   4) 真实模式客户端：长轮询 getupdates 收到消息后刷新该用户的 context_token
 *   5) notify 队列：deliver 后 processOutbox 能把通知推给已绑定用户
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立临时数据库（在本测试文件进程内最先设置，避免污染真实 data/app.db）
const dbPath = path.join(os.tmpdir(), `supervise-desk-ilink-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
process.env.DB_PATH = dbPath;

const { getDb } = require('../src/db');
const db = getDb();
const wechatRepo = require('../src/repo/wechat.repo');
const notify = require('../src/notify');
const { createWechat } = require('../src/wechat');

function addUser(id, role = 'supervisee') {
  db.prepare('INSERT INTO users(id, username, role, password_hash, salt, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, id, role, 'hash', 'salt', '学员', Date.now());
}
function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ilink-${label}-${process.pid}-`));
  return dir;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 8000, intervalMs = 100) {
  const start = Date.now();
  for (;;) {
    if (check()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(intervalMs);
  }
}

test('二维码 SVG 能由服务端生成', async () => {
  const { qrcodeSvg } = require('../src/wechat/qr');
  const svg = qrcodeSvg('https://weixin.qq.com/x/demo123');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(svg.includes('<path'));
});

test('本地模拟 iLink：用户独立机器人扫码 → 发送 1 → 主动推送', async () => {
  const dir = tmpDir('mock');
  const manager = createWechat(db, { stateDir: dir });
  await manager.setConfig({ enabled: true, mode: 'mock' });
  await manager.start();

  addUser('wx-user-1');

  // 1) 用户自己的实例开始绑定 → 得到专属二维码
  let status = await manager.startUserBinding('wx-user-1', false);
  assert.equal(status.connectionState, 'awaiting_scan');
  assert.equal(status.hasQrcode, true);
  assert.ok(status.qrcodeSvg.includes('<svg'));
  assert.ok(status.qrcodeKey);

  // 2) 模拟微信扫码并确认 → 拿到凭证
  status = await manager.mockConfirmUserBinding('wx-user-1');
  assert.equal(status.connectionState, 'awaiting_message');
  assert.equal(status.hasCredentials, true);

  // 3) 用户向自己的机器人发送 1 → 完成绑定
  const sim = await manager.simulateUserInbound('wx-user-1', '1');
  assert.ok(['bind', 'refresh'].includes(sim.result && sim.result.action), '应完成绑定动作');
  const binding = wechatRepo.getByUserId(db, 'wx-user-1');
  assert.ok(binding && binding.wxid, '用户应已绑定 wxid');
  assert.ok(binding.contextToken);
  assert.ok(binding.wxid.startsWith('mockwx_'));

  // 5) 主动推送 → 模拟“微信收件箱”里能看到这条消息
  await manager.sendToUser(db, 'wx-user-1', '【监督台】该做这件事了：写作业', { kind: 'notify' });
  const log = await manager.userMockLog('wx-user-1');
  const sentToUser = log.sent.find((item) => item.to_user_id === binding.wxid);
  assert.ok(sentToUser, '模拟收件箱应收到推送');
  assert.ok(sentToUser.text.includes('写作业'));

  // 6) 解绑后推送应明确失败（用户未绑定）
  await manager.selfUnbind('wx-user-1');
  await assert.rejects(() => manager.sendToUser(db, 'wx-user-1', '不该收到'), (err) => err.code === 'ILINK_USER_UNBOUND');

  await manager.stop();
});

test('真实模式用户实例：扫码后收到 1 并刷新 context_token', async () => {
  const dir = tmpDir('real');
  const { MockIlinkServer } = require('../src/wechat/mock-server');
  const mockServer = new MockIlinkServer();
  await mockServer.start({ port: 0 });

  const manager = createWechat(db, { stateDir: dir, realBaseUrl: mockServer.url });
  await manager.setConfig({ enabled: true, mode: 'real' });

  addUser('wx-user-2');
  // 先扫码绑定机器人（走真实协议路径）
  await manager.startUserBinding('wx-user-2', false);
  await fetch(`${mockServer.url}/mock/confirm-scan`, { method: 'POST' });
  const status = await manager.refreshUserBinding('wx-user-2');
  assert.equal(status.connectionState, 'awaiting_message');

  // 对方发来新消息 → poller 应刷新该用户 context_token / last_seen
  await sleep(300);
  await mockServer.injectMessage('wxid_poll_2', '1');
  const bound = await waitFor(() => {
    const b = wechatRepo.getByUserId(db, 'wx-user-2');
    return b && b.wxid === 'wxid_poll_2' && b.contextToken && b.lastSeenAt > 0;
  }, 10000);
  assert.ok(bound, 'poller 应通过 getupdates 刷新 context_token');
  const after = wechatRepo.getByUserId(db, 'wx-user-2');
  assert.ok(after.contextToken.startsWith('mockctx_'));

  await manager.stop();
  await mockServer.stop();
});

test('notify 队列能把提醒推给已绑定用户（channel=wechat 端到端）', async () => {
  const dir = tmpDir('outbox');
  const manager = createWechat(db, { stateDir: dir });
  await manager.setConfig({ enabled: true, mode: 'mock' });
  await manager.start();
  notify.setWechat(manager);

  addUser('wx-user-3');
  await manager.startUserBinding('wx-user-3', false);
  await manager.mockConfirmUserBinding('wx-user-3');
  await manager.simulateUserInbound('wx-user-3', '1');
  const binding = wechatRepo.getByUserId(db, 'wx-user-3');
  assert.ok(binding && binding.wxid);

  const recipient = db.prepare('SELECT * FROM users WHERE id=?').get('wx-user-3');
  // An automatic reminder must point to real pending work with a durable
  // fired marker; a fabricated link should now be skipped before delivery.
  const firedAt = Date.now();
  db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,due_at,remind_before_minutes,remind_fired_at,status,created_at) VALUES (?,?,?,?,?,0,?,'pending',?)")
    .run('t-1', '写作业', recipient.id, recipient.id, new Date(2020, 11, 30, 18, 0).getTime(), firedAt, firedAt);
  // deliver：应用内通知 + 微信 outbox 行
  await notify.deliver(db, {
    userId: 'wx-user-3',
    kind: 'task_remind',
    title: '该做这件事了：写作业',
    content: '别忘了完成「写作业」，截止 12-30 18:00。完成后来打卡。',
    linkType: 'task',
    linkId: 't-1',
    recipientUser: recipient,
  });
  const row = db.prepare("SELECT * FROM notification_outbox WHERE channel='wechat' AND payload LIKE '%wx-user-3%' ORDER BY created_at DESC LIMIT 1").get();
  assert.ok(row, '应产生 channel=wechat 的 outbox 行');
  assert.equal(row.status, 'pending');

  const outboxResult = await notify.processOutbox(db);
  assert.ok(outboxResult.sent >= 1);
  const sentRow = db.prepare("SELECT * FROM notification_outbox WHERE id=?").get(row.id);
  assert.equal(sentRow.status, 'sent');

  // 模拟微信收件箱收到组合后的提醒文本
  const log = await manager.userMockLog('wx-user-3');
  const delivered = log.sent.find((item) => item.to_user_id === binding.wxid && item.text.includes('该做这件事了：写作业'));
  assert.ok(delivered, '微信应收到提醒');
  assert.match(delivered.text, /截止 12[/-]30[^\d]*18:00/);

  // 未绑定用户的事件不应产生 wechat outbox 行（避免垃圾队列）
  addUser('wx-user-4');
  await notify.deliver(db, {
    userId: 'wx-user-4', kind: 'task_remind', title: 't', content: 'c', recipientUser: db.prepare('SELECT * FROM users WHERE id=?').get('wx-user-4'),
  });
  const none = db.prepare("SELECT COUNT(*) AS c FROM notification_outbox WHERE channel='wechat' AND payload LIKE '%wx-user-4%'").get().c;
  assert.equal(none, 0);

  await manager.stop();
});

test('两个用户的 Cloud BOT 凭据、会话和收件箱完全隔离', async () => {
  const dir = tmpDir('isolation');
  const manager = createWechat(db, { stateDir: dir });
  await manager.setConfig({ enabled: true, mode: 'mock' });
  await manager.start();
  addUser('wx-user-5');
  addUser('wx-user-6');

  for (const userId of ['wx-user-5', 'wx-user-6']) {
    await manager.startUserBinding(userId, false);
    await manager.mockConfirmUserBinding(userId);
    await manager.simulateUserInbound(userId, '1');
  }

  const first = manager.userInstance('wx-user-5');
  const second = manager.userInstance('wx-user-6');
  assert.notEqual(first.stateDir, second.stateDir);
  assert.notEqual(first.credentials().botToken, second.credentials().botToken);
  assert.notEqual(wechatRepo.getByUserId(db, 'wx-user-5').wxid, wechatRepo.getByUserId(db, 'wx-user-6').wxid);

  await manager.sendToUser(db, 'wx-user-5', '只发给用户五', { kind: 'test' });
  const firstLog = await manager.userMockLog('wx-user-5');
  const secondLog = await manager.userMockLog('wx-user-6');
  assert.ok(firstLog.sent.some((item) => item.text.includes('只发给用户五')));
  assert.ok(!secondLog.sent.some((item) => item.text.includes('只发给用户五')));

  await manager.stop();
});
