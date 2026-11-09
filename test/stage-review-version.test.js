'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-review-version-'));
process.env.DB_PATH = path.join(dir, 'review.db');
const database = require('../src/db');
let db = database.getDb(), current, serial = 0;
const users = require('../src/repo/user.repo'), reviews = require('../src/repo/phase-review.repo');
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/plan.ctrl').register(router, deps);
require('../src/controllers/cooperation-history.ctrl').register(router, deps);
function call(user, method, url, body = {}) {
  current = users.byId(db, user.id);
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { http: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
function ok(user, method, url, body) {
  const result = call(user, method, url, body);
  assert.equal(result.http, 200, JSON.stringify(result));
  return result;
}
function fixture() {
  const add = role => users.insert(db, { username: `review-version-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const sup = add('supervisor'), sub = add('supervisee');
  require('../src/repo/cooperation.repo').save(db, sup, sup.id, { state: 'active', capacity: 1, agreementRef: 'isolated-test', note: 'test', published: false });
  users.setRelations(db, sub.id, [sup.id]);
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 2);
  const root = ok(sup, 'POST', '/api/plan-bundles', { title: '复盘版本目标', assigneeId: sub.id, startAt: +start, dueAt: +start + 86399999, dailyContent: '练习' }).plan;
  ok(sub, 'POST', `/api/plans/${root.id}/agreement`, { decision: 'accept' });
  const stage = db.prepare('SELECT * FROM plans WHERE parent_id=?').get(root.id);
  ok(sub, 'PUT', `/api/plans/${stage.id}/stage-review/self`, { summary: 'Original summary' });
  ok(sup, 'PUT', `/api/plans/${stage.id}/stage-review/supervisor`, { observation: 'Supervisor observation' });
  const read = viewer => ok(viewer, 'GET', '/api/plans').plans.find(p => p.id === stage.id).stageReview;
  const confirm = (viewer, revision) => call(viewer, 'POST', `/api/plans/${stage.id}/stage-review/confirm`, { revision });
  return { sup, sub, root, stage, read, confirm };
}

test('旧页面不能确认另一方修改后的复盘，重新读取后双方可确认同一内容版本', () => {
  const { sup, sub, root, stage, read, confirm } = fixture();
  const viewed = read(sup);
  assert.equal(viewed.selfSummary, 'Original summary');
  ok(sub, 'PUT', `/api/plans/${stage.id}/stage-review/self`, { summary: 'Changed summary not seen by supervisor' });
  const before = reviews.byCycleId(db, stage.id);
  const stale = confirm(sup, viewed.revision);
  assert.equal(stale.http, 409, JSON.stringify(stale));
  assert.match(stale.error, /刷新/);
  assert.deepEqual(reviews.byCycleId(db, stage.id), before, 'rejection leaves confirmation flags and signed text unchanged');
  const fresh = read(sup);
  assert.equal(fresh.selfSummary, 'Changed summary not seen by supervisor');
  assert.ok(fresh.revision > viewed.revision);
  assert.equal(confirm(sup, fresh.revision).http, 200);
  assert.equal(read(sub).revision, fresh.revision, 'confirmation does not change the content revision');
  assert.equal(confirm(sub, fresh.revision).http, 200);
  const locked = reviews.byCycleId(db, stage.id);
  assert.ok(locked.locked_at);
  assert.equal(locked.content_revision, fresh.revision);
  assert.equal(locked.self_summary, fresh.selfSummary);
  const history = ok(sub, 'GET', `/api/cooperation-history/plans/${root.id}`).records.find(p => p.id === stage.id);
  assert.equal(history.stageReview.revision, fresh.revision);
  assert.equal(history.stageReview.selfSummary, fresh.selfSummary);
  assert.equal(confirm(sup, fresh.revision).http, 200, 'same-content retry is idempotent after locking');
  assert.deepEqual(reviews.byCycleId(db, stage.id), locked);
});

test('缺失或无效的确认版本要求刷新，并且不产生确认状态', () => {
  const { sup, stage } = fixture(), before = reviews.byCycleId(db, stage.id);
  for (const revision of [undefined, null, '3', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = call(sup, 'POST', `/api/plans/${stage.id}/stage-review/confirm`, revision === undefined ? {} : { revision });
    assert.equal(result.http, 409, JSON.stringify(result));
    assert.match(result.error, /刷新/);
    assert.deepEqual(reviews.byCycleId(db, stage.id), before);
  }
});

test('双方编辑均递增内容版本并清除确认，同毫秒编辑也不能复用旧版本', () => {
  const { sup, sub, stage } = fixture();
  const base = { parentPlanId: stage.parent_id, cyclePlanId: stage.id, superviseeId: sub.id, supervisorId: sup.id, now: Date.now() };
  let row = reviews.byCycleId(db, stage.id);
  const firstRevision = row.content_revision;
  reviews.confirm(db, stage.id, 'supervisee', base.now, firstRevision);
  row = reviews.saveSupervisor(db, { ...base, observation: 'Revised observation', progress: '', suggestion: '', resultLabel: '', recommendNext: '' });
  assert.equal(row.content_revision, firstRevision + 1);
  assert.equal(row.supervisee_confirmed, 0); assert.equal(row.supervisor_confirmed, 0);
  reviews.confirm(db, stage.id, 'supervisor', base.now, row.content_revision);
  const previousRevision = row.content_revision;
  row = reviews.saveSelf(db, { ...base, summary: 'Revised self summary', difficulty: '', helpfulMethod: '', nextAction: '' });
  assert.equal(row.content_revision, previousRevision + 1);
  assert.equal(row.supervisee_confirmed, 0); assert.equal(row.supervisor_confirmed, 0);
  assert.equal(row.updated_at, base.now, 'the clock is intentionally identical for both edits');
  assert.throws(() => reviews.confirm(db, stage.id, 'supervisor', base.now, previousRevision), /刷新/);
  assert.deepEqual(reviews.byCycleId(db, stage.id), row);
});

test('最后确认保存快照失败时回滚本次确认，重试保持内容版本并可完成锁定', () => {
  const { sup, sub, stage, read, confirm } = fixture();
  const revision = read(sup).revision;
  assert.equal(confirm(sup, revision).http, 200);
  const before = reviews.byCycleId(db, stage.id);
  db.exec(`CREATE TRIGGER fail_review_snapshot BEFORE UPDATE OF locked_at ON phase_stage_reviews
    WHEN NEW.locked_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected snapshot failure'); END;`);
  try {
    assert.throws(() => confirm(sub, revision), /injected snapshot failure/);
    assert.deepEqual(reviews.byCycleId(db, stage.id), before);
  } finally { db.exec('DROP TRIGGER fail_review_snapshot'); }
  assert.equal(confirm(sub, revision).http, 200);
  assert.ok(reviews.byCycleId(db, stage.id).locked_at);
  assert.equal(reviews.byCycleId(db, stage.id).content_revision, revision);
});

test('确认弹窗携带展示时的内容版本，而非稍后变化的内存版本', async () => {
  const cycle = { id: 'browser-stage', stageReview: { revision: 7 } };
  let submit, request;
  const context = vm.createContext({
    st: {}, me: {}, Date,
    openModal: (_title, _body, callback) => { submit = callback; },
    $: () => ({}), api: async (method, url, body) => { request = { method, url, body }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/phase.js'), 'utf8'), context);
  context.phaseCycleById = () => cycle;
  context.phaseRecordHTML = () => 'shown revision 7';
  context.phaseRefresh = async () => {};
  vm.runInContext("phaseConfirmModal('browser-stage')", context);
  cycle.stageReview.revision = 8;
  await submit();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/plans/browser-stage/stage-review/confirm');
  assert.equal(request.body.revision, 7);
});

test('旧库补内容版本保持原确认、正文与未知快照，重复启动不重置版本', () => {
  if (db.prepare('PRAGMA table_info(phase_stage_reviews)').all().some(c => c.name === 'content_revision')) db.exec('ALTER TABLE phase_stage_reviews DROP COLUMN content_revision');
  db.prepare(`INSERT INTO phase_stage_reviews(id,parent_plan_id,cycle_plan_id,supervisee_id,supervisor_id,
    self_summary,supervisee_confirmed,supervisor_confirmed,locked_at,created_at,updated_at)
    VALUES('legacy-version','legacy-parent','legacy-cycle','legacy-sub','legacy-sup','original historical text',1,1,100,90,100)`).run();
  database.closeDb(); db = database.getDb();
  let legacy = reviews.byCycleId(db, 'legacy-cycle');
  assert.equal(legacy.content_revision, 1);
  assert.equal(legacy.self_summary, 'original historical text');
  assert.equal(legacy.locked_at, 100);
  assert.equal(legacy.supervisee_confirmed, 1); assert.equal(legacy.supervisor_confirmed, 1);
  assert.equal(legacy.execution_snapshot, null);
  assert.equal(reviews.toStageReview(legacy, { role: 'admin' }).revision, 1);
  db.prepare('UPDATE phase_stage_reviews SET content_revision=9 WHERE id=?').run(legacy.id);
  database.closeDb(); db = database.getDb();
  legacy = reviews.byCycleId(db, 'legacy-cycle');
  assert.equal(legacy.content_revision, 9);
  assert.equal(legacy.locked_at, 100);
  assert.equal(legacy.execution_snapshot, null);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test.after(() => { database.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
