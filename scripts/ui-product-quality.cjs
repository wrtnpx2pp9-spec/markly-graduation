'use strict';
// Real browser interactions; all accounts, sessions and SQLite files are disposable.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-quality-ui-'));
process.env.DB_PATH = path.join(temporary, 'app.db');
process.env.ILINK_STATE_DIR = path.join(temporary, 'ilink');
process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.MAINTENANCE_MODE = '0';
const { getDb, closeDb } = require('../src/db'), db = getDb();
const users = require('../src/repo/user.repo'), security = require('../src/security');
const salt = security.genSalt();
const admin = users.insert(db, { username: 'quality-admin', role: 'admin', displayName: '测试管理员', passwordHash: security.hashPassword('Quality-test-2468', salt), salt, createdAt: Date.now() });
const { launchBrowser } = require('./ui-browser.cjs');
const server = require('../server').start();
const output = path.join(process.env.MARKLY_TEST_OUTPUT_DIR || path.join(__dirname, '..', 'output'), 'product-quality-ui');
fs.mkdirSync(output, { recursive: true });
(async () => {
  let browser, page;
  const errors = [];
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    let firstStatus = true, releaseStatus;
    const statusGate = new Promise(resolve => { releaseStatus = resolve; });
    await page.route('**/api/status', async route => {
      if (firstStatus) { firstStatus = false; await statusGate; await route.abort(); }
      else await route.continue();
    });
    await page.goto(base);
    await page.locator('[data-startup]').waitFor();
    assert.match(await page.locator('[data-startup]').innerText(), /正在准备/);
    releaseStatus();
    await page.locator('#startup-retry').click();
    await page.locator('#li-user').waitFor();
    assert.equal(await page.locator('#network-status:visible').count(), 0, 'successful startup retry dismisses stale network failure');
    assert.equal(await page.locator('link[href*="cdn.jsdelivr.net"]').count(), 0, 'first paint uses local assets');
    let emptyLoginWrites = 0;
    await page.route('**/api/auth/login', async route => { emptyLoginWrites++; await route.continue(); });
    await page.locator('#li-btn').click();
    assert.equal(emptyLoginWrites, 0, 'empty native form does not issue a login request');
    await page.unroute('**/api/auth/login');
    await page.locator('#li-pass').fill('显示测试密码');
    await page.locator('#login-password-toggle').click();
    assert.equal(await page.locator('#li-pass').getAttribute('type'), 'text');
    assert.equal(await page.locator('#login-password-toggle').getAttribute('aria-pressed'), 'true');
    await page.locator('#login-password-toggle').click();
    assert.equal(await page.locator('#li-pass').getAttribute('type'), 'password');
    assert.equal(await page.locator('#li-pass').inputValue(), '显示测试密码');
    await page.locator('#li-pass').fill('');
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'login fits ' + width);
      if (width === 390 || width === 1280) await page.screenshot({ path: path.join(output, 'login-' + width + '.png'), fullPage: true, animations: 'disabled' });
    }
    for (const [width, height] of [[320, 568], [390, 640], [430, 932]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.scrollTo(0, 0));
      for (const selector of ['#li-user', '#li-pass', '#li-btn']) {
        assert.equal(await page.locator(selector).evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.height >= 44 && r.top >= 0 && r.bottom <= innerHeight
            && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }), true, 'mobile login control is reachable on the first screen: ' + width + 'x' + height + ' ' + selector);
      }
      await page.locator('#login-password-toggle').tap();
      assert.equal(await page.locator('#li-pass').getAttribute('type'), 'text', 'password toggle responds to touch');
      await page.locator('#login-password-toggle').tap();
      await page.screenshot({ path: path.join(output, 'login-mobile-' + width + 'x' + height + '.png'), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#li-register').tap();
    await page.locator('.identity-option').last().tap();
    assert.equal(await page.locator('.identity-option input').last().isChecked(), true, 'identity cards respond to touch');
    await page.screenshot({ path: path.join(output, 'registration-mobile-first.png'), animations: 'disabled' });
    const gender = page.locator('.select-menu').filter({ has: page.locator('[name="gender"]') });
    await gender.locator('.select-trigger').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').innerText(), '男', 'disabled placeholder must not trap keyboard focus');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').innerText(), '女', 'arrow keys navigate options');
    await page.keyboard.press('End');
    assert.equal(await page.locator(':focus').innerText(), '暂不透露');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[name="gender"]').inputValue(), 'unspecified');
    assert.equal(await gender.locator('.select-trigger').getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    assert.equal(await page.locator(':focus').innerText(), '男');
    await page.keyboard.press('Tab');
    assert.equal(await gender.locator('.select-trigger').getAttribute('aria-expanded'), 'false', 'Tab dismisses the list');
    assert.equal(await page.locator(':focus').getAttribute('name'), 'contact', 'Tab moves to next form field');
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'registration fits ' + width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#registration-back').click();
    await page.locator('#li-user').fill('quality-admin');
    await page.locator('#li-pass').fill('wrong-password');
    await page.locator('#li-pass').press('Enter');
    await page.waitForFunction(() => !!document.querySelector('#li-err')?.textContent);
    assert.equal(await page.locator('#li-user').inputValue(), 'quality-admin');
    assert.equal(await page.locator('#li-btn').isEnabled(), true);
    assert.equal(await page.locator('#li-err').getAttribute('role'), 'alert', 'login error is announced');
    let loginWrites = 0, releaseLogin;
    const loginGate = new Promise(resolve => { releaseLogin = resolve; });
    await page.route('**/api/auth/login', async route => { loginWrites++; await loginGate; await route.continue(); });
    await page.locator('#li-pass').fill('Quality-test-2468');
    await page.locator('#li-pass').press('Enter');
    await page.waitForFunction(() => document.querySelector('#li-btn')?.disabled);
    await page.locator('#li-pass').press('Enter');
    assert.equal(await page.locator('#li-btn').innerText(), '正在登录…');
    releaseLogin();
    await page.locator('#overview-refresh').waitFor();
    assert.equal(loginWrites, 1, 'repeated Enter issues only one login');
    await page.unroute('**/api/auth/login');
    await page.locator('[data-view="users"]').click();
    await page.locator('#adm-new').click();
    await page.locator('.identity-option:has(input[value="supervisor"])').click();
    const level = page.locator('.select-menu').filter({ has: page.locator('#um-level') });
    await level.locator('.select-trigger').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.dialog').count(), 1, 'Escape closes dropdown before its parent dialog');
    assert.equal(await level.locator('.select-trigger').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#um-level').inputValue(), 'basic', 'Escape does not commit highlighted choice');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    assert.equal(await page.locator(':focus').evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true, 'last option can be reached without being covered by dialog actions');
    await page.screenshot({ path: path.join(output, 'keyboard-select-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.locator('#um-display').fill('保留输入');
    await page.locator('#modal-cancel').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'modal-ok');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.dialog').evaluate(el => el.contains(document.activeElement)), true, 'focus remains in dialog');
    await page.screenshot({ path: path.join(output, 'keyboard-modal-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'adm-new');
    // Inspect the synchronous close result before the leaving image's timer can
    // finish. The image must never keep the live dialog's IDs or trap focus.
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion });
      await page.locator('#adm-new').click();
      await page.locator('#um-display').waitFor();
      await page.evaluate(() => {
        const liveDialog = document.querySelector('#modal .dialog');
        document.addEventListener('keydown', function captureClose(event) {
          if (event.key !== 'Escape') return;
          document.removeEventListener('keydown', captureClose);
          const leaving = [...document.querySelectorAll('.overlay.is-leaving')];
          window.modalCloseEvidence = {
            liveDialogs: document.querySelectorAll('#modal .dialog').length,
            originalConnected: liveDialog.isConnected,
            backgroundInert: document.querySelector('#app').inert,
            focus: document.activeElement.id,
            leaving: leaving.map(el => ({
              inert: el.inert, hidden: el.getAttribute('aria-hidden'),
              ids: [el, ...el.querySelectorAll('[id]')].filter(node => node.id).map(node => node.id),
              blocksPointer: getComputedStyle(el).pointerEvents !== 'none',
              liveDialogRoles: el.querySelectorAll('[role="dialog"], [aria-modal="true"]').length
            }))
          };
        });
      });
      await page.keyboard.press('Escape');
      const closed = await page.evaluate(() => window.modalCloseEvidence);
      assert.equal(closed.liveDialogs, 0, 'closing removes the live dialog synchronously');
      assert.equal(closed.originalConnected, false, 'the original editor disconnects so late responses cannot treat it as current');
      assert.equal(closed.backgroundInert, false, 'closing releases the background synchronously');
      assert.equal(closed.focus, 'adm-new', 'closing restores focus synchronously');
      assert.equal(closed.leaving.length, reducedMotion === 'reduce' ? 0 : 1);
      for (const image of closed.leaving) {
        assert.equal(image.inert, true); assert.equal(image.hidden, 'true');
        assert.deepEqual(image.ids, []); assert.equal(image.blocksPointer, false);
        assert.equal(image.liveDialogRoles, 0, 'leaving image is excluded from dialog semantics');
      }
      await page.locator('#adm-new').click();
      await page.locator('#um-display').waitFor();
      assert.equal(await page.locator('#modal .dialog').count(), 1, 'a new dialog can open immediately');
      assert.equal(await page.locator('.overlay.is-leaving').count(), 0, 'opening clears any leaving image');
      assert.equal(await page.locator('#um-display').isEditable(), true);
      await page.keyboard.press('Escape');
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // A native file input cannot be assigned its non-empty value when making
    // an exit image. Use an in-memory attachment to exercise browser security.
    await page.locator('#adm-new').focus();
    await page.evaluate(() => openModal('附件测试', '<input type="file" id="quality-attachment">', () => {}));
    await page.locator('#quality-attachment').setInputFiles({ name: 'isolated-test.txt', mimeType: 'text/plain', buffer: Buffer.from('disposable attachment') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modal .dialog').count(), 0, 'a selected native file does not prevent closing');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'adm-new');
    // Revoke the actual isolated session; the next UI read must explain the return to login.
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(admin.id);
    await page.locator('[data-view="overview"]').click();
    await page.locator('#li-user').waitFor();
    assert.match(await page.locator('#li-err').innerText(), /登录已失效.*重新登录/);
    assert.equal(await page.locator('#modal .dialog').count(), 0);
    assert.equal(await page.locator('[role="dialog"]').count(), 0, 'session expiry leaves no live dialog semantics');
    await page.screenshot({ path: path.join(output, 'session-expired-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.locator('#li-user').fill('quality-admin');
    await page.locator('#li-pass').fill('Quality-test-2468');
    await page.locator('#li-btn').click();
    await page.locator('#content').waitFor();
    assert.deepEqual(errors, [], 'no unhandled browser errors');
    console.log('UI PASS: startup loading/failure/retry, local first-paint assets, native login validation/password toggle, touch login controls visible without scrolling at 320x568/390x640/430x932 and identity selection by touch; keyboard select navigation/disabled placeholder/Home/End/Tab/Escape, modal focus and synchronous close/reopen with inert ID-free leaving image and reduced motion, 320/390/768/1280px login and registration, login failure/retry/deduplication, real session revocation and re-login');
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }); }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    await server.stopBackground(); closeDb();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
