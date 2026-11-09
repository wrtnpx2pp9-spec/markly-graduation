'use strict';
// Two independent browser stores, one account; no real database or external recipients.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-draft-conflict-ui-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.ILINK_STATE_DIR = path.join(tmp, 'ilink');
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
const { getDb, closeDb } = require('../src/db'), db = getDb();
const security = require('../src/security'), users = require('../src/repo/user.repo');
for (const [id, role] of [['sup', 'supervisor'], ['sub', 'supervisee'], ['admin', 'admin']]) {
  const salt = security.genSalt();
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES(?,?,?,?,?,?,1,?)')
    .run(id, id, role, security.hashPassword('Test-only-2468', salt), salt, id, Date.now());
}
require('../src/repo/cooperation.repo').save(db, users.byId(db, 'sup'), 'admin', { state: 'active', capacity: 1, agreementRef: 'draft-conflict-test', note: 'isolated browser fixture', published: false });
users.setRelations(db, 'sub', ['sup']);
const server = require('../server').start(), { launchBrowser } = require('./ui-browser.cjs');
const output = path.join(process.env.MARKLY_TEST_OUTPUT_DIR || path.join(__dirname, '..', 'output'), 'draft-conflict-ui');
fs.mkdirSync(output, { recursive: true });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const pages = [], pending = [];
(async () => {
  let browser;
  try {
    if (!server.listening) await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await launchBrowser();
    const errors = [];
    async function page(id) {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
      await context.addCookies([{ name: 'sd_session', value: security.createSession(db, id), url: base, httpOnly: true, sameSite: 'Strict' }]);
      const p = await context.newPage(); pages.push(p); p.setDefaultTimeout(12000);
      p.on('pageerror', e => errors.push(e.message));
      await p.route('https://cdn.jsdelivr.net/**', r => r.abort());
      await p.goto(base); await p.locator('#content').waitFor();
      return p;
    }
    const sup = await page('sup'), local = await page('sub'), remote = await page('sub');
    const root = await sup.evaluate(async () => (await api('POST', '/api/plan-bundles', { planningMode: 'rolling', assigneeId: 'sub', title: '多设备每日草稿验收', description: '独立测试数据', cycles: [{ title: '草稿冲突阶段', startDate: todayStrL(), endDate: goalShift(todayStrL(), 13), rhythm: '按天协商' }] })).plan);
    const stage = db.prepare('SELECT id FROM plans WHERE parent_id=?').get(root.id);
    await local.evaluate(async id => { await api('POST', `/api/plans/${id}/agreement`, { decision: 'accept' }); await loadSection(); goView('tasks'); }, root.id);
    await remote.evaluate(async () => { await loadSection(); goView('tasks'); });
    const dates = await local.evaluate(() => Array.from({ length: 10 }, (_, i) => goalShift(todayStrL(), i)));
    const route = `**/api/plans/${stage.id}/daily-proposals`;
    const url = `/api/plans/${stage.id}/daily-proposals`;
    const proposal = date => db.prepare('SELECT * FROM daily_plan_proposals WHERE plan_id=? AND day_date=? ORDER BY created_at DESC').get(stage.id, date);
    async function write(date, text, reason = '') {
      return remote.evaluate(async ({ url, date, text, reason }) => {
        const row = (await api('GET', url)).proposals.find(p => p.day_date === date && p.status === 'draft');
        return (await api('POST', url, { date, payload: { rest: false, items: [{ title: text }] }, reason, ...(row ? { draftId: row.id, version: row.version } : {}) })).proposal;
      }, { url, date, text, reason });
    }
    async function open(p, date) {
      await p.keyboard.press('Escape');
      await p.evaluate(id => openDailyPlanner(id, true), stage.id);
      await p.locator(`[data-daily-edit="${date}"]`).click();
      await p.locator('#daily-items').waitFor();
    }
    async function conflict() {
      await local.locator('#modal-ok').click();
      await local.locator('#daily-conflict').waitFor({ state: 'visible' });
      await local.waitForFunction(() => !document.querySelector('#daily-conflict-retry').disabled);
    }
    async function ready() { await local.waitForFunction(() => !document.querySelector('#daily-keep-local').disabled); }
    async function checkMobile(p, name) {
      await p.waitForFunction(() => !document.querySelector('.toast'));
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'page overflows 390px');
      assert.equal(await p.locator('#modal .dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'dialog overflows 390px');
      await p.screenshot({ path: path.join(output, name), animations: 'disabled' });
    }

    // Both devices edit the same actual version. A stale save must not silently replace B.
    await write(dates[0], '共同的第一版');
    await open(local, dates[0]); await open(remote, dates[0]);
    await local.locator('#daily-items').fill('本机保留的复习安排');
    await local.locator('#daily-reason').fill('本机说明');
    await remote.locator('#daily-items').fill('另一设备已保存的阅读安排');
    await remote.locator('#daily-reason').fill('服务器说明');
    await remote.locator('#modal-ok').click(); await remote.locator('#daily-window').waitFor();
    const secondVersion = proposal(dates[0]).version;
    await conflict(); await ready();
    assert.match(await local.locator('#daily-conflict-local').innerText(), /本机保留的复习安排/);
    assert.match(await local.locator('#daily-conflict-server').innerText(), /另一设备已保存的阅读安排/);
    assert.match(await local.locator('#daily-conflict-server').innerText(), /服务器说明/);
    assert.equal(await local.locator('#modal-ok').isDisabled(), true);
    assert.equal(await local.locator('#daily-save-submit').isDisabled(), true);
    assert.equal(proposal(dates[0]).version, secondVersion);
    await checkMobile(local, 'daily-conflict-compare-mobile.png');
    await local.locator('#daily-keep-local').click();
    assert.equal(await local.locator('#daily-items').inputValue(), '本机保留的复习安排');
    assert.equal(proposal(dates[0]).version, secondVersion, 'choosing local is not a server write');
    await local.locator('#modal-ok').click(); await local.locator('#daily-window').waitFor();
    assert.equal(proposal(dates[0]).version, secondVersion + 1);
    assert.match(proposal(dates[0]).payload_json, /本机保留的复习安排/);
    assert.equal(proposal(dates[0]).status, 'draft');

    // Selecting a version is not permission to overwrite a later third-device update.
    await open(local, dates[0]); await local.locator('#daily-items').fill('本机再次修改');
    await write(dates[0], '服务器第三版'); await conflict(); await ready();
    await local.locator('#daily-keep-local').click();
    await write(dates[0], '服务器第四版'); const fourthVersion = proposal(dates[0]).version;
    await conflict(); await ready();
    assert.equal(proposal(dates[0]).version, fourthVersion);
    assert.match(await local.locator('#daily-conflict-server').innerText(), /服务器第四版/);
    await local.locator('#daily-use-server').click();
    assert.equal(await local.locator('#daily-items').inputValue(), '服务器第四版');
    assert.equal(proposal(dates[0]).version, fourthVersion);
    await local.locator('#daily-items').fill('读取服务器后尚未保存的新内容');
    await open(local, dates[0]);
    assert.equal(await local.locator('#daily-items').inputValue(), '读取服务器后尚未保存的新内容');

    // A reopened local cache with an old version still presents both versions.
    await local.keyboard.press('Escape'); await write(dates[0], '关闭期间服务器第五版');
    await open(local, dates[0]); await ready();
    assert.equal(await local.locator('#daily-items').inputValue(), '读取服务器后尚未保存的新内容');
    assert.match(await local.locator('#daily-conflict-server').innerText(), /关闭期间服务器第五版/);
    await local.locator('#daily-use-server').click();

    // Failure to load the latest version must leave the local content intact and retryable.
    await write(dates[1], '读取重试第一版'); await open(local, dates[1]);
    await local.locator('#daily-items').fill('断网时仍须保留的本机内容'); await write(dates[1], '读取重试服务器新版');
    await local.route(route, r => r.request().method() === 'GET' ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"隔离测试：读取暂不可用"}' }) : r.continue());
    await conflict();
    await local.getByText(/隔离测试：读取暂不可用/).first().waitFor();
    assert.equal(await local.locator('#daily-items').inputValue(), '断网时仍须保留的本机内容');
    assert.equal(await local.locator('#modal-ok').isDisabled(), true);
    await local.unroute(route); await local.locator('#daily-conflict-retry').click(); await ready();
    assert.match(await local.locator('#daily-conflict-server').innerText(), /读取重试服务器新版/);
    await local.locator('#daily-use-server').click();

    // A late comparison response cannot touch another date's editor or its local cache.
    await write(dates[2], '延迟读取第一版'); await open(local, dates[2]);
    await local.locator('#daily-items').fill('旧窗口本机版本'); await write(dates[2], '延迟读取服务器新版');
    const arrived = deferred(), release = deferred(); pending.push(release);
    await local.route(route, async r => {
      if (r.request().method() !== 'GET') return r.continue();
      const response = await r.fetch(); arrived.resolve(); await release.promise; await r.fulfill({ response });
    });
    await local.locator('#modal-ok').click(); await arrived.promise;
    await local.keyboard.press('Escape'); await local.unroute(route);
    await open(local, dates[3]); await local.locator('#daily-items').fill('新日期窗口不可被迟到响应覆盖');
    const received = local.waitForResponse(r => r.request().method() === 'GET' && r.url().endsWith(url));
    release.resolve(); await received;
    await local.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await local.locator('#daily-items').inputValue(), '新日期窗口不可被迟到响应覆盖');
    assert.equal(await local.locator('#daily-conflict').isVisible(), false);
    assert.ok(await local.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('daily-editor:') && localStorage.getItem(k).includes('新日期窗口不可被迟到响应覆盖'))));

    // Tabs share storage. An older successful save must not remove a newer tab's typing.
    const shared = await local.context().newPage(); pages.push(shared); shared.setDefaultTimeout(12000);
    shared.on('pageerror', e => errors.push(e.message));
    await shared.route('https://cdn.jsdelivr.net/**', r => r.abort());
    await shared.goto(base); await shared.locator('#content').waitFor();
    await shared.evaluate(async () => { await loadSection(); goView('tasks'); });
    await write(dates[7], '同浏览器标签初稿'); await open(local, dates[7]);
    await local.locator('#daily-items').fill('旧标签正在保存的版本');
    const saved = deferred(), sendSaved = deferred(); pending.push(sendSaved);
    await local.route(route, async r => {
      if (r.request().method() !== 'POST') return r.continue();
      const response = await r.fetch(); saved.resolve(); await sendSaved.promise; await r.fulfill({ response });
    });
    await local.locator('#modal-ok').click(); await saved.promise;
    await open(shared, dates[7]);
    await shared.waitForFunction(() => !document.querySelector('#daily-keep-local').disabled);
    await shared.locator('#daily-keep-local').click();
    await shared.locator('#daily-items').fill('另一标签更晚的输入必须保留');
    const savedResponse = local.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(url));
    sendSaved.resolve(); await savedResponse; await local.locator('#daily-window').waitFor();
    await local.unroute(route);
    assert.equal(await shared.locator('#daily-items').inputValue(), '另一标签更晚的输入必须保留');
    assert.ok(await shared.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('daily-editor:') && localStorage.getItem(k).includes('另一标签更晚的输入必须保留'))));

    // A storage event offers an explicit choice rather than silently replacing either tab.
    await write(dates[8], '双标签共同初稿'); await open(local, dates[8]); await open(shared, dates[8]);
    await shared.locator('#daily-items').fill('另一标签最新输入');
    await local.locator('#daily-local-conflict').waitFor({ state: 'visible' });
    assert.equal(await local.locator('#daily-items').inputValue(), '双标签共同初稿');
    assert.equal(await local.locator('#modal-ok').isDisabled(), true);
    await local.locator('#daily-use-tab').click();
    assert.equal(await local.locator('#daily-items').inputValue(), '另一标签最新输入');
    assert.equal(proposal(dates[8]).version, 1, 'choosing another tab must not write the server');
    await shared.close(); pages.pop();

    // Submitted and withdrawn records cannot be force-saved through conflict recovery.
    for (const [index, action] of [[4, 'submit'], [5, 'withdraw']]) {
      const row = await write(dates[index], `${action}前的草稿`); await open(local, dates[index]);
      await local.locator('#daily-items').fill(`${action}后仍在本机的内容`);
      await remote.evaluate(({ url, row, action }) => api('POST', `${url}/${row.id}/action`, { action, version: row.version }), { url, row, action });
      const before = proposal(dates[index]); await conflict();
      await local.waitForFunction(() => !document.querySelector('#daily-use-server').disabled);
      assert.equal(await local.locator('#daily-keep-local').isDisabled(), true);
      await local.locator('#daily-use-server').click();
      assert.equal(await local.locator('#modal-ok').isDisabled(), true);
      assert.equal(await local.locator('#daily-save-submit').isDisabled(), true);
      assert.equal(proposal(dates[index]).version, before.version);
      assert.equal(proposal(dates[index]).status, action === 'submit' ? 'submitted' : 'withdrawn');
    }

    // Archival is an actual lifecycle transition, not a mocked browser response.
    await write(dates[6], '阶段结束前草稿'); await open(local, dates[6]);
    await local.locator('#daily-items').fill('阶段结束后的本机未保存内容');
    await sup.evaluate(id => api('POST', `/api/plans/${id}/archive`, {}), root.id);
    await conflict(); await local.waitForFunction(() => !document.querySelector('#daily-use-server').disabled);
    assert.equal(await local.locator('#daily-keep-local').isDisabled(), true);
    assert.equal(proposal(dates[6]).status, 'closed');
    assert.match(await local.locator('#daily-conflict-local').innerText(), /阶段结束后的本机未保存内容/);
    await checkMobile(local, 'daily-conflict-closed-mobile.png');
    assert.deepEqual(errors, []);
    console.log('DRAFT CONFLICT UI PASS: two-device real conflict, compare, explicit local save, server selection, repeated conflict, reopened cache, read retry, late-response isolation, same-context tab cache protection, submitted/withdrawn/archived protection; 390px no overflow or browser errors');
  } catch (error) {
    for (let i = 0; i < pages.length; i++) {
      console.error((await pages[i].locator('body').innerText()).slice(-7000));
      await pages[i].screenshot({ path: path.join(output, `failure-${i}.png`), fullPage: true });
    }
    throw error;
  } finally {
    pending.forEach(p => p.resolve());
    if (browser) await browser.close();
    await new Promise(r => server.close(r)); await server.stopBackground(); closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
