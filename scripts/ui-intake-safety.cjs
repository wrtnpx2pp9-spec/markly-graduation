'use strict';
// Real mobile form saves, isolated SQLite/iLink state, and deliberately delayed HTTP responses.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-intake-safety-'));
process.env.DB_PATH = path.join(temp, 'app.db');
process.env.ILINK_STATE_DIR = path.join(temp, 'ilink');
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.MAINTENANCE_MODE = '0';
const database = require('../src/db');
const db = database.getDb();
const security = require('../src/security');
const users = require('../src/repo/user.repo');
const password = 'Test-only-2468';
const accounts = ['supervisee', 'supervisor'].map(role => {
  const salt = security.genSalt();
  return users.insert(db, {
    username: 'intake-' + role, role, displayName: '资料测试-' + role,
    passwordHash: security.hashPassword(password, salt), salt, createdAt: Date.now(),
  });
});
users.insert(db, {
  username: 'intake-admin', role: 'admin', displayName: '资料测试管理员',
  passwordHash: 'test-only-unused-hash', salt: 'test-only-unused-salt', createdAt: Date.now(),
});
const { launchBrowser } = require('./ui-browser.cjs');
const server = require('../server').start();
const output = path.join(process.env.MARKLY_TEST_OUTPUT_DIR || path.join(__dirname, '..', 'output'), 'intake-safety-ui');
fs.mkdirSync(output, { recursive: true });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

(async () => {
  let browser;
  const pages = [];
  const releases = [];
  const errors = [];
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await launchBrowser();

    for (const account of accounts) {
      const supervisor = account.role === 'supervisor';
      const method = supervisor ? 'POST' : 'PUT';
      const routePath = supervisor ? '/api/certifications' : '/api/assessment/me';
      const entry = supervisor ? '#my-cert' : '#my-assessment';
      const editedField = supervisor ? '#cert-strengths' : '#assessment-current';
      const draftKey = 'markly:intake:' + account.id + ':' + account.role;
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
      });
      const page = await context.newPage();
      pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
      await page.goto(base);
      await page.locator('#li-user').fill(account.username);
      await page.locator('#li-pass').fill(password);
      await page.locator('#li-btn').tap();
      await page.locator('[data-view="my"]').tap();

      async function open() {
        await page.locator(entry).tap();
        await page.locator(editedField).waitFor();
      }
      async function fill(value) {
        if (supervisor) {
          await page.locator('#cert-title').fill('英语指导');
          await page.locator('#cert-skills').fill('英语口语');
          await page.locator('#cert-evidence').fill('隔离测试作品说明');
          await page.locator('#cert-availability').fill('周末下午');
          await page.locator('#cert-weekly-minutes').fill('180');
          await page.locator('#cert-service-style').fill('每周交流并反馈');
        } else {
          await page.locator('#assessment-position').fill('准备转行');
          await page.locator('#assessment-minutes').fill('180');
          await page.locator('#assessment-rhythm').fill('每周交流并反馈');
        }
        await page.locator(editedField).fill(value);
      }
      const cache = () => page.evaluate(key => sessionStorage.getItem(key), draftKey);
      const saved = () => supervisor
        ? db.prepare('SELECT application_json FROM certifications WHERE user_id=? ORDER BY created_at DESC,id DESC').all(account.id).map(row => JSON.parse(row.application_json).strengths)
        : [db.prepare('SELECT current_situation FROM supervisee_assessments WHERE user_id=?').get(account.id)?.current_situation];
      const count = () => supervisor
        ? db.prepare('SELECT COUNT(*) n FROM certifications WHERE user_id=?').get(account.id).n
        : db.prepare('SELECT COUNT(*) n FROM supervisee_assessments WHERE user_id=?').get(account.id).n;

      async function holdSave() {
        const arrived = deferred(), release = deferred();
        releases.push(release);
        let handled = false;
        await page.route('**' + routePath, async route => {
          if (route.request().method() !== method || handled) return route.continue();
          handled = true;
          const response = await route.fetch();
          assert.equal(response.status(), 200, account.role + ' save must commit before the delayed response');
          arrived.resolve();
          await release.promise;
          await route.fulfill({ response });
        });
        return {
          arrived: arrived.promise,
          async finish() {
            const response = page.waitForResponse(result => result.request().method() === method && result.url().endsWith(routePath));
            release.resolve();
            await response;
            await page.waitForFunction(() => inFlightWrites.size === 0);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.unroute('**' + routePath);
          },
        };
      }

      await open();
      await fill('提交时的原内容');
      const initialCount = count();
      const first = await holdSave();
      await page.locator('#intake-submit').tap();
      await first.arrived;
      assert.equal(await page.locator('#intake-submit').isDisabled(), true);
      await page.locator(editedField).fill('保存等待期间继续填写的新内容');
      assert.ok((await cache()).includes('保存等待期间继续填写的新内容'));
      assert.ok(saved().includes('提交时的原内容'));
      await first.finish();
      await page.waitForFunction(() => !document.querySelector('#intake-submit')?.disabled);
      assert.equal(await page.locator(editedField).count(), 1, account.role + ' slow save must retain the edited form');
      assert.equal(await page.locator(editedField).inputValue(), '保存等待期间继续填写的新内容');
      assert.ok((await cache())?.includes('保存等待期间继续填写的新内容'), account.role + ' slow save must retain the newer cache');
      assert.ok(saved().includes('提交时的原内容'));
      assert.ok(!saved().includes('保存等待期间继续填写的新内容'), 'new input is not silently included in the committed request');
      assert.equal(count(), supervisor ? initialCount + 1 : 1, 'slow response cannot replay the write');
      await page.locator('#intake-status').waitFor({ state: 'visible' });
      assert.match(await page.locator('#intake-status').innerText(), /新的填写.*尚未保存|新的填写.*尚未提交/);
      await page.locator('.toast').filter({ hasText: '新的填写' }).waitFor({ state: 'detached' });
      assert.equal(await page.locator('#intake-status').isVisible(), true, 'the saved snapshot/new input distinction remains after the toast closes');
      await page.screenshot({ path: path.join(output, account.role + '-new-input-mobile.png'), fullPage: true, animations: 'disabled' });

      // A deliberate second save succeeds, clears only its snapshot, and returns through the real UI.
      await page.locator('#intake-submit').tap();
      await page.locator(entry).waitFor();
      assert.ok(saved().includes('保存等待期间继续填写的新内容'));
      assert.equal(await cache(), null);

      // Closing and reopening the form produces a different live editor, even for the same account.
      await open();
      await fill('重开场景提交的旧内容');
      const reopened = await holdSave();
      await page.locator('#intake-submit').tap();
      await reopened.arrived;
      await page.locator('#intake-back').tap();
      await open();
      await page.locator(editedField).fill('重新打开后输入的新草稿');
      await reopened.finish();
      assert.equal(await page.locator(editedField).inputValue(), '重新打开后输入的新草稿');
      assert.ok((await cache())?.includes('重新打开后输入的新草稿'), 'a disconnected form cannot remove a reopened form cache');
      assert.ok(saved().includes('重开场景提交的旧内容'));
      assert.ok(!saved().includes('重新打开后输入的新草稿'));

      // A failed save leaves the same editor and local draft available for one explicit retry.
      const beforeFailure = count();
      await page.route('**' + routePath, route => route.request().method() === method
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"测试保存失败"}' })
        : route.continue());
      await page.locator('#intake-submit').tap();
      await page.getByText('测试保存失败', { exact: true }).waitFor();
      assert.equal(await page.locator(editedField).inputValue(), '重新打开后输入的新草稿');
      assert.ok((await cache())?.includes('重新打开后输入的新草稿'));
      assert.equal(count(), beforeFailure);
      await page.unroute('**' + routePath);
      await page.screenshot({ path: path.join(output, account.role + '-retry-mobile.png'), fullPage: true, animations: 'disabled' });
      await page.locator('#intake-submit').tap();
      await page.locator(entry).waitFor();
      assert.ok(saved().includes('重新打开后输入的新草稿'));
      assert.equal(count(), supervisor ? beforeFailure + 1 : 1);
      assert.equal(await cache(), null);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile overflow');
      console.log(account.role + ' intake PASS: committed snapshot, newer input/cache, reopened editor, failure and explicit retry.');
    }
    assert.deepEqual(errors, [], 'browser page errors');
    console.log('INTAKE SAFETY UI PASS: both real mobile forms preserve input across slow saves and reopened editors, normal saves return to My, failures permit explicit retry.');
  } catch (error) {
    for (let index = 0; index < pages.length; index++) {
      console.error((await pages[index].locator('body').innerText()).slice(-6000));
      await pages[index].screenshot({ path: path.join(output, 'failure-' + index + '.png'), fullPage: true });
    }
    throw error;
  } finally {
    releases.forEach(release => release.resolve());
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await server.stopBackground();
    database.closeDb();
    const absolute = path.resolve(temp), expected = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(absolute.startsWith(expected), 'temporary cleanup stays within os.tmpdir');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
