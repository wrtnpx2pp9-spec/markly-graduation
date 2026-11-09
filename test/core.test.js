'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `supervise-desk-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
process.env.DB_PATH = dbPath;

const { getDb } = require('../src/db');
const db = getDb();
const userRepo = require('../src/repo/user.repo');
const sessionRepo = require('../src/repo/session.repo');
const taskRepo = require('../src/repo/task.repo');
const notify = require('../src/notify');
const auditRepo = require('../src/repo/audit.repo');
const scope = require('../src/scope');
const reviewRepo = require('../src/repo/service-review.repo');
const phaseReviewRepo = require('../src/repo/phase-review.repo');
const planRepo = require('../src/repo/plan.repo');

function addUser(id, role, managedBy = null) {
  db.prepare('INSERT INTO users(id, username, role, password_hash, salt, display_name, status, managed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(id, id, role, 'hash', 'salt', id, managedBy, Date.now());
  // 既有业务测试使用已由平台授权1人的监督者；待审核行为由cooperation测试覆盖。
  if(role==='supervisor')db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='test-agreement',capacity_override=1 WHERE id=?").run(id);
}

function controllerCall(modulePath, method, route, context) {
  let handler;
  require(modulePath).register({ add(m, p, fn) { if (m === method && p === route) handler = fn; } }, { notify });
  let result;
  const res = { writeHead(status) { this.status = status; }, end(body) { result = { status: this.status, body: JSON.parse(body) }; } };
  handler({ db, res, body: {}, params: {}, query: {}, ...context });
  return result;
}

test('执行人不能修改监督任务约定，待确认任务不能改写', () => {
  addUser('edit-owner', 'supervisor'); addUser('edit-worker', 'supervisee');
  const task = taskRepo.insert(db, { title: '约定', planId: null, note: '', dueAt: null, remindBeforeMinutes: 30, status: 'pending', creatorId: 'edit-owner', assigneeId: 'edit-worker', createdAt: Date.now() });
  const edit = (id, body) => controllerCall('../src/controllers/task.ctrl', 'PUT', '/api/tasks/:id', { user: userRepo.byId(db, id), params: { id: task.id }, body });
  assert.equal(edit('edit-worker', { title: '改写' }).status, 403);
  assert.equal(edit('edit-owner', { dueAt: 'invalid' }).status, 400);
  assert.equal(edit('edit-owner', { title: ' ' }).status, 400);
  taskRepo.setStatus(db, task.id, 'submitted', null, '证据');
  assert.equal(edit('edit-owner', { title: '改写' }).status, 409);
  assert.equal(taskRepo.byId(db, task.id).title, '约定');
});

test('会话只保存摘要，兼容旧令牌，摘要不能用作登录凭据', () => {
  addUser('digest-user', 'supervisee');
  const token = sessionRepo.create(db, 'digest-user', Date.now() + 60000);
  const stored = sessionRepo.find(db, token).token;
  assert.notEqual(stored, token);
  assert.equal(sessionRepo.find(db, stored), undefined);
  sessionRepo.remove(db, token);
  assert.equal(sessionRepo.find(db, token), undefined);
  const legacy = 'a'.repeat(64);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(legacy, 'digest-user', Date.now(), Date.now() + 60000);
  assert.ok(sessionRepo.find(db, legacy));
  assert.match(sessionRepo.find(db, legacy).token, /^sha256:/);
  sessionRepo.remove(db, legacy);
  assert.equal(sessionRepo.find(db, legacy), undefined);
});

test('通知未读数不受列表100条上限影响', () => {
  addUser('many-notes', 'supervisor');
  const notes = require('../src/repo/note.repo');
  for (let i = 0; i < 105; i++) notes.insert(db, { userId: 'many-notes', kind: 'test', title: '待审核' });
  const result = controllerCall('../src/controllers/notification.ctrl', 'GET', '/api/notifications', { user: userRepo.byId(db, 'many-notes') });
  assert.equal(result.body.notifications.length, 100);
  assert.equal(result.body.unread, 105);
});

test('异常密码和损坏哈希返回验证失败', () => {
  const security = require('../src/security');
  assert.equal(security.verifyPassword({ salt: 'salt', password_hash: 'broken' }, 'password'), false);
  assert.equal(security.verifyPassword({ salt: 'salt', password_hash: 'a'.repeat(128) }, {}), false);
});

test('昨日漏卡在今日提醒一次，使用传入时间且不误报已提交记录', () => {
  addUser('miss-owner', 'supervisor');
  addUser('miss-user', 'supervisee');
  userRepo.setRelations(db, 'miss-user', ['miss-owner']);
  db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at) VALUES ('miss-plan','miss','miss-owner','miss-user','cycle','active',0)").run();
  db.prepare("UPDATE plans SET cooperation_period_id=(SELECT id FROM supervision_periods WHERE supervisor_id='miss-owner' AND supervisee_id='miss-user' AND ended_at IS NULL) WHERE id='miss-plan'").run();
  db.prepare("INSERT INTO plan_days(id,plan_id,seq,day_date,content,status,created_at) VALUES ('miss-day','miss-plan',1,'2030-01-01','学习','pending',0), ('submitted-day','miss-plan',2,'2030-01-01','学习','done',0)").run();
  const scheduler = require('../src/scheduler');
  const now = new Date(2030, 0, 2, 1).getTime();
  assert.equal(scheduler.scanPhaseDays(db, now).planMissed, 1);
  assert.equal(scheduler.scanPhaseDays(db, now).planMissed, 0);
  assert.equal(planRepo.dayById(db, 'miss-day').overdue_fired_at, now);
  assert.equal(planRepo.dayById(db, 'submitted-day').overdue_fired_at, null);
});

test('模板删除接口限制所有者，不能删除其他监督者模板', () => {
  addUser('template-a', 'supervisor');
  addUser('template-b', 'supervisor');
  const template = planRepo.insertTemplate(db, 'template-a', '标题', '内容');
  const call = (id) => controllerCall('../src/controllers/plan.ctrl', 'DELETE', '/api/plan-templates/:id', { user: userRepo.byId(db, id), params: { id: template.id } });
  assert.equal(call('template-b').status, 404);
  assert.equal(planRepo.listTemplates(db, 'template-a').length, 1);
  assert.equal(call('template-a').status, 200);
});

test('任务关联校验、零分钟提醒、打卡幂等和删除接口', () => {
  addUser('task-api-user', 'supervisee');
  const user = userRepo.byId(db, 'task-api-user');
  const call = (method, route, body = {}, params = {}) => controllerCall('../src/controllers/task.ctrl', method, route, { user, body, params });
  assert.equal(call('POST', '/api/tasks', { title: '非法关联', planId: 'missing-plan' }).status, 403);
  const created = call('POST', '/api/tasks', { title: '合法任务', remindBeforeMinutes: 0 });
  assert.equal(created.body.task.remindBeforeMinutes, 0);
  const id = created.body.task.id;
  taskRepo.setStatus(db, id, 'done', 123, '原始备注');
  const repeated = call('POST', '/api/tasks/:id/checkin', { note: '重复提交' }, { id });
  assert.equal(repeated.body.task.doneAt, 123);
  assert.equal(repeated.body.task.checkinNote, '原始备注');
  assert.equal(call('DELETE', '/api/tasks/:id', {}, { id }).status, 200);
  assert.equal(taskRepo.byId(db, id), undefined);
});

test('工作台近期窗口不拉取旧完成记录，但保留待处理事项和完整历史接口', () => {
  addUser('recent-window-user', 'supervisee');
  const user = userRepo.byId(db, 'recent-window-user');
  const now = Date.now();
  const old = now - 91 * 24 * 60 * 60 * 1000;
  const addTask = (title, status, createdAt, doneAt = null) => {
    const task = taskRepo.insert(db, { title, planId: null, note: '', dueAt: createdAt, remindBeforeMinutes: 30, status: 'pending', creatorId: user.id, assigneeId: user.id, createdAt });
    if (status !== 'pending') taskRepo.setStatus(db, task.id, status, doneAt, '');
    return task;
  };
  const oldDone = addTask('旧完成任务', 'done', old, old);
  const oldPending = addTask('旧待办任务', 'pending', old);
  const recentDone = addTask('最近完成任务', 'done', now, now);
  const taskList = (query) => controllerCall('../src/controllers/task.ctrl', 'GET', '/api/tasks', { user, query }).body.tasks;
  const recentTaskIds = new Set(taskList({ window: 'recent' }).map((task) => task.id));
  assert.equal(recentTaskIds.has(oldDone.id), false);
  assert.equal(recentTaskIds.has(oldPending.id), true);
  assert.equal(recentTaskIds.has(recentDone.id), true);
  assert.equal(taskList({}).some((task) => task.id === oldDone.id), true);

  const addPlan = (title, status, createdAt) => planRepo.insert(db, {
    title, description: '', creatorId: user.id, assigneeId: user.id, parentId: null,
    kind: 'task', planningMode: 'fixed', startAt: createdAt, dueAt: createdAt,
    remindBeforeMinutes: 30, status, createdAt,
  });
  const oldArchived = addPlan('旧归档计划', 'archived', old);
  const oldActive = addPlan('旧进行中计划', 'active', old);
  const recentArchived = addPlan('最近归档计划', 'archived', now);
  const planList = (query) => controllerCall('../src/controllers/plan.ctrl', 'GET', '/api/plans', { user, query }).body.plans;
  const recentPlanIds = new Set(planList({ window: 'recent' }).map((plan) => plan.id));
  assert.equal(recentPlanIds.has(oldArchived.id), false);
  assert.equal(recentPlanIds.has(oldActive.id), true);
  assert.equal(recentPlanIds.has(recentArchived.id), true);
  assert.equal(planList({}).some((plan) => plan.id === oldArchived.id), true);
});

test('绑定同一执行人的其他监督者不能查看或修改不属于自己的记录', () => {
  addUser('shared-owner', 'supervisor');
  addUser('shared-reader', 'supervisor');
  addUser('shared-user', 'supervisee', 'shared-reader');
  userRepo.setRelations(db, 'shared-user', ['shared-reader']);
  const user = userRepo.byId(db, 'shared-reader');
  const task = taskRepo.insert(db, { title: '共享', planId: null, note: '', creatorId: 'shared-owner', assigneeId: 'shared-user', dueAt: null, remindBeforeMinutes: 30, status: 'pending', createdAt: 0 });
  assert.equal(scope.canAccessTask(db, user, task), false);
  assert.equal(controllerCall('../src/controllers/task.ctrl', 'PUT', '/api/tasks/:id', { user, params: { id: task.id }, body: { title: '篡改' } }).status, 403);
  db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at) VALUES ('shared-plan','共享','shared-owner','shared-user','phase','active',0)").run();
  assert.equal(controllerCall('../src/controllers/plan.ctrl', 'POST', '/api/plans/:id/archive', { user, params: { id: 'shared-plan' } }).status, 403);
  assert.equal(planRepo.byId(db, 'shared-plan').status, 'active');
});

test('数据库 schema 和关键索引完整', () => {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const name of ['users', 'tasks', 'notification_outbox', 'audit_logs', 'scheduler_leases', 'supervision_relations', 'service_reviews', 'phase_stage_reviews', 'plan_day_comments', 'plan_day_items', 'supervisee_assessments']) assert.ok(tables.has(name), name);
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  for (const name of ['idx_tasks_reminder', 'idx_outbox_due', 'idx_audit_created', 'idx_relations_supervisor', 'idx_relations_supervisee', 'idx_reviews_supervisor', 'idx_reviews_reviewer', 'idx_plan_day_items_day_seq']) assert.ok(indexes.has(name), name);
});

test('服务计划一单一评价，可修改并更新监督者口碑', () => {
  addUser('review-supervisor', 'supervisor');
  addUser('review-user', 'supervisee');
  const now = Date.now();
  db.prepare("INSERT INTO plans(id, title, creator_id, assignee_id, kind, status, created_at) VALUES (?, ?, ?, ?, 'task', 'active', ?)").run('review-plan', 'service', 'review-supervisor', 'review-user', now);
  reviewRepo.upsert(db, { planId: 'review-plan', reviewerId: 'review-user', supervisorId: 'review-supervisor', rating: 5, content: '很好', now });
  reviewRepo.refreshSupervisorMetrics(db, 'review-supervisor');
  let supervisor = userRepo.byId(db, 'review-supervisor');
  assert.equal(reviewRepo.byPlanId(db, 'review-plan').rating, 5);
  assert.equal(supervisor.reputation_score, 100);
  assert.equal(supervisor.completed_service_count, 1);

  reviewRepo.upsert(db, { planId: 'review-plan', reviewerId: 'review-user', supervisorId: 'review-supervisor', rating: 3, content: '已修改', now: now + 1 });
  reviewRepo.refreshSupervisorMetrics(db, 'review-supervisor');
  supervisor = userRepo.byId(db, 'review-supervisor');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM service_reviews WHERE plan_id=?').get('review-plan').count, 1);
  assert.equal(reviewRepo.byPlanId(db, 'review-plan').content, '已修改');
  assert.equal(supervisor.reputation_score, 60);
  assert.equal(supervisor.completed_service_count, 1);
});

test('阶段复盘需双方提交并确认后锁定', () => {
  addUser('phase-supervisor', 'supervisor');
  addUser('phase-user', 'supervisee', 'phase-supervisor');
  const now = Date.now();
  const base = { parentPlanId: 'phase-parent', cyclePlanId: 'phase-cycle', superviseeId: 'phase-user', supervisorId: 'phase-supervisor' };
  phaseReviewRepo.saveSelf(db, { ...base, summary: '开始更容易了', difficulty: '周末拖延', helpfulMethod: '轻提醒', nextAction: '调整后继续', now });
  phaseReviewRepo.saveSupervisor(db, { ...base, observation: '主动性改善', progress: '有所进步', suggestion: '保持周末节奏', resultLabel: '有所进步', recommendNext: '建议继续', now: now + 1 });
  const revision = phaseReviewRepo.byCycleId(db, 'phase-cycle').content_revision;
  let row = phaseReviewRepo.confirm(db, 'phase-cycle', 'supervisee', now + 2, revision);
  assert.equal(row.locked_at, null);
  row = phaseReviewRepo.confirm(db, 'phase-cycle', 'supervisor', now + 3, revision);
  assert.equal(row.locked_at, now + 3);
});

test('打卡先待监督者确认，支持驳回和撤回', () => {
  addUser('check-supervisor', 'supervisor');
  addUser('check-user', 'supervisee', 'check-supervisor');
  const now = Date.now();
  db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at) VALUES ('check-plan','check','check-supervisor','check-user','cycle','active',?)").run(now);
  db.prepare("INSERT INTO plan_days(id,plan_id,seq,day_date,content,created_at) VALUES ('check-day','check-plan',1,'2026-09-07','完成学习',?)").run(now);
  let day = planRepo.submitDay(db, 'check-day', '完成了');
  assert.equal(day.status, 'done');
  assert.equal(day.checkin_state, 'submitted');
  day = planRepo.reviewDay(db, 'check-day', 'check-supervisor', 'rejected', '请补充学习内容');
  assert.equal(day.status, 'pending');
  assert.equal(day.checkin_state, 'rejected');
  day = planRepo.submitDay(db, 'check-day', '重新完成');
  assert.equal(day.checkin_state, 'submitted');
  day = planRepo.reviewDay(db, 'check-day', 'check-supervisor', 'approved', '');
  assert.equal(day.status, 'done');
  assert.equal(day.checkin_state, 'approved');
});

test('监督双方可以分别给同一天留言和表情', () => {
  const now = Date.now();
  const first = planRepo.addDayComment(db, { dayId: 'check-day', planId: 'check-plan', authorId: 'check-user', authorRole: 'supervisee', content: '今天更容易开始', mood: 'happy', createdAt: now });
  const second = planRepo.addDayComment(db, { dayId: 'check-day', planId: 'check-plan', authorId: 'check-supervisor', authorRole: 'supervisor', content: '继续保持这个节奏', mood: 'cheer', createdAt: now + 1 });
  const comments = planRepo.dayComments(db, 'check-plan').get('check-day');
  assert.equal(first.day_id, 'check-day');
  assert.equal(second.author_role, 'supervisor');
  assert.equal(comments.length, 2);
  assert.equal(comments[0].mood, 'happy');
  assert.equal(comments[1].content, '继续保持这个节奏');
});

test('平台分配一人后不能超额，管理员调整人数后才可扩容', () => {
  addUser('capacity-supervisor', 'supervisor');
  addUser('capacity-user-1', 'supervisee');
  addUser('capacity-user-2', 'supervisee');
  addUser('capacity-user-3', 'supervisee');
  userRepo.setRelations(db, 'capacity-user-1', ['capacity-supervisor']);
  assert.equal(userRepo.relationCount(db, 'capacity-supervisor'), 1);
  assert.throws(() => userRepo.setRelations(db, 'capacity-user-2', ['capacity-supervisor']), /invalid supervision relation/);
  userRepo.update(db, 'capacity-supervisor', { accountLevel: 'trusted', superviseeLimit: 3 });
  userRepo.setRelations(db, 'capacity-user-2', ['capacity-supervisor']);
  userRepo.update(db, 'capacity-supervisor', { superviseeLimit: 4 });
  userRepo.setRelations(db, 'capacity-user-3', ['capacity-supervisor']);
  assert.equal(userRepo.relationCount(db, 'capacity-supervisor'), 3);
});

test('评分和评价不自动扩容，清空平台额度不会回退到口碑额度', () => {
  addUser('earned-capacity-supervisor', 'supervisor');
  assert.equal(userRepo.supervisorCapacity(db, 'earned-capacity-supervisor'), 1);
  userRepo.update(db, 'earned-capacity-supervisor', { reputationScore: 80, completedServiceCount: 3 });
  assert.equal(userRepo.supervisorCapacity(db, 'earned-capacity-supervisor'), 1);
  userRepo.update(db, 'earned-capacity-supervisor', { capacityOverride: 2 });
  assert.equal(userRepo.supervisorCapacity(db, 'earned-capacity-supervisor'), 2);
  userRepo.update(db, 'earned-capacity-supervisor', { capacityOverride: null, reputationScore: 95, completedServiceCount: 5 });
  assert.equal(userRepo.supervisorCapacity(db, 'earned-capacity-supervisor'), 0);
});

test('一个被监督者可绑定多个监督者，候选仍可被其他监督者发现', () => {
  addUser('multi-supervisor-1', 'supervisor');
  addUser('multi-supervisor-2', 'supervisor');
  addUser('multi-user', 'supervisee');
  userRepo.setRelations(db, 'multi-user', ['multi-supervisor-1']);
  assert.ok(userRepo.assignableSuperviseeIds(db, 'multi-supervisor-2').includes('multi-user'));
  userRepo.setRelations(db, 'multi-user', ['multi-supervisor-1', 'multi-supervisor-2']);
  assert.deepEqual(new Set(userRepo.activeSupervisorIds(db, 'multi-user')), new Set(['multi-supervisor-1', 'multi-supervisor-2']));
});

test('绑定不授予执行人私人任务的访问权限', () => {
  addUser('scope-supervisor', 'supervisor');
  addUser('scope-user', 'supervisee');
  const now = Date.now();
  db.prepare('INSERT INTO tasks(id, title, creator_id, assignee_id, created_at) VALUES (?, ?, ?, ?, ?)').run('scope-task', 'private-plan-step', 'scope-user', 'scope-user', now);
  const supervisor = userRepo.byId(db, 'scope-supervisor');
  const task = taskRepo.byId(db, 'scope-task');
  assert.equal(scope.canAccessTask(db, supervisor, task), false);
  userRepo.setRelations(db, 'scope-user', ['scope-supervisor']);
  assert.equal(scope.canAccessTask(db, supervisor, task), false);
});

test('当前工作区只列出有效监督关系内的协作记录，个人记录不受影响', () => {
  addUser('active-scope-supervisor', 'supervisor');
  addUser('active-scope-user', 'supervisee');
  const now = Date.now();
  userRepo.setRelations(db, 'active-scope-user', ['active-scope-supervisor']);
  const supervisor = userRepo.byId(db, 'active-scope-supervisor');
  const supervisee = userRepo.byId(db, 'active-scope-user');
  const sharedTask = taskRepo.insert(db, { title: '协作任务', planId: null, note: '', creatorId: supervisor.id, assigneeId: supervisee.id, dueAt: null, remindBeforeMinutes: 30, status: 'pending', createdAt: now });
  const personalTask = taskRepo.insert(db, { title: '个人任务', planId: null, note: '', creatorId: supervisee.id, assigneeId: supervisee.id, dueAt: null, remindBeforeMinutes: 30, status: 'pending', createdAt: now + 1 });
  db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at,cooperation_period_id) VALUES ('active-scope-plan','协作计划','active-scope-supervisor','active-scope-user','task','active',?,?)").run(now,db.prepare("SELECT id FROM supervision_periods WHERE supervisor_id='active-scope-supervisor' AND ended_at IS NULL").get().id);

  assert.ok(taskRepo.list(db, scope.taskScope(db, supervisor)).some((task) => task.id === sharedTask.id));
  assert.ok(taskRepo.list(db, scope.taskScope(db, supervisee)).some((task) => task.id === sharedTask.id));
  assert.ok(taskRepo.list(db, scope.taskScope(db, supervisee)).some((task) => task.id === personalTask.id));
  assert.ok(planRepo.list(db, scope.planScope(db, supervisor)).some((plan) => plan.id === 'active-scope-plan'));

  userRepo.setRelations(db, 'active-scope-user', []);
  assert.equal(taskRepo.list(db, scope.taskScope(db, supervisor)).some((task) => task.id === sharedTask.id), false);
  assert.equal(taskRepo.list(db, scope.taskScope(db, supervisee)).some((task) => task.id === sharedTask.id), false);
  assert.ok(taskRepo.list(db, scope.taskScope(db, supervisee)).some((task) => task.id === personalTask.id));
  assert.equal(planRepo.list(db, scope.planScope(db, supervisor)).some((plan) => plan.id === 'active-scope-plan'), false);
});

test('超时任务首条提醒后每 24 小时最多再催办一次，重新排期会清除催办标记', () => {
  const now = Date.now();
  addUser('escalation-user', 'supervisee');
  const task = taskRepo.insert(db, { title: '超时催办', planId: null, note: '', creatorId: 'escalation-user', assigneeId: 'escalation-user', dueAt: now - 2 * 86400000, remindBeforeMinutes: 0, status: 'pending', createdAt: now - 3 * 86400000 });
  assert.equal(taskRepo.setOverdueFired(db, task.id, now - 86400000), true);
  assert.ok(taskRepo.listDueOverdueEscalation(db, now).some((row) => row.id === task.id));
  assert.equal(taskRepo.setOverdueEscalated(db, task.id, now, 86400000), true);
  assert.equal(taskRepo.listDueOverdueEscalation(db, now + 86399999).some((row) => row.id === task.id), false);
  assert.ok(taskRepo.listDueOverdueEscalation(db, now + 86400000).some((row) => row.id === task.id));
  taskRepo.update(db, task.id, { title: task.title, note: '', assigneeId: 'escalation-user', dueAt: now + 3600000, remindBeforeMinutes: 0 });
  const rescheduled = taskRepo.byId(db, task.id);
  assert.equal(rescheduled.overdue_fired_at, null);
  assert.equal(rescheduled.overdue_escalated_at, null);
});

test('通知写入失败会回滚提醒标记，下一轮仍可重试', () => {
  const scheduler = require('../src/scheduler');
  const now = Date.now();
  addUser('reminder-transaction-user', 'supervisee');
  const task = taskRepo.insert(db, { title: '事务提醒', planId: null, note: '', creatorId: 'reminder-transaction-user', assigneeId: 'reminder-transaction-user', dueAt: now - 1, remindBeforeMinutes: 0, status: 'pending', createdAt: now - 10 });
  const original = notify.deliver;
  notify.deliver = () => { throw new Error('outbox insert failed'); };
  try { assert.throws(() => scheduler.fire(db), /outbox insert failed/); }
  finally { notify.deliver = original; }
  assert.equal(taskRepo.byId(db, task.id).remind_fired_at, null);
});

test('排行榜控制器不序列化用户名或任务计划内容', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'rank.ctrl.js'), 'utf8');
  assert.doesNotMatch(source, /username/);
  assert.doesNotMatch(source, /\btitle\s*:/);
  assert.doesNotMatch(source, /\bdescription\s*:/);
});

test('禁用用户后会话立即失效', () => {
  addUser('session-user', 'supervisee');
  const token = sessionRepo.create(db, 'session-user', Date.now() + 60000);
  assert.ok(sessionRepo.find(db, token));
  userRepo.setStatus(db, 'session-user', 0);
  sessionRepo.removeAllForUser(db, 'session-user');
  assert.equal(sessionRepo.find(db, token), undefined);
});

test('删除用户清理私人数据，保留共享合作记录', () => {
  addUser('cascade-supervisor', 'supervisor');
  addUser('cascade-user', 'supervisee', 'cascade-supervisor');
  const now = Date.now();
  db.prepare('INSERT INTO plans(id, title, creator_id, assignee_id, created_at) VALUES (?, ?, ?, ?, ?)').run('cascade-plan', 'p', 'cascade-supervisor', 'cascade-user', now);
  db.prepare('INSERT INTO plan_days(id, plan_id, seq, day_date, created_at) VALUES (?, ?, 1, ?, ?)').run('cascade-day', 'cascade-plan', '2026-09-06', now);
  db.prepare('INSERT INTO tasks(id, title, creator_id, assignee_id, created_at) VALUES (?, ?, ?, ?, ?)').run('cascade-task', 't', 'cascade-supervisor', 'cascade-user', now);
  db.prepare('INSERT INTO life_logs(id, user_id, log_date, content, created_at) VALUES (?, ?, ?, ?, ?)').run('cascade-life', 'cascade-user', '2026-09-06', 'x', now);
  db.prepare('INSERT INTO notifications(id, user_id, kind, title, created_at) VALUES (?, ?, ?, ?, ?)').run('cascade-note', 'cascade-user', 'x', 'x', now);
  db.exec('BEGIN IMMEDIATE');
  userRepo.removeCascade(db, 'cascade-user');
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users WHERE id=?').get('cascade-user').c, 0);
  for (const table of ['life_logs', 'notifications']) assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${table === 'plans' || table === 'tasks' ? 'id LIKE \'cascade-%\'' : 'id LIKE \'cascade-%\''}`).get().c, 0, table);
  for(const table of ['plans','plan_days','tasks'])assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE id LIKE 'cascade-%'`).get().c,1);
  assert.equal(db.prepare('SELECT managed_by FROM users WHERE id=?').get('cascade-supervisor').managed_by, null);
});

test('编辑任务会重新开启提醒窗口', () => {
  const now = Date.now();
  db.prepare("INSERT INTO tasks(id, title, creator_id, assignee_id, due_at, remind_fired_at, overdue_fired_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run('remind-reset', 'old', 'page-user', 'page-user', now + 60000, now, now, now);
  taskRepo.update(db, 'remind-reset', { title: 'new', note: '', assigneeId: 'page-user', dueAt: now + 120000, remindBeforeMinutes: 30 });
  const task = taskRepo.byId(db, 'remind-reset');
  assert.equal(task.remind_fired_at, null);
  assert.equal(task.overdue_fired_at, null);
});

test('修改任务备注不会重复开启提醒', () => {
  const now = Date.now();
  db.prepare("INSERT INTO tasks(id, title, note, creator_id, assignee_id, due_at, remind_before_minutes, remind_fired_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run('remind-note', 'old', '', 'page-user', 'page-user', now + 60000, 30, now, now);
  taskRepo.update(db, 'remind-note', { title: 'new', note: 'updated', assigneeId: 'page-user', dueAt: now + 60000, remindBeforeMinutes: 30 });
  assert.equal(taskRepo.byId(db, 'remind-note').remind_fired_at, now);
});

test('未来提醒任务不会被扫描出来', () => {
  const future = Date.now() + 3600000;
  db.prepare("INSERT INTO tasks(id, title, creator_id, assignee_id, due_at, remind_before_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run('future-remind', 'future', 'page-user', 'page-user', future, 30, Date.now());
  assert.equal(taskRepo.listDueUnreminded(db, Date.now()).some((task) => task.id === 'future-remind'), false);
});

test('任务列表受分页上限约束', () => {
  addUser('page-user', 'supervisee');
  const now = Date.now();
  const insert = db.prepare('INSERT INTO tasks(id, title, creator_id, assignee_id, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 4; i++) insert.run(`page-task-${i}`, `t${i}`, 'page-user', 'page-user', now + i);
  assert.equal(taskRepo.list(db, { assigneeId: 'page-user' }, 2, 1).length, 2);
});

test('危险通知命令进入失败重试状态', async () => {
  notify.setNotifyConfig(db, { enabled: true, command: 'echo safe && whoami' });
  await notify.deliver(db, { userId: 'page-user', kind: 'test', title: 'x', content: 'x' });
  await notify.processOutbox(db);
  const row = db.prepare('SELECT status, last_error FROM notification_outbox ORDER BY created_at DESC LIMIT 1').get();
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /unsafe/);
});

test('重复完成状态更新不会改变提醒幂等标记', () => {
  const now = Date.now();
  db.prepare("INSERT INTO tasks(id, title, creator_id, assignee_id, status, done_at, created_at) VALUES (?, ?, ?, ?, 'done', ?, ?)").run('done-repeat', 'done', 'page-user', 'page-user', now, now);
  const before = db.prepare('SELECT done_at FROM tasks WHERE id=?').get('done-repeat').done_at;
  taskRepo.setStatus(db, 'done-repeat', 'done', now + 1000, 'again');
  const after = db.prepare('SELECT status, checkin_note FROM tasks WHERE id=?').get('done-repeat');
  assert.equal(after.status, 'done');
  assert.equal(after.checkin_note, 'again');
  assert.equal(before, now);
});

test('审计日志可写入并读取', () => {
  auditRepo.record(db, { actorId: 'page-user', method: 'POST', path: '/api/test', ip: '127.0.0.1' });
  const row = auditRepo.list(db, 1)[0];
  assert.equal(row.actor_id, 'page-user');
  assert.equal(row.path, '/api/test');
});

test.after(() => {
  db.close?.();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});
