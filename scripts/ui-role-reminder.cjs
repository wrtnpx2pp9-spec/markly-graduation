'use strict';
// Real sessions and notification APIs; all identities and messages come from
// an isolated database. The desktop API is captured instead of notifying the OS.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-role-reminder-ui-'));
process.env.DB_PATH = path.join(temp, 'app.db'); process.env.ILINK_STATE_DIR = path.join(temp, 'ilink');
process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
const database = require('../src/db'), db = database.getDb(), users = require('../src/repo/user.repo');
const notes = require('../src/repo/note.repo'), security = require('../src/security');
for (const [id, role, identity, name] of [['mentor', 'supervisor', 'mentor', '林导师'], ['mentee', 'supervisee', 'mentee', '小学员'], ['admin', 'admin', '', '管理员']]) {
  const salt = security.genSalt();
  db.prepare('INSERT INTO users(id,username,role,identity,display_name,password_hash,salt,status,created_at) VALUES(?,?,?,?,?,?,?,1,?)')
    .run(id, id, role, identity, name, security.hashPassword('Test-only-2468', salt), salt, Date.now());
}
require('../src/repo/cooperation.repo').save(db, users.byId(db, 'mentor'), 'admin', { state: 'active', capacity: 1, agreementRef: 'isolated-ui', note: '隔离测试授权', published: false });
users.setRelations(db, 'mentee', ['mentor']);
const { launchBrowser } = require('./ui-browser.cjs'), server = require('../server').start();
const output = path.join(process.env.MARKLY_TEST_OUTPUT_DIR || path.join(__dirname, '..', 'output'), 'role-reminder-ui');
fs.mkdirSync(output, { recursive: true });
const errors = [], pages = [];
async function signIn(page, account) {
  await page.locator('#li-user').fill(account); await page.locator('#li-pass').fill('Test-only-2468');
  await page.locator('#li-btn').click(); await page.locator('#content').waitFor();
  await page.waitForFunction(() => !_pollInFlight);
}
async function nav(page, view) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(view === 'notes' ? '#top-notes' : `[data-view="${view}"]`).click();
}
async function poll(page) {
  await page.bringToFront(); await page.waitForFunction(() => !_pollInFlight);
  await page.evaluate(() => pollNotifications());
}
const addNote = (title, createdAt, isRead = false) => {
  const id = notes.insert(db, { userId: 'mentee', kind: 'plan_update', title, content: '本轮隔离消息', createdAt });
  if (isRead) notes.markOneRead(db, id, 'mentee');
  return id;
};
(async () => {
  let browser;
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await launchBrowser();
    async function open(account, width = 390) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      await context.addInitScript(() => {
        window.capturedNotices = [];
        function CapturedNotification(title, options) { window.capturedNotices.push({ title, ...options }); }
        CapturedNotification.permission = 'granted'; CapturedNotification.requestPermission = async () => 'granted';
        window.Notification = CapturedNotification;
      });
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
      await page.goto(base); await signIn(page, account); return page;
    }
    const mentee = await open('mentee');
    assert.deepEqual((await mentee.locator('.hh-role').allTextContents()).sort(), ['Mentee', 'Mentor']);
    await mentee.reload(); await mentee.locator('.hh-role').first().waitFor();
    assert.deepEqual((await mentee.locator('.hh-role').allTextContents()).sort(), ['Mentee', 'Mentor']);
    await nav(mentee, 'my'); await mentee.locator('#my-settings').click();
    assert.equal(await mentee.locator('.card .roletag').first().innerText(), 'Mentee');
    await mentee.reload(); await mentee.locator('#settings-back').waitFor();
    assert.equal(await mentee.locator('.card .roletag').first().innerText(), 'Mentee');
    const mentor = await open('mentor');
    await nav(mentor, 'my'); await mentor.locator('#my-settings').click();
    assert.equal(await mentor.locator('.card .roletag').first().innerText(), 'Mentor');
    const admin = await open('admin', 1100);
    await admin.locator('.usr-row').first().waitFor();
    assert.equal(await admin.locator('.usr-row').filter({ hasText: '@mentor' }).locator('.roletag').innerText(), 'Mentor');
    assert.equal(await admin.locator('.usr-row').filter({ hasText: '@mentee' }).locator('.roletag').innerText(), 'Mentee');
    const at = Date.now(); addNote('首条新消息', at); await poll(mentee);
    addNote('同毫秒另一条消息', at); await poll(mentee); await poll(mentee);
    addNote('其他设备已读消息', at + 1, true); await poll(mentee);
    assert.deepEqual(await mentee.evaluate(() => capturedNotices.map(row => row.title)), ['首条新消息', '同毫秒另一条消息']);
    await nav(mentee, 'notes'); await mentee.locator('[data-notification]').first().waitFor();
    assert.match(await mentee.locator('.notes-feed').innerText(), /首条新消息/);
    await mentee.locator('#notif-read').click();
    await mentee.waitForFunction(() => unread === 0);
    assert.equal(notes.unreadCount(db, 'mentee'), 0);
    await mentee.waitForFunction(() => !document.querySelector('.toast'));
    await mentee.screenshot({ path: path.join(output, 'notifications-mobile.png'), fullPage: true, animations: 'disabled' });
    await nav(mentee, 'my'); await mentee.locator('#my-logout').click();
    await mentee.locator('#modal-ok').click(); await mentee.locator('#li-user').waitFor();
    await signIn(mentee, 'mentee');
    assert.deepEqual(await mentee.evaluate(() => capturedNotices.map(row => row.title)), ['首条新消息', '同毫秒另一条消息']);
    await nav(mentee, 'dashboard');
    assert.deepEqual((await mentee.locator('.hh-role').allTextContents()).sort(), ['Mentee', 'Mentor']);
    await mentee.screenshot({ path: path.join(output, 'identities-after-login-mobile.png'), fullPage: true, animations: 'disabled' });
    addNote('重新登录后的新消息', at + 2); await poll(mentee);
    assert.equal((await mentee.evaluate(() => capturedNotices.map(row => row.title))).at(-1), '重新登录后的新消息');
    assert.deepEqual(errors, []);
    console.log('UI PASS: persistent Mentor/Mentee from real APIs; reload, reminder settings, recent users, logout/login; first and same-millisecond notices, read elsewhere, deduplication and mark-all-read');
  } catch (error) {
    for (const [index, page] of pages.entries()) await page.screenshot({ path: path.join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve)); await server.stopBackground();
    database.closeDb(); fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
