'use strict';
// Fixtures establish an accepted one-day fixed stage. Every lifecycle transition
// below uses visible browser controls; no production database or channel is used.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-stage-review-ui-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.ILINK_STATE_DIR = path.join(tmp, 'ilink');
process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
const { getDb, closeDb } = require('../src/db'), db = getDb();
const security = require('../src/security'), users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
for (const [id, role] of [['sup', 'supervisor'], ['sub', 'supervisee'], ['admin', 'admin']]) {
  const salt = security.genSalt();
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES(?,?,?,?,?,?,1,?)')
    .run(id, id, role, security.hashPassword('Test-only-2468', salt), salt, role === 'supervisor' ? '林老师' : '小李', Date.now());
}
require('../src/repo/cooperation.repo').save(db, users.byId(db, 'sup'), 'admin', { state: 'active', capacity: 1, agreementRef: 'stage-review-fixture', note: 'isolated browser fixture', published: false });
users.setRelations(db, 'sub', ['sup']);
const today = new Date(), start = new Date(today), end = new Date(today);
start.setHours(0, 0, 0, 0); end.setHours(23, 59, 59, 999);
const dayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const common = { creatorId: 'sup', assigneeId: 'sub', description: '每日十分钟，结束后共同回顾', planningMode: 'fixed', status: 'active', startAt: +start, dueAt: +end, createdAt: Date.now() };
const root = plans.insert(db, { ...common, title: '阅读习惯', kind: 'phase' });
const stage = plans.insert(db, { ...common, title: '体验与复盘', kind: 'cycle', parentId: root.id });
const dayId = 'stage-review-day';
plans.insertDays(db, stage.id, [{ id: dayId, seq: 1, day_date: dayDate, content: '阅读十分钟并记一句收获', items: ['阅读十分钟', '记一句收获'], createdAt: Date.now() }]);
const { launchBrowser } = require('./ui-browser.cjs');
const server = require('../server').start();
const output = path.join(process.env.MARKLY_TEST_OUTPUT_DIR || path.join(__dirname, '..', 'output'), 'stage-review-ui');
fs.mkdirSync(output, { recursive: true });
const pages = [], errors = [];
const dayState = () => db.prepare('SELECT * FROM plan_days WHERE id=?').get(dayId);
const reviewState = () => db.prepare('SELECT * FROM phase_stage_reviews WHERE cycle_plan_id=?').get(stage.id);
async function nav(page, view) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(`[data-view="${view}"]`).click();
}
async function tasks(page) { await nav(page, 'tasks'); await page.locator(`[data-phase="${root.id}"]`).waitFor(); }
async function reload(page) { await page.reload(); await page.locator('#content').waitFor(); }
async function closeAfterSave(page) { await page.locator('#modal-ok').click(); await page.locator('#modal').waitFor({ state: 'hidden' }); }
async function openDay(page) { await nav(page, 'dashboard'); await page.locator(`[data-day-open="${dayId}"]`).click(); }

(async () => {
  let browser;
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await launchBrowser();
    async function login(role, width) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
      await page.goto(base); await page.locator('#li-user').fill(role); await page.locator('#li-pass').fill('Test-only-2468');
      await page.locator('#li-btn').click(); await page.locator('#content').waitFor();
      return page;
    }
    const sub = await login('sub', 390), sup = await login('sup', 1100);
    await tasks(sub);
    assert.equal(await sub.locator('[data-stage-self]').count(), 0, 'an unfinished active fixed stage cannot be reviewed');
    await openDay(sub);
    await sub.locator('#detail-check').click(); await sub.locator('#pd-note').fill('尚未逐项确认');
    await sub.locator('#modal-ok').click(); await sub.getByText('还有 2 项当天任务未完成', { exact: true }).waitFor();
    assert.equal(dayState().checkin_state, 'unsubmitted', 'unchecked tasks block submission');
    await sub.locator('#modal-cancel').click(); await openDay(sub);
    for (let i = 0; i < 2; i++) {
      await sub.locator('[data-detail-item]').nth(i).click();
      await sub.locator('[data-detail-item][aria-checked="true"]').nth(i).waitFor();
    }
    await sub.locator('#detail-check').click(); await sub.locator('#pd-note').fill('读完了'); await closeAfterSave(sub);
    assert.equal(dayState().checkin_state, 'submitted');
    await openDay(sup); await sup.locator('#detail-review').click();
    await sup.getByRole('button', { name: '驳回', exact: true }).click();
    await sup.getByText('驳回时请填写原因', { exact: true }).waitFor();
    assert.equal(dayState().checkin_state, 'submitted', 'empty rejection does not change submitted work');
    await sup.locator('#day-review-note').fill('请补充读了哪一章和一句收获');
    await sup.getByRole('button', { name: '驳回', exact: true }).click(); await sup.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(dayState().checkin_state, 'rejected');
    await reload(sub); await openDay(sub);
    await sub.getByText('请补充读了哪一章和一句收获', { exact: false }).waitFor();
    await sub.screenshot({ path: path.join(output, 'return-for-detail-mobile.png'), fullPage: true, animations: 'disabled' });
    await sub.locator('#detail-check').click(); await sub.locator('#pd-note').fill('读完第一章；收获是把任务分成容易开始的一小步'); await closeAfterSave(sub);
    await reload(sup); await openDay(sup); await sup.locator('#detail-review').click(); await closeAfterSave(sup);
    assert.equal(dayState().checkin_state, 'approved');

    await reload(sub); await tasks(sub); await sub.locator(`[data-stage-self="${stage.id}"]`).click();
    await sub.locator('#stage-self-summary').fill('小步开始后，比想象中更容易坚持');
    await sub.locator('#stage-self-difficulty').fill('晚上容易拖延'); await sub.locator('#stage-helpful').fill('一次温和提醒');
    await closeAfterSave(sub);
    assert.ok(reviewState().self_submitted_at);
    await reload(sup); await tasks(sup);
    assert.equal((await sup.locator('#content').innerText()).includes('小步开始后，比想象中更容易坚持'), false, 'self review is private until both submit');
    const beforeBoth = await sup.request.get(`${base}/api/plans?limit=500`);
    assert.equal((await beforeBoth.text()).includes('小步开始后，比想象中更容易坚持'), false, 'private self review does not reach the other browser');
    await sup.locator(`[data-stage-supervisor="${stage.id}"]`).click();
    await sup.locator('#stage-observation').fill('能够主动补充具体收获并及时沟通');
    await sup.locator('#stage-progress').fill('开始行动更快'); await sup.locator('#stage-suggestion').fill('下一阶段仍保持十分钟');
    await closeAfterSave(sup);
    await sup.locator(`[data-stage-confirm="${stage.id}"]`).click();
    await sup.locator('#modal .growth-record blockquote').filter({hasText:'小步开始后，比想象中更容易坚持'}).waitFor();
    await closeAfterSave(sup);
    assert.equal(reviewState().locked_at, null, 'one confirmation cannot lock the joint record');
    await reload(sub); await tasks(sub); await sub.locator(`[data-stage-confirm="${stage.id}"]`).click();
    await sub.locator('#modal .growth-record blockquote').filter({hasText:'能够主动补充具体收获并及时沟通'}).waitFor();
    await closeAfterSave(sub);
    const locked = reviewState(); assert.ok(locked.locked_at);
    assert.deepEqual(JSON.parse(locked.execution_snapshot), { total: 1, done: 1, percent: 100 });
    await sub.locator(`[data-stage-card="${stage.id}"]`).click();
    await sub.getByText('共同见证卡', { exact: true }).waitFor();
    assert.match(await sub.locator('.growth-record').innerText(), /确认时统计：1\/1 天（100%）/);
    assert.equal(await sub.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'joint record fits phone');
    await sub.screenshot({ path: path.join(output, 'joint-record-mobile.png'), fullPage: true, animations: 'disabled' });
    await closeAfterSave(sub);

    await reload(sup); await tasks(sup);
    sup.once('dialog', dialog => dialog.accept());
    await sup.locator(`[data-action="archivePlan"][data-id="${root.id}"]`).click();
    await sup.locator(`[data-phase="${root.id}"] .pc-chip.off`).waitFor();
    assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(stage.id).status, 'archived');
    assert.deepEqual(reviewState(), locked, 'archiving preserves signed text, dates and execution snapshot');
    await reload(sub); await nav(sub, 'my'); await sub.locator('#my-history').click();
    await sub.locator(`[data-history-plan="${root.id}"]`).click();
    await sub.getByText('阶段复盘与评价', { exact: true }).waitFor();
    const historyText = await sub.locator('.history-records').innerText();
    assert.match(historyText, /小步开始后，比想象中更容易坚持/);
    assert.match(historyText, /能够主动补充具体收获并及时沟通/);
    assert.match(historyText, /确认时统计：1\/1 天（100%）/);
    assert.equal(await sub.locator('#modal [data-stage-self],#modal [data-stage-supervisor],#modal [data-stage-confirm]').count(), 0);
    await sub.screenshot({ path: path.join(output, 'archived-review-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('STAGE REVIEW UI PASS: incomplete submission blocked → rejection requires reason → supplement/resubmit → approval → private self review → both reviews visible → two confirmations → immutable joint snapshot → archive → read-only retained history.');
  } catch (error) {
    for (let i = 0; i < pages.length; i++) {
      console.error(`FAILED PAGE ${i}`, await pages[i].locator('body').innerText());
      await pages[i].screenshot({ path: path.join(output, `failure-${i}.png`), fullPage: true, animations: 'disabled' });
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve)); await server.stopBackground(); closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
