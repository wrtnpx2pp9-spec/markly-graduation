'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-plan-agreement-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { getDb, closeDb } = require('../src/db');
const db = getDb();
const users = require('../src/repo/user.repo');
const profiles = require('../src/repo/profile.repo');
const security = require('../src/security');
const app = require('../src/app').createApp(db);
const tokens = {};

for (const [id, role] of [['sup', 'supervisor'], ['sub', 'supervisee'], ['admin', 'admin']]) {
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES(?,?,?,?,?,?,1,?)')
    .run(id, id, role, 'hash', 'salt', id, Date.now());
  tokens[id] = security.createSession(db, id);
}
require('../src/repo/cooperation.repo').save(db, users.byId(db, 'sup'), 'admin', {
  state: 'active', capacity: 1, agreementRef: 'test', note: 'test', published: true,
});
profiles.save(db, 'sup', { headline: '监督', bio: '简介', skills: ['学习'], serviceStyle: '每日反馈', published: true, accepting: true });

async function call(id, method, url, body = {}) {
  let result;
  const res = { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } };
  await app.dispatch(method, url, { method, url, headers: { authorization: `Bearer ${tokens[id]}` } }, res, {}, body);
  return result;
}

test.after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test('首bundle只能由请求绑定的根phase确认，独立新增cycle仍可确认', async () => {
  // Team listing is available from an active, administrator-authorized service
  // profile even when the supervisor keeps the personal page private.
  const market = await call('sub', 'GET', '/api/market');
  assert.equal(market.list.find(item => item.id === 'sup').publicVisible, false);
  assert.equal((await call('sub', 'GET', '/api/profiles/sup')).status, 200);
  const request = await call('sub', 'POST', '/api/requests', { personId: 'sup', goal: '目标', mode: 'quick', desiredStartAt: Date.now() });
  assert.equal(request.status, 200);
  assert.equal((await call('sup', 'POST', `/api/requests/${request.id}/confirm`)).status, 200);

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const bundle = await call('sup', 'POST', '/api/plan-bundles', {
    requestId: request.id, assigneeId: 'sub', title: '首计划', dailyContent: '学习', startAt: +start, dueAt: +start,
  });
  assert.equal(bundle.status, 200);
  const child = db.prepare('SELECT * FROM plans WHERE parent_id=?').get(bundle.plan.id);
  assert.equal(child.service_request_id, request.id);

  // A child carrying the copied request id cannot mutate the request or bundle.
  assert.equal((await call('sub', 'POST', `/api/plans/${child.id}/agreement`, { decision: 'decline', note: '调整' })).status, 409);
  assert.equal(db.prepare('SELECT status,plan_id FROM service_requests WHERE id=?').get(request.id).status, 'plan_proposed');
  assert.deepEqual(db.prepare('SELECT status FROM plans WHERE id=? OR parent_id=? ORDER BY parent_id').all(bundle.plan.id, bundle.plan.id).map(x => x.status), ['proposed', 'proposed']);

  const beforeMismatch = db.prepare('SELECT status,plan_id FROM service_requests WHERE id=?').get(request.id);
  db.prepare('UPDATE service_requests SET plan_id=? WHERE id=?').run('wrong-plan', request.id);
  assert.equal((await call('sub', 'POST', `/api/plans/${bundle.plan.id}/agreement`, { decision: 'accept' })).status, 409);
  const unchangedMismatch = db.prepare('SELECT status,plan_id FROM service_requests WHERE id=?').get(request.id);
  assert.equal(unchangedMismatch.status, 'plan_proposed');
  assert.equal(unchangedMismatch.plan_id, 'wrong-plan');
  db.prepare('UPDATE service_requests SET plan_id=? WHERE id=?').run(beforeMismatch.plan_id, request.id);
  assert.equal((await call('sub', 'POST', `/api/plans/${bundle.plan.id}/agreement`, { decision: 'accept' })).status, 200);
  assert.deepEqual(db.prepare('SELECT status FROM plans WHERE id=? OR parent_id=? ORDER BY parent_id').all(bundle.plan.id, bundle.plan.id).map(x => x.status), ['active', 'active']);
  assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(request.id).status, 'accepted');

  const independent = await call('sup', 'POST', '/api/plans', {
    kind: 'cycle', parentId: bundle.plan.id, assigneeId: 'sub', title: '后续阶段', dailyContent: '复习',
    startAt: +start + 86400000, dueAt: +start + 2 * 86400000,
  });
  assert.equal(independent.status, 200);
  assert.equal(independent.plan.serviceRequestId, null);
  assert.equal((await call('sub', 'POST', `/api/plans/${independent.plan.id}/agreement`, { decision: 'accept' })).status, 200);
  assert.equal((await call('sub', 'POST', `/api/plans/${independent.plan.id}/agreement`, { decision: 'accept' })).status, 409);
  assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(independent.plan.id).status, 'active');
  assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(bundle.plan.id).status, 'active');

  // Private team profiles become unavailable when administrator service access is paused.
  db.prepare("UPDATE users SET cooperation_state='paused' WHERE id='sup'").run();
  await call('sub', 'DELETE', '/api/relations/sup');
  assert.equal((await call('sub', 'GET', '/api/profiles/sup')).status, 404);
});

test('declining the complete bundle permits a corrected proposal and rejects old child acceptance',async()=>{
  db.prepare("UPDATE users SET cooperation_state='active' WHERE id='sup'").run();
  const request=await call('sub','POST','/api/requests',{personId:'sup',goal:'revised goal',mode:'quick',desiredStartAt:Date.now()});
  assert.equal(request.status,200);assert.equal((await call('sup','POST',`/api/requests/${request.id}/confirm`)).status,200);
  const start=new Date();start.setHours(0,0,0,0);
  const input={requestId:request.id,assigneeId:'sub',title:'Revision',dailyContent:'Read',startAt:+start,dueAt:+start};
  const first=await call('sup','POST','/api/plan-bundles',input);assert.equal(first.status,200);
  const child=db.prepare('SELECT id FROM plans WHERE parent_id=?').get(first.plan.id);
  assert.equal((await call('sub','POST',`/api/plans/${child.id}/agreement`,{decision:'accept'})).status,409);
  assert.equal((await call('sub','POST',`/api/plans/${first.plan.id}/agreement`,{decision:'decline',note:'Adjust schedule'})).status,200);
  assert.deepEqual(db.prepare('SELECT status FROM plans WHERE id=? OR parent_id=?').all(first.plan.id,first.plan.id).map(x=>x.status),['declined','declined']);
  const revised=await call('sup','POST','/api/plan-bundles',input);assert.equal(revised.status,200);
  assert.equal((await call('sub','POST',`/api/plans/${first.plan.id}/agreement`,{decision:'accept'})).status,409);
  assert.equal((await call('sub','POST',`/api/plans/${revised.plan.id}/agreement`,{decision:'accept'})).status,200);
  assert.equal((await call('sub','POST',`/api/plans/${revised.plan.id}/agreement`,{decision:'accept'})).status,409);
});
