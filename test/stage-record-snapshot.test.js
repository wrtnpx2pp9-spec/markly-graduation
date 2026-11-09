'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-stage-snapshot-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const database = require('../src/db');
const db = database.getDb();
const reviews = require('../src/repo/phase-review.repo');

test('双方最后确认时原子保存执行统计和联名卡快照，后续实时统计不改快照', () => {
  const now = Date.now();
  db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at) VALUES ('snapshot-cycle','阶段','snapshot-sup','snapshot-sub','cycle','active',?)").run(now);
  db.prepare("INSERT INTO plan_days(id,plan_id,seq,day_date,content,checkin_state,created_at) VALUES ('snapshot-day-1','snapshot-cycle',1,'2030-01-01','任务','approved',?),('snapshot-day-2','snapshot-cycle',2,'2030-01-02','任务','pending',?)").run(now, now);
  const base = { parentPlanId: 'snapshot-parent', cyclePlanId: 'snapshot-cycle', superviseeId: 'snapshot-sub', supervisorId: 'snapshot-sup' };
  reviews.saveSelf(db, { ...base, summary: '自评', difficulty: '', helpfulMethod: '', nextAction: '继续', now });
  reviews.saveSupervisor(db, { ...base, observation: '观察', progress: '', suggestion: '', resultLabel: '有所进步', recommendNext: '建议继续', now: now + 1 });
  const revision = reviews.byCycleId(db, 'snapshot-cycle').content_revision;
  assert.equal(reviews.confirm(db, 'snapshot-cycle', 'supervisee', now + 2, revision).locked_at, null);
  const locked = reviews.confirm(db, 'snapshot-cycle', 'supervisor', now + 3, revision);
  assert.deepEqual(JSON.parse(locked.execution_snapshot), { total: 2, done: 1, percent: 50 });
  db.prepare("UPDATE plan_days SET checkin_state='approved' WHERE plan_id='snapshot-cycle'").run();
  const repeated = reviews.confirm(db, 'snapshot-cycle', 'supervisor', now + 4, revision);
  assert.deepEqual(JSON.parse(repeated.execution_snapshot), { total: 2, done: 1, percent: 50 });
  assert.deepEqual(reviews.toStageReview(repeated, { role: 'admin', id: 'admin' }).executionSnapshot, { total: 2, done: 1, percent: 50 });
});

test('旧锁定记录没有快照时保持未记录，迁移只需单一执行快照列', () => {
  const columns = db.prepare('PRAGMA table_info(phase_stage_reviews)').all().map((c) => c.name);
  assert.ok(columns.includes('execution_snapshot'));
  assert.equal(columns.includes('card_snapshot'), false);
  db.prepare("INSERT INTO phase_stage_reviews(id,parent_plan_id,cycle_plan_id,supervisee_id,supervisor_id,locked_at,created_at,updated_at) VALUES('legacy-review','legacy-parent','legacy-cycle','legacy-sub','legacy-sup',?,?,?)").run(100, 100, 100);
  const row = reviews.confirm(db, 'legacy-cycle', 'supervisee', 200, reviews.byCycleId(db, 'legacy-cycle').content_revision);
  assert.equal(row.locked_at, 100);
  assert.equal(row.execution_snapshot, null);
  assert.equal(reviews.toStageReview(row, { role: 'admin', id: 'admin' }).executionSnapshot, null);
});

test('联名卡与历史详情都显示确认时快照或未记录', () => {
  const vm = require('node:vm');
  const context = vm.createContext({ st: {}, me: { id: 'u' }, esc: (v) => String(v), personName: (v) => String(v || ''), fmtTime: (v) => String(v), Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/phase.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/cooperation-history.js'), 'utf8'), context);
  const locked = { id: 'legacy-cycle', title: '阶段', status: 'active', assigneeId: 'sub', creatorId: 'sup', stageReview: { lockedAt: 100 }, days: [] };
  assert.match(vm.runInContext('phaseRecordHTML(' + JSON.stringify(locked) + ')', context), /确认时统计：未记录/);
  assert.match(vm.runInContext('historyReviewHTML({lockedAt:100})', context), /确认时统计：未记录/);
  const current = { ...locked, stageReview: { lockedAt: 100, executionSnapshot: { total: 2, done: 1, percent: 50 } } };
  assert.match(vm.runInContext('historyReviewHTML(' + JSON.stringify(current.stageReview) + ')', context), /确认时统计：1\/2 天（50%）/);
});

test.after(() => { database.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
