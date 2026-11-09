'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), drafts = require('../src/plan-drafts');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/plan-import.ctrl').register(router, deps);
async function call(user, method, url, body = {}) {
  current = users.byId(db, user.id);
  let result;
  await router.dispatch(method, url, { method, url, headers: {} }, { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } }, {}, body);
  return result;
}
test('failed manual draft finalization leaves no row or quota usage and retry creates a complete recoverable draft', async () => {
  const actor = role => users.insert(db, { username: `manual-atomicity-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const supervisor = actor('supervisor'), supervisee = actor('supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=2 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  const input = { assigneeId: supervisee.id, workspace: { personId: supervisee.id, title: 'Incomplete manual draft', description: 'Keep editing later', stages: [] }, bundle: { assigneeId: supervisee.id, title: 'Incomplete manual draft', description: 'Keep editing later', cycles: [] } };
  // Fill 99 slots so a leaked failed row would incorrectly block the retry.
  for (let index = 0; index < 99; index++) drafts.create(db, supervisor.id, supervisee.id, null, { name: 'Quota fixture', lines: [] }, { manual: true }, input.workspace, { bundle: input.bundle, reviewed: true });
  const count = () => db.prepare('SELECT COUNT(*) n FROM plan_drafts WHERE owner_id=? AND plan_id IS NULL').get(supervisor.id).n;
  db.exec("CREATE TRIGGER fail_manual_finalization BEFORE UPDATE OF bundle_json ON plan_drafts BEGIN SELECT RAISE(ABORT,'isolated draft finalization failure'); END");
  let failed, afterFailure;
  try {
    failed = await call(supervisor, 'POST', '/api/plan-drafts', input);
    afterFailure = count();
  } finally { db.exec('DROP TRIGGER fail_manual_finalization'); }
  // Always attempt retry before asserting the row count, so both observable
  // consequences of a partial save are exercised against the original code.
  const retry = await call(supervisor, 'POST', '/api/plan-drafts', input);
  assert.equal(failed.status, 400);
  assert.equal(afterFailure, 99, 'failed save must not consume the final draft slot');
  assert.equal(retry.status, 201, JSON.stringify(retry));
  assert.equal(count(), 100);
  assert.equal(retry.draft.version, 1);
  assert.equal(retry.draft.reviewed, true);
  assert.equal(retry.draft.kind, 'manual');
  assert.deepEqual(retry.draft.workspace, input.workspace);
  const stored = drafts.get(db, retry.draft.id, supervisor.id);
  assert.deepEqual(JSON.parse(stored.bundle_json), input.bundle);
  assert.equal(stored.plan_id, null);
  assert.equal(stored.assignee_id, supervisee.id);
  const restored = await call(supervisor, 'GET', `/api/plan-drafts/${retry.draft.id}`);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.draft, retry.draft);
});
test.after(() => database.closeDb());
