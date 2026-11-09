'use strict';
/**
 * 通知/提醒模块（预留可插拔接口）。
 * 由数据层（note.repo / setting.repo）读取和写入，这里只做“投递策略”。
 *  1) 应用内通知：写入 notifications 表（前端可展示 + 浏览器桌面通知）。
 *  2) 外部通知程序（预留）：webhook POST 或 command(stdin)，见 README「通知接入」。
 *  3) 微信 iLink 推送（通道 channel='wechat'）：把通知实时推给已绑定微信的账号，
 *     由 src/wechat 完成真实收发；本模块只负责排队与重试。
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const noteRepo = require('./repo/note.repo');
const settingRepo = require('./repo/setting.repo');
const wechatRepo = require('./repo/wechat.repo');
const activity = require('./repo/activity.repo');
const userRepo = require('./repo/user.repo');
const taskRepo = require('./repo/task.repo');
const planRepo = require('./repo/plan.repo');
const { taskMessages, dayMessages } = require('./reminder-messages');
const { dayReminderAt } = require('./reminder-time');
const { loadConfig: loadWechatConfig } = require('./wechat');

const NOTIFY_SETTINGS_KEY = 'notify_config';

// 依赖注入：由组合根（server.js）注入 wechat 通道管理器；单测未注入时微信通道自动跳过。
let _wechat = null;
function setWechat(manager) { _wechat = manager; }

function getNotifyConfig(db) {
  const raw = settingRepo.get(db, NOTIFY_SETTINGS_KEY) || '{}';
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function setNotifyConfig(db, cfg) {
  settingRepo.set(db, NOTIFY_SETTINGS_KEY, JSON.stringify(cfg || {}));
}

// A scheduler batch can enqueue hundreds of notifications under one SQLite
// transaction.  The configuration cannot change inside that transaction, so
// parse it once and pass this short-lived context to each enqueue operation.
// Ordinary callers omit it and therefore continue to observe live settings.
function createDeliveryContext(db) {
  return { notifyConfig: getNotifyConfig(db), wechatConfig: loadWechatConfig(db) };
}

function hookRecipient(recipient) {
  return recipient ? { id: recipient.id, username: recipient.username, role: recipient.role, displayName: recipient.display_name } : null;
}
function buildHookPayload(recipient, { kind, title, content, linkType, linkId }) {
  return {
    event: kind,
    kind,
    recipient: hookRecipient(recipient),
    title,
    content,
    link: { type: linkType || '', id: linkId || '' },
    at: new Date().toISOString(),
  };
}

function buildWechatText(title, content) {
  const t = String(title || '').trim();
  const c = String(content || '').trim();
  if (!t && !c) return '';
  const body = !c || c === t ? t : `${t}\n${c}`;
  // Keep everyday external delivery recognisable without changing the
  // platform's business terminology in the web UI.
  return body.startsWith('【Markly】') ? body : `【Markly】${body}`;
}

async function callWebhook(url, payload, deliveryId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': deliveryId },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const retryAfterMs = retry == null ? 0 : (/^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0,Date.parse(retry)-Date.now()));
    try { await response.body?.cancel(); } catch {}
    throw Object.assign(new Error('webhook status ' + response.status), { code:response.status, retryAfterMs });
  }
  // Webhook只需要HTTP状态，不把对端响应体完整加载进内存。
  // Response cleanup must not replace the already known HTTP delivery result.
  try { await response.body?.cancel(); } catch {}
}

function callCommand(command, payload) {
  return new Promise((resolve, reject) => {
    const executable = String(command || '').trim();
    if (!executable || /[\r\n;&|<>$`(){}]/.test(executable)) return reject(new Error('unsafe notification command'));
    let child;
    try { child = spawn(executable, [], { shell: false, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }); }
    catch (error) { return reject(error); }
    let firstError = null;
    const timeout = setTimeout(() => terminate(new Error('notification command timeout')), 10000);
    function terminate(error) {
      if (firstError) return;
      firstError = error;
      clearTimeout(timeout);
      // Keep the delivery slot until close confirms that the child and its
      // streams are gone; kill() only requests termination.
      try { child.kill('SIGKILL'); } catch {}
    }
    child.on('error', terminate);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (firstError) reject(firstError);
      else if (code === 0) resolve();
      else reject(new Error('notification command exit ' + code));
    });
    child.stdin.on('error', terminate);
    try { child.stdin.write(JSON.stringify(payload)); child.stdin.end(); } catch (error) { terminate(error); }
  });
}

const TASK_REMINDERS = {
  task_remind: ['remind_fired_at', 'assignee', 'remind'], supervise_remind: ['remind_fired_at', 'creator', 'remind'],
  task_overdue: ['overdue_fired_at', 'assignee', 'overdue'], supervise_overdue: ['overdue_fired_at', 'creator', 'overdue'],
  task_overdue_followup: ['overdue_escalated_at', 'assignee', 'followup'], supervise_overdue_followup: ['overdue_escalated_at', 'creator', 'followup'],
};
const DAY_REMINDERS = {
  plan_remind: ['remind_fired_at', 'assignee', 'remind'], plan_supervise: ['remind_fired_at', 'creator', 'remind'],
  plan_miss: ['overdue_fired_at', 'assignee', 'miss'], plan_miss_sup: ['overdue_fired_at', 'creator', 'miss'],
};

// Persist the schedule/content being reminded alongside the outbox payload.
// A later scan can reuse the same object after a reschedule or daily agreement;
// its older queued text must not become valid again just because work resumed.
function reminderSnapshot(db, payload) {
  const taskKind = TASK_REMINDERS[payload.kind], dayKind = DAY_REMINDERS[payload.kind];
  if (!taskKind && !dayKind) return undefined;
  const kind = taskKind || dayKind, type = taskKind ? 'task' : 'day';
  if (payload.link?.type !== type || !payload.link.id) return null;
  const row = taskKind ? taskRepo.reminderById(db, payload.link.id) : planRepo.reminderDayById(db, payload.link.id);
  if (!row || !row[kind[0]] || payload.recipient?.id !== row[kind[1] + '_id']) return null;
  const snapshot = {
    type, id: payload.link.id, creatorId: row.creator_id, assigneeId: row.assignee_id,
    cooperationPeriodId: row.cooperation_period_id || null, firedAt: row[kind[0]],
  };
  return taskKind ? {
    ...snapshot, title: row.title, dueAt: row.due_at, remindBeforeMinutes: row.remind_before_minutes ?? 30,
  } : {
    ...snapshot, planId: row.plan_id, title: row.plan_title, content: row.content,
    dayDate: row.day_date, seq: row.seq, remindHour: row.remind_hour ?? 20,
  };
}

function deliveryAllowed(db, row, payload) {
  const recipient = payload.recipient?.id ? userRepo.byId(db, payload.recipient.id) : null;
  if (!recipient || recipient.status !== 1) return false;
  const snapshot = reminderSnapshot(db, payload);
  if (snapshot === undefined) return true; // Historical feedback remains deliverable.
  if (!snapshot) return false;
  if (Object.hasOwn(payload, 'reminderSnapshot')) {
    if (!payload.reminderSnapshot) return false;
    // Renaming does not reopen reminder markers. Keep the agreed schedule and
    // work snapshot fixed, but render its display title from the current row.
    const { title: currentTitle, ...current } = snapshot;
    const { title: queuedTitle, ...queued } = payload.reminderSnapshot;
    if (JSON.stringify(current) !== JSON.stringify(queued)) return false;
  } else if (snapshot.firedAt > row.created_at) {
    // Legacy queues have no snapshot. Reset reminder markers still invalidate
    // them, and a later reminder cannot revive an earlier delivery.
    return false;
  }
  const now = Date.now();
  if (snapshot.type === 'task') {
    return TASK_REMINDERS[payload.kind][0] === 'remind_fired_at'
      ? snapshot.dueAt - snapshot.remindBeforeMinutes * 60000 <= now : snapshot.dueAt < now;
  }
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const reminder = DAY_REMINDERS[payload.kind][0] === 'remind_fired_at';
  if (!reminder) start.setDate(start.getDate() - 1);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return snapshot.dayDate === date && (!reminder || now >= dayReminderAt(now, snapshot.remindHour));
}

function externalPayload(db, payload) {
  const { reminderSnapshot: queuedSnapshot, ...event } = payload;
  const taskKind = TASK_REMINDERS[payload.kind], dayKind = DAY_REMINDERS[payload.kind];
  if (taskKind || dayKind) {
    const kind = taskKind || dayKind;
    const current = taskKind ? taskRepo.byId(db, payload.link.id) : planRepo.reminderDayById(db, payload.link.id);
    const messages = taskKind ? taskMessages(current, kind[2]) : dayMessages(current, kind[2]);
    event.title = messages[kind[1] + 'Title'];
    event.content = messages[kind[1] + 'Content'];
  }
  event.recipient = hookRecipient(userRepo.byId(db, payload.recipient.id));
  return event;
}

function deliver(db, { userId, kind, title, content, linkType, linkId, recipientUser }, deliveryContext = null) {
  noteRepo.insert(db, { userId, kind, title, content, linkType, linkId });
  activity.record(db,{actorId:null,subjectId:userId,type:'notification_queued',entityType:linkType||'',entityId:linkId||'',summary:title,metadata:{kind}});
  const recipient = recipientUser?.id === userId ? recipientUser : userRepo.byId(db, userId);
  const payload = buildHookPayload(recipient, { kind, title, content, linkType, linkId });
  const snapshot = reminderSnapshot(db, payload);
  if (snapshot !== undefined) payload.reminderSnapshot = snapshot;
  const now = Date.now();
  // 通道 1：webhook / 命令（global 行，行为与旧版一致）
  const cfg = deliveryContext?.notifyConfig || getNotifyConfig(db);
  if (cfg.enabled && (cfg.webhookUrl || cfg.command)) {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO notification_outbox(id, channel, payload, status, attempts, next_attempt_at, created_at, delivery_key) VALUES (?, 'global', ?, 'pending', 0, ?, ?, ?)"
    ).run(id, JSON.stringify(payload), now, now, 'global:' + (recipient?.id || ''));
  }
  // 通道 2：微信 iLink —— 仅当该账号已绑定微信且通道开启
  const wcfg = deliveryContext?.wechatConfig || loadWechatConfig(db);
  const binding = recipient?.id ? wechatRepo.getByUserId(db, recipient.id) : null;
  const instanceReady = wcfg.enabled && binding?.wxid && binding?.contextToken && _wechat && typeof _wechat.userStatus === 'function' && _wechat.userStatus(recipient.id).hasCredentials;
  if (wcfg.enabled && instanceReady && binding && binding.wxid && binding.contextToken) {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO notification_outbox(id, channel, payload, status, attempts, next_attempt_at, created_at, delivery_key) VALUES (?, 'wechat', ?, 'pending', 0, ?, ?, ?)"
    ).run(id, JSON.stringify(payload), now, now, 'wechat:' + recipient.id);
  }
  // wake只安排下一次事件循环，事务回滚后不会发送未提交的通知。
  workers.get(db)?.wake();
}

/** 投递一行 global 队列（webhook + 命令）。返回 true=成功。 */
async function deliverGlobal(db, row, payload) {
  const cfg = getNotifyConfig(db);
  if (!cfg.enabled || !deliveryAllowed(db, row, payload)) return { skipped:true };
  const event = { ...externalPayload(db, payload), deliveryId: row.id };
  if (cfg.webhookUrl && !row.webhook_sent_at) {
    await callWebhook(cfg.webhookUrl, event, row.id);
    db.prepare('UPDATE notification_outbox SET webhook_sent_at=? WHERE id=? AND lock_token=?').run(Date.now(),row.id,row.lock_token);
  }
  // Webhook awaits can span account, role or cooperation changes. Recheck
  // before beginning a second external operation.
  if (cfg.command && deliveryAllowed(db, row, payload)) {
    await callCommand(cfg.command, { ...externalPayload(db, payload), deliveryId: row.id });
  }
  return true;
}

/** 投递一行 wechat 队列：查绑定 → 组文本 → 推送。 */
async function deliverWechat(db, row, payload) {
  if (!loadWechatConfig(db).enabled || !deliveryAllowed(db, row, payload)) return { skipped: true };
  if (!_wechat) throw new Error('微信通道未就绪（wechat 未注入）');
  const recipientId = payload && payload.recipient && payload.recipient.id;
  const recipientName = payload && payload.recipient ? (payload.recipient.displayName || payload.recipient.username || '') : '';
  if (!recipientId) throw Object.assign(new Error('缺少接收人'), { code: 'ILINK_NO_RECIPIENT' });
  const binding = wechatRepo.getByUserId(db, recipientId);
  if (!binding || !binding.wxid || !binding.contextToken) {
    // 对方中途解绑/从未绑定：不是错误，按跳过处理，避免无限重试
    wechatRepo.logDelivery(db, { userId: recipientId, wxid: '', direction: 'out', kind: 'notify', text: (payload.title || '') + '（未绑定微信，跳过）', status: 'skipped', error: 'no_binding' });
    return { skipped: true };
  }
  const current = externalPayload(db, payload);
  const text = buildWechatText(current.title, current.content);
  if (!text) return { skipped: true };
  await _wechat.sendToUser(db, recipientId, text, { kind: 'notify', clientId: 'outbox-' + row.id });
  return { sent: true, to: recipientName || recipientId };
}

const workers = new WeakMap();
function outboxWorker(db) {
  let worker = workers.get(db);
  if (!worker) {
    worker = require('./outbox-worker').createOutboxWorker(db, { send: (row,payload) => row.channel === 'wechat' ? deliverWechat(db,row,payload) : deliverGlobal(db,row,payload) });
    workers.set(db,worker);
  }
  return worker;
}
function startOutbox(db) { return outboxWorker(db).start(); }
function processOutbox(db, limit = 100) { return outboxWorker(db).drain(limit); }
function outboxStats(db) { return workers.get(db)?.stats() || { running:false,inFlight:0 }; }

function readNotifications(db, userId) {
  return noteRepo.listForUser(db, userId).map(noteRepo.toNote);
}
function unreadCount(db, userId) {
  return noteRepo.unreadCount(db, userId);
}

module.exports = { getNotifyConfig, setNotifyConfig, createDeliveryContext, readNotifications, unreadCount, deliver, processOutbox, startOutbox, outboxStats, setWechat, buildWechatText, buildHookPayload };
