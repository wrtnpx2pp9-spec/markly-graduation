'use strict';
// All fixtures, notification state and server traffic are local to this run.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-worklist-ui-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.ILINK_STATE_DIR = path.join(tmp, 'ilink');
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
const { getDb, closeDb } = require('../src/db'), db = getDb();
const security = require('../src/security'), users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo'), tasks = require('../src/repo/task.repo');
for (const [id, role, displayName] of [['sup', 'supervisor', '林老师'], ['sub', 'supervisee', '小李'], ['admin', 'admin', '管理员']]) {
  const salt = security.genSalt();
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES(?,?,?,?,?,?,1,?)')
    .run(id, id, role, security.hashPassword('Test-only-2468', salt), salt, displayName, Date.now());
}
require('../src/repo/cooperation.repo').save(db, users.byId(db, 'sup'), 'admin', { state: 'active', capacity: 1, agreementRef: 'worklist-test', note: 'isolated browser fixture', published: false });
users.setRelations(db, 'sub', ['sup']);
function at(offset) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return +d; }
function date(offset) { const d = new Date(at(offset)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const common = { creatorId: 'sup', assigneeId: 'sub', description: '包含跨日待处理事项的验收目标', planningMode: 'rolling', status: 'active', startAt: at(-10), dueAt: at(10), createdAt: Date.now() };
const root = plans.insert(db, { ...common, title: '持续学习目标', kind: 'phase' });
const stage = plans.insert(db, { ...common, title: '近期学习阶段', kind: 'cycle', parentId: root.id });
let seq = 0;
function day(id, offset, content, state = 'unsubmitted', help = '') {
  plans.insertDays(db, stage.id, [{ id, seq: ++seq, day_date: date(offset), content, items: [content], createdAt: at(-20) }]);
  db.prepare('UPDATE plan_days SET checkin_state=?,status=?,note=?,help_note=?,checkin_submitted_at=? WHERE id=?')
    .run(state, state === 'approved' ? 'done' : 'pending', state === 'submitted' ? '昨天提交的执行内容' : '', help, state === 'submitted' ? at(-1) : null, id);
}
day('wl-review-day', -1, '昨日已提交的阅读', 'submitted');
day('wl-review-help-day', -2, '已提交且同时需要困难反馈', 'submitted', '已交练习，但还需要方法建议');
day('wl-help-day', -3, '三天前遇到困难的练习', 'unsubmitted', '这一章不理解，需要一点提示');
day('wl-approved-help-day', -6, '已确认执行但仍有困难待回复', 'approved', '已经完成，但想请教下一步方法');
day('wl-todo-day', -2, '前天尚未补交的背诵');
day('wl-today-day', 0, '今天的阅读安排');
day('wl-future-day', 1, '明天的安排不应进入待处理');
day('wl-done-day', -4, '已确认的记录不应进入待处理', 'approved');
day('wl-rest-day', 0, '双方确认休息不应进入待处理', 'cancelled');
function task(title, offset, status = 'pending', createdAt = at(-120)) {
  const row = tasks.insert(db, { title, note: '普通任务说明', creatorId: 'sup', assigneeId: 'sub', planId: null, dueAt: offset == null ? null : at(offset), remindBeforeMinutes: 30, status, createdAt });
  if (status === 'submitted') db.prepare('UPDATE tasks SET checkin_note=? WHERE id=?').run('已完成，等待监督者核对', row.id);
  return row;
}
const overdueTask = task('过期普通任务', -2);
const undatedTask = task('无截止普通任务', null);
const oldSubmission = task('旧提交待审核', -3, 'submitted');
const undatedSubmission = task('无截止提交待审核', null, 'submitted');
const excludedTasks = [task('未来普通任务', 1), task('已完成普通任务', -2, 'done'), task('已取消普通任务', -2, 'cancelled')];
const extraTasks = Array.from({ length: 8 }, (_, i) => task(`待安排的小任务 ${i + 1}`, null, 'pending', at(-10) + i));
const { launchBrowser } = require('./ui-browser.cjs');
const server = require('../server').start();
const output = path.join(process.env.MARKLY_TEST_OUTPUT_DIR || path.join(__dirname, '..', 'output'), 'worklist-ui');
fs.mkdirSync(output, { recursive: true });
const pages = [];
const itemSelector = (kind, id) => `[data-work-item="${kind}:${id}"]`;
const item = (page, kind, id) => page.locator(itemSelector(kind, id));
const group = (page, name) => page.locator(`[data-work-group="${name}"]`);
async function refresh(page) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/me/worklist') && r.request().method() === 'GET');
  await page.locator('#refresh-work').click();
  await response;
  await page.locator('[data-work-group]').first().waitFor();
}
async function groupItem(page, name, kind, id) {
  await group(page, name).locator(itemSelector(kind, id)).waitFor({ state: 'attached' });
}
async function approveDay(page, id) {
  await page.locator(`[data-day-open="${id}"]`).click();
  await page.locator('#detail-review').click();
  await page.locator('#modal-ok').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await item(page, 'day', id).waitFor({ state: 'detached' });
}
(async () => {
  let browser;
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await launchBrowser();
    const errors = [];
    async function page(id) {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
      await context.addCookies([{ name: 'sd_session', value: security.createSession(db, id), url: base, httpOnly: true, sameSite: 'Strict' }]);
      const p = await context.newPage(); pages.push(p);
      p.on('pageerror', e => errors.push(e.message));
      await p.route('https://cdn.jsdelivr.net/**', route => route.abort());
      await p.goto(base); await p.locator('[data-work-group]').first().waitFor();
      return p;
    }
    const sup = await page('sup'), sub = await page('sub');
    // Reviews and difficulties retain their original dates, including submitted undated tasks.
    for (const [kind, id] of [['day', 'wl-review-day'], ['day', 'wl-review-help-day'], ['task', oldSubmission.id], ['task', undatedSubmission.id]]) {
      await groupItem(sup, 'reviews', kind, id);
      await groupItem(sub, 'waiting', kind, id);
    }
    await groupItem(sup, 'help', 'day', 'wl-help-day');
    await groupItem(sub, 'overdue', 'day', 'wl-help-day');
    await groupItem(sup, 'help', 'day', 'wl-approved-help-day');
    await groupItem(sub, 'waiting', 'day', 'wl-approved-help-day');
    for (const p of [sup, sub]) {
      await groupItem(p, 'overdue', 'day', 'wl-todo-day');
      await groupItem(p, 'overdue', 'task', overdueTask.id);
      await groupItem(p, 'today', 'day', 'wl-today-day');
      await groupItem(p, 'undated', 'task', undatedTask.id);
      for (const id of ['wl-future-day', 'wl-done-day', 'wl-rest-day']) assert.equal(await item(p, 'day', id).count(), 0, `${id} is excluded`);
      for (const row of excludedTasks) assert.equal(await item(p, 'task', row.id).count(), 0, `${row.title} is excluded`);
      const allIds = await p.locator('[data-work-item]').evaluateAll(nodes => nodes.map(n => n.dataset.workItem));
      assert.equal(new Set(allIds).size, allIds.length, 'one card per item even when execution has unresolved help');
      const more = p.locator('[data-work-more="undated"]');
      await more.waitFor(); assert.equal(await more.getAttribute('open'), null);
      const last = item(p, 'task', extraTasks.at(-1).id);
      assert.equal(await last.isVisible(), false, 'remaining items start collapsed');
      await more.locator('summary').click(); await last.waitFor({ state: 'visible' });
      assert.equal(await group(p, 'undated').locator('[data-work-item]').count(), 9, 'all undated items are retained');
      await more.locator('summary').click();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile has no horizontal overflow');
    }
    for (const [role, p] of [['supervisor', sup], ['supervisee', sub]]) {
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({ path: path.join(output, `${role}-worklist-mobile.png`), animations: 'disabled' });
      await p.screenshot({ path: path.join(output, `${role}-worklist-full.png`), fullPage: true, animations: 'disabled' });
    }

    await approveDay(sup, 'wl-review-day');
    assert.equal(plans.dayById(db, 'wl-review-day').checkin_state, 'approved');
    await refresh(sub); await item(sub, 'day', 'wl-review-day').waitFor({ state: 'detached' });
    await sup.locator(`[data-task-open="${oldSubmission.id}"]`).click();
    await sup.locator('#task-approve').click(); await sup.locator('#modal').waitFor({ state: 'hidden' });
    await item(sup, 'task', oldSubmission.id).waitFor({ state: 'detached' });
    assert.equal(tasks.byId(db, oldSubmission.id).status, 'done');

    // One item with both submission and help moves to help after approval, never disappearing prematurely.
    await group(sup, 'reviews').locator('[data-day-open="wl-review-help-day"]').click();
    await sup.locator('#detail-review').click(); await sup.locator('#modal-ok').click();
    await sup.locator('#modal').waitFor({ state: 'hidden' });
    await groupItem(sup, 'help', 'day', 'wl-review-help-day');
    assert.equal(await item(sup, 'day', 'wl-review-help-day').count(), 1);
    assert.equal(await group(sup, 'reviews').locator(itemSelector('day', 'wl-review-help-day')).count(), 0);
    await refresh(sub); await groupItem(sub, 'waiting', 'day', 'wl-review-help-day');
    await group(sup, 'help').locator('[data-day-open="wl-review-help-day"]').click();
    await sup.locator('#detail-help').click(); await sup.locator('#help-content').fill('执行已经确认，方法可以从例题开始复习。');
    await sup.locator('#modal-ok').click(); await sup.locator('#modal').waitFor({ state: 'hidden' });
    await item(sup, 'day', 'wl-review-help-day').waitFor({ state: 'detached' });
    await refresh(sub); await item(sub, 'day', 'wl-review-help-day').waitFor({ state: 'detached' });

    await group(sup, 'help').locator('[data-day-open="wl-help-day"]').click();
    await sup.locator('#detail-help').click(); await sup.locator('#help-content').fill('先做第一题，下一次再一起核对。');
    await sup.locator('#modal-ok').click(); await sup.locator('#modal').waitFor({ state: 'hidden' });
    await group(sup, 'help').locator(itemSelector('day', 'wl-help-day')).waitFor({ state: 'detached' });
    await groupItem(sup, 'overdue', 'day', 'wl-help-day');
    assert.equal(plans.dayById(db, 'wl-help-day').help_reply, '先做第一题，下一次再一起核对。');
    await group(sup, 'help').locator('[data-day-open="wl-approved-help-day"]').click();
    await sup.locator('#detail-help').click(); await sup.locator('#help-content').fill('下一步尝试把方法讲给别人听。');
    await sup.locator('#modal-ok').click(); await sup.locator('#modal').waitFor({ state: 'hidden' });
    await item(sup, 'day', 'wl-approved-help-day').waitFor({ state: 'detached' });
    await refresh(sub); await item(sub, 'day', 'wl-approved-help-day').waitFor({ state: 'detached' });

    // The executor can finish an earlier day directly from the backlog; approval then removes it for both roles.
    await sub.locator('[data-day-open="wl-todo-day"]').click();
    await sub.locator('[data-detail-item]').first().click();
    await sub.locator('[data-detail-item][aria-checked="true"]').waitFor();
    await sub.locator('#detail-check').click(); await sub.locator('#pd-note').fill('已补交前天的背诵');
    await sub.locator('#modal-ok').click(); await sub.locator('#modal').waitFor({ state: 'hidden' });
    await groupItem(sub, 'waiting', 'day', 'wl-todo-day');
    assert.equal(await group(sub, 'overdue').locator(itemSelector('day', 'wl-todo-day')).count(), 0);
    await refresh(sup); await groupItem(sup, 'reviews', 'day', 'wl-todo-day');
    await approveDay(sup, 'wl-todo-day');
    await refresh(sub); await item(sub, 'day', 'wl-todo-day').waitFor({ state: 'detached' });

    await sub.locator(`[data-task-open="${undatedTask.id}"]`).click(); await sub.locator('#task-submit').click();
    await sub.locator('#task-note').fill('无截止任务也已经完成'); await sub.locator('#modal-ok').click();
    await sub.locator('#modal').waitFor({ state: 'hidden' }); await groupItem(sub, 'waiting', 'task', undatedTask.id);
    await refresh(sup); await groupItem(sup, 'reviews', 'task', undatedTask.id);
    await sup.locator(`[data-task-open="${undatedTask.id}"]`).click(); await sup.locator('#task-approve').click();
    await sup.locator('#modal').waitFor({ state: 'hidden' }); await item(sup, 'task', undatedTask.id).waitFor({ state: 'detached' });
    await refresh(sub); await item(sub, 'task', undatedTask.id).waitFor({ state: 'detached' });
    assert.equal(tasks.byId(db, undatedTask.id).status, 'done');
    assert.deepEqual(errors, [], 'browser page errors');
    console.log('WORKLIST UI PASS: cross-day reviews/help, overdue and undated tasks, future/done/rest exclusion, expand all items, executor submission and supervisor review/reply update both mobile homepages; no page errors');
  } catch (error) {
    for (let i = 0; i < pages.length; i++) {
      console.error('FAILED PAGE', (await pages[i].locator('body').innerText()).slice(-7000));
      await pages[i].screenshot({ path: path.join(output, `failure-${i}.png`), fullPage: true });
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await server.stopBackground(); closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
