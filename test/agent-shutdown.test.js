'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const users = require('../src/repo/user.repo');
const config = require('../src/plan-agent/config');
const pi = require('../src/plan-agent/pi-runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); }
  throw new Error('isolated agent did not settle');
}
function fixture(t, { provider = 'injected', maxConcurrent = 2 } = {}) {
  const db = getDb();
  const now = Date.now();
  const supervisor = users.insert(db, { username: 'shutdown-supervisor', role: 'supervisor', passwordHash: 'hash', salt: 'salt', createdAt: now });
  const sub = users.insert(db, { username: 'shutdown-sub', role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: now });
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=1 WHERE id=?").run(supervisor.id);
  db.prepare("INSERT INTO supervision_relations(supervisor_id,supervisee_id,status,created_at) VALUES (?,?,'active',?)").run(supervisor.id, sub.id, now);
  const service = require('../src/plan-agent/service').create(db, {});
  db.prepare('UPDATE plan_agent_config SET config_json=? WHERE id=1')
    .run(JSON.stringify({ ...config.get(db), enabled: true, provider, model: 'fake-model', maxConcurrent }));
  const body = { assigneeId: sub.id, instruction: '每天学习三十分钟', constraints: { start: '2026-10-10', days: 1, workdays: [1, 2, 3, 4, 5, 6, 7], dailyLimit: 30 } };
  const releases = [], services = [service], originalRun = pi.run;
  t.after(async () => {
    for (const release of releases) release();
    await Promise.all(services.map(item => item.stop()));
    pi.run = originalRun;
    closeDb();
  });
  return { db, service, supervisor: users.byId(db, supervisor.id), sub, body, releases, services };
}

test('计划 AI 停止等待所有在途任务落库，保留队列并拒绝迟到的创建和重试', async t => {
  const { db, service, supervisor, body, releases } = fixture(t);
  const calls = [];
  pi.run = async args => {
    const held = gate();
    calls.push({ args, held });
    releases.push(held.release);
    await held.promise;
  };
  const jobs = [0, 1, 2].map(i => service.enqueue(supervisor, body, 'stop-' + i));
  await waitFor(() => calls.length === 2);
  const stopping = service.stop();
  assert.equal(service.stop(), stopping);
  assert.ok(calls.every(call => call.args.signal.aborted));
  assert.throws(() => service.enqueue(supervisor, body, 'late-job'), error => error.statusCode === 503);
  assert.throws(() => service.retry(supervisor, jobs[0].jobId, 'late-retry'), error => error.statusCode === 503);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_agent_jobs').get().n, 3);
  let stopped = false;
  stopping.then(() => { stopped = true; });
  calls[0].held.release();
  await waitFor(() => service.list(supervisor).some(job => job.status === 'cancelled'));
  assert.equal(stopped, false);
  calls[1].held.release();
  await stopping;
  assert.equal(calls.length, 2);
  assert.deepEqual(service.list(supervisor).map(job => job.status).sort(), ['cancelled', 'cancelled', 'queued']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plan_agent_jobs WHERE status='cancelled' AND lease_owner IS NULL AND lease_expires_at IS NULL").get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_drafts').get().n, 0);
  closeDb();
  await sleep(20); // All model callbacks and heartbeats must already be gone.
});

test('停止清除尚未执行的定时器，完成停止后可显式重新启动', async t => {
  const { service, supervisor, body } = fixture(t, { provider: 'mock' });
  const queued = service.enqueue(supervisor, body, 'restart-job');
  await service.stop();
  await sleep(10);
  assert.equal(service.get(supervisor, queued.jobId).status, 'queued');
  service.start();
  await waitFor(() => service.get(supervisor, queued.jobId).status === 'completed');
  assert.equal(service.get(supervisor, queued.jobId).attempt, 1);
  await service.stop();
});

test('运营 AI 停止等待迟到的模型回调，禁止停止后生成报告或发送通知', async t => {
  const { db, services, releases, sub } = fixture(t);
  const admin = users.insert(db, { username: 'shutdown-admin', role: 'admin', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const platform = require('../src/platform-agent/service').create(db);
  services.push(platform);
  const priorPassword = process.env.ADMIN_AGENT_SECONDARY_PASSWORD;
  process.env.ADMIN_AGENT_SECONDARY_PASSWORD = 'isolated-secondary-password';
  t.after(() => { if (priorPassword === undefined) delete process.env.ADMIN_AGENT_SECONDARY_PASSWORD; else process.env.ADMIN_AGENT_SECONDARY_PASSWORD = priorPassword; });
  const session = require('../src/security').createSession(db, admin.id);
  const grant = platform.reauth(admin, 'isolated-secondary-password', session).reauthToken;
  const held = gate();
  releases.push(held.release);
  let entered, signal;
  const arrived = new Promise(resolve => { entered = resolve; });
  const outcomes = [];
  pi.run = async args => {
    signal = args.signal;
    entered();
    await held.promise;
    for (const [name, params] of [
      ['save_operations_report', { title: '测试', summary: '测试摘要', sections: [], chartSpecs: [] }],
      ['send_platform_notification', { userId: sub.id, title: '测试通知', content: '测试正文' }],
    ]) {
      try { outcomes.push((await args.tools.find(tool => tool.name === name).execute('late-tool', params)).details); }
      catch (error) { outcomes.push({ ok: false, statusCode: error.statusCode }); }
    }
  };
  const run = platform.run(admin, { instruction: '查看运营情况', allowNotifications: true }, session, grant);
  const rejected = assert.rejects(run, error => error.statusCode === 409);
  await arrived;
  const stopping = platform.stop();
  assert.equal(platform.stop(), stopping);
  assert.equal(signal.aborted, true);
  assert.throws(() => platform.run(admin, { instruction: '迟到的请求' }, session, grant), error => error.statusCode === 503);
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await sleep(10);
  assert.equal(stopped, false);
  held.release();
  await Promise.all([stopping, rejected]);
  assert.ok(outcomes.every(outcome => outcome.ok === false));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM platform_agent_reports').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  closeDb();
  await sleep(20);
});

test('运营请求断连后 HTTP 关闭仍等待模型回调，数据库可安全关闭', async t => {
  const { db, services, releases } = fixture(t);
  const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-agent-http-stop-'));
  const env = { HOST: '127.0.0.1', PORT: '0', ILINK_STATE_DIR: path.join(dir, 'ilink'), ADMIN_AGENT_SECONDARY_PASSWORD: 'isolated-http-password' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('markly-agent-http-stop-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const appModule = require('../src/app'), originalCreate = appModule.createApp;
  let app;
  t.mock.method(appModule, 'createApp', (...args) => { app = originalCreate(...args); return app; });
  const held = gate();
  releases.push(held.release);
  let entered, signal, settled = false;
  const arrived = new Promise(resolve => { entered = resolve; });
  pi.run = async args => { signal = args.signal; entered(); await held.promise; try { await args.tools[0].execute(); } finally { settled = true; } };
  const server = require('../server').start();
  services.push({ stop: async () => {
    await server.stopBackground();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  } });
  await new Promise(resolve => server.once('listening', resolve));
  const admin = users.insert(db, { username: 'http-stop-admin', role: 'admin', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const token = require('../src/security').createSession(db, admin.id);
  const grant = app.deps.platformAgent.reauth(admin, 'isolated-http-password', token).reauthToken;
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/admin/platform-agent/runs', headers: {
    'Content-Type': 'application/json', 'X-Markly-Client': 'web', 'X-Markly-User': admin.id,
    Cookie: 'sd_session=' + token, 'X-Platform-Agent-Reauth': grant,
  } }, res => res.resume());
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.end(JSON.stringify({ instruction: '查看运营情况' }));
  await Promise.race([arrived, sleep(3000).then(() => { throw new Error('isolated HTTP agent did not enter'); })]);
  req.destroy();
  await sleep(10);
  const httpClosed = new Promise(resolve => server.close(resolve));
  const stopping = server.stopBackground();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await httpClosed;
  assert.equal(signal.aborted, true);
  assert.equal(stopped, false);
  assert.equal(settled, false);
  held.release();
  await stopping;
  assert.equal(settled, true);
  closeDb();
  await sleep(20);
});

test('Pi 已中止或加载期间中止时不启动模型，正常结束移除中止监听', async t => {
  const { Agent } = await import('@earendil-works/pi-agent-core');
  let prompts = 0, aborts = 0;
  t.mock.method(Agent.prototype, 'prompt', async () => { prompts++; });
  t.mock.method(Agent.prototype, 'abort', () => { aborts++; });
  const args = { config: { provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: '', maxOutputTokens: 6000, maxTurns: 2 }, context: {}, saveCandidate: () => ({ ok: true }) };
  const prior = new AbortController();
  prior.abort();
  assert.deepEqual(await pi.run({ ...args, signal: prior.signal }), []);
  const loading = new AbortController();
  const pending = pi.run({ ...args, signal: loading.signal });
  loading.abort();
  assert.deepEqual(await pending, []);
  assert.equal(prompts, 0);
  const finished = new AbortController();
  await pi.run({ ...args, signal: finished.signal });
  assert.equal(prompts, 1);
  finished.abort();
  assert.equal(aborts, 0);
});

for (const [name, change, firstTool] of [
  ['管理员停用', (db, admin) => db.prepare('UPDATE users SET status=0 WHERE id=?').run(admin.id), 'send_platform_notification'],
  ['管理员降级', (db, admin) => db.prepare("UPDATE users SET role='supervisee' WHERE id=?").run(admin.id), 'save_operations_report'],
  ['原会话撤销', (db, admin, session) => require('../src/repo/session.repo').remove(db, session), 'read_platform_records'],
  ['原会话过期', (db, admin) => db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(Date.now() - 1, admin.id), 'read_project_file'],
]) test('运营模型等待期间' + name + '后，迟到工具拒绝并中止模型', async t => {
  const { db, services, releases, sub } = fixture(t);
  const admin = users.insert(db, { username: 'revoked-admin', role: 'admin', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const platform = require('../src/platform-agent/service').create(db);
  services.push(platform);
  const priorPassword = process.env.ADMIN_AGENT_SECONDARY_PASSWORD;
  process.env.ADMIN_AGENT_SECONDARY_PASSWORD = 'isolated-revocation-password';
  t.after(() => { if (priorPassword === undefined) delete process.env.ADMIN_AGENT_SECONDARY_PASSWORD; else process.env.ADMIN_AGENT_SECONDARY_PASSWORD = priorPassword; });
  const session = require('../src/security').createSession(db, admin.id);
  const grant = platform.reauth(admin, 'isolated-revocation-password', session).reauthToken;
  const held = gate();
  releases.push(held.release);
  let entered, model;
  const arrived = new Promise(resolve => { entered = resolve; });
  pi.run = async args => { model = args; entered(); await held.promise; };
  const run = platform.run(admin, { instruction: '查看运营情况', allowNotifications: true }, session, grant);
  const runOutcome = run.then(value => ({ value }), error => ({ error }));
  await arrived;
  change(db, admin, session);
  const params = {
    get_platform_operations_overview: {}, find_platform_users: { query: '' }, get_user_operations_profile: { userId: sub.id },
    read_platform_records: { kind: 'lifeLogs', userId: sub.id }, read_project_tree: {},
    read_project_file: { path: 'src/app.js' }, read_database_schema: {},
    save_operations_report: { title: '测试', summary: '测试摘要', sections: [], chartSpecs: [] },
    send_platform_notification: { userId: sub.id, title: '测试通知', content: '测试正文' },
  };
  const tools = [...model.tools].sort((a, b) => Number(b.name === firstTool) - Number(a.name === firstTool));
  for (const tool of tools) await assert.rejects(tool.execute('isolated-revoked-call', params[tool.name]), error => error.statusCode === 403);
  assert.equal(model.signal.aborted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM platform_agent_reports').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE method LIKE 'PLATFORM_PI_%'").get().n, 0);
  held.release();
  assert.equal((await runOutcome).error.statusCode, 403);
});

test('二级批准只限制任务启动时间，长任务仍按实时角色和原会话执行', async t => {
  const { db, services, releases, sub } = fixture(t);
  const admin = users.insert(db, { username: 'long-run-admin', role: 'admin', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const platform = require('../src/platform-agent/service').create(db);
  services.push(platform);
  const priorPassword = process.env.ADMIN_AGENT_SECONDARY_PASSWORD;
  process.env.ADMIN_AGENT_SECONDARY_PASSWORD = 'isolated-long-run-password';
  t.after(() => { if (priorPassword === undefined) delete process.env.ADMIN_AGENT_SECONDARY_PASSWORD; else process.env.ADMIN_AGENT_SECONDARY_PASSWORD = priorPassword; });
  const session = require('../src/security').createSession(db, admin.id);
  const grant = platform.reauth(admin, 'isolated-long-run-password', session).reauthToken;
  const held = gate();
  releases.push(held.release);
  let entered, model;
  const arrived = new Promise(resolve => { entered = resolve; });
  pi.run = async args => { model = args; entered(); await held.promise; };
  const run = platform.run(admin, { instruction: '查看运营情况', allowNotifications: true }, session, grant);
  await arrived;
  const later = Date.now() + 6 * 60 * 1000;
  t.mock.method(Date, 'now', () => later);
  const sent = await model.tools.find(tool => tool.name === 'send_platform_notification').execute('isolated-long-run', { userId: sub.id, title: '测试通知', content: '测试正文' });
  assert.equal(sent.details.ok, true);
  held.release();
  assert.equal((await run).sent.length, 1);
  assert.equal(model.signal.aborted, false);
});
