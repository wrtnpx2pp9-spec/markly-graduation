'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const users = require('../src/repo/user.repo');
const drafts = require('../src/plan-drafts');
const config = require('../src/plan-agent/config');
const pi = require('../src/plan-agent/pi-runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); }
  throw new Error('isolated draft job did not settle');
}

test('AI 等待期间真实发送草稿，迟到候选只能待核对，已发送草稿与计划保持原样', async t => {
  const db = getDb(), originalRun = pi.run;
  const make = role => users.insert(db, { username: 'draft-boundary-' + role, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const supervisor = make('supervisor'), supervisee = make('supervisee');
  require('../src/repo/cooperation.repo').save(db, supervisor, supervisor.id, { state: 'active', capacity: 1, agreementRef: 'test', note: 'test', published: false });
  users.setRelations(db, supervisee.id, [supervisor.id]);
  const service = require('../src/plan-agent/service').create(db, {});
  let release;
  t.after(async () => {
    release?.();
    await service.stop();
    pi.run = originalRun;
    closeDb();
  });
  const provider = value => db.prepare('UPDATE plan_agent_config SET config_json=? WHERE id=1')
    .run(JSON.stringify({ ...config.get(db), enabled: true, provider: value, model: 'isolated-model' }));
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const body = { assigneeId: supervisee.id, instruction: '每天学习三十分钟', constraints: { start: date, days: 1, workdays: [1, 2, 3, 4, 5, 6, 7], dailyLimit: 30 } };
  provider('mock');
  const first = service.enqueue(users.byId(db, supervisor.id), body, 'initial-draft');
  await waitFor(() => service.get(supervisor, first.jobId).status === 'completed');
  const draftId = service.get(supervisor, first.jobId).resultDraftId;
  let current;
  const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
  const router = require('../src/router').createRouter({ db, deps });
  require('../src/controllers/plan.ctrl').register(router, deps);
  require('../src/controllers/plan-import.ctrl').register(router, deps);
  async function call(actor, method, url, input) {
    current = users.byId(db, actor.id);
    let result;
    await router.dispatch(method, url, { method, url, headers: {} }, {
      writeHead(status) { this.status = status; },
      end(text) { result = { status: this.status, ...JSON.parse(text) }; },
    }, {}, input);
    assert.equal(result.status, 200, JSON.stringify(result));
    return result;
  }
  const initial = drafts.get(db, draftId, supervisor.id);
  const reviewed = await call(supervisor, 'PUT', '/api/plan-drafts/' + draftId, {
    version: initial.version, workspace: JSON.parse(initial.workspace_json), bundle: JSON.parse(initial.bundle_json), reviewed: true,
  });
  provider('injected');
  let entered = false;
  const held = new Promise(resolve => { release = resolve; });
  pi.run = async args => {
    entered = true;
    await held;
    assert.equal(args.saveCandidate(args.context.template).ok, true);
  };
  const updating = service.enqueue(users.byId(db, supervisor.id), { ...body, instruction: '每天阅读三十分钟', draftId, baseVersion: reviewed.draft.version }, 'updating-draft');
  await waitFor(() => entered);
  const offered = drafts.get(db, draftId, supervisor.id);
  const published = await call(supervisor, 'POST', '/api/plan-bundles', { ...JSON.parse(offered.bundle_json), draftId, draftVersion: offered.version });
  const sentDraft = { ...drafts.get(db, draftId, supervisor.id) };
  const plans = () => db.prepare('SELECT * FROM plans WHERE id=? OR parent_id=? ORDER BY id').all(published.plan.id, published.plan.id);
  const sentPlans = plans();
  assert.equal(sentDraft.plan_id, published.plan.id);
  assert.equal(sentDraft.version, offered.version, 'publishing does not change the editor version');
  release();
  await waitFor(() => service.get(supervisor, updating.jobId).status !== 'running');
  assert.equal(service.get(supervisor, updating.jobId).status, 'needs_review');
  assert.deepEqual({ ...drafts.get(db, draftId, supervisor.id) }, sentDraft);
  assert.deepEqual(plans(), sentPlans);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM plan_drafts').get().count, 1);
  assert.equal(db.prepare('SELECT error_code FROM plan_agent_jobs WHERE job_id=?').get(updating.jobId).error_code, 'needs_review');
});
