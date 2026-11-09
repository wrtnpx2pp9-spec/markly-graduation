'use strict';
// Real HTTP + online consistent backup + restore/restart, entirely in os.tmpdir().
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-ops-'));
process.env.DB_PATH = path.join(temp, 'app.db');
process.env.ILINK_STATE_DIR = path.join(temp, 'ilink');
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.SETUP_TOKEN = crypto.randomBytes(32).toString('hex');
const { start } = require('../server');
const { closeDb } = require('../src/db');
const { backupDatabase } = require('./backup');
let server, base;

async function boot() {
  server = start();
  if (!server.listening) await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
}
async function stop() {
  if (server) {
    await Promise.all([
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      server.stopBackground(),
    ]);
    server = null;
  }
  closeDb();
}
async function request(route, { method = 'GET', body, token, raw } = {}) {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(5000),
    headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  try {
    process.env.MAINTENANCE_MODE = '1';
    await boot();
    assert.deepEqual(await request('/healthz'), { status: 503, body: { status: 'maintenance' } });
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: {} })).status, 503);
    assert.equal(fs.existsSync(process.env.DB_PATH), false, 'maintenance does not initialize or migrate the database');
    const maintenancePage = await fetch(base, { signal: AbortSignal.timeout(5000) });
    assert.equal(maintenancePage.status, 503);
    assert.equal(maintenancePage.headers.get('retry-after'), '60');
    assert.match(await maintenancePage.text(), /维护/);
    await stop();
    process.env.MAINTENANCE_MODE = '0';
    await boot();
    assert.deepEqual(await request('/healthz'), { status: 200, body: { status: 'ok' } });
    const style = await fetch(base + '/style.css', { headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(5000) });
    assert.equal(style.status, 200);
    assert.equal(style.headers.get('content-encoding'), 'gzip');
    assert.equal(style.headers.get('vary'), 'Accept-Encoding');
    assert.equal(await style.text(), fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8'));
    const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const assets = [...new Set([...index.matchAll(/(?:src|href)="(\/(?:js\/[^"?]+\.js|[^"?]+\.css))/g)].map(match => match[1]))];
    let originalBytes = 0, gzipBytes = 0;
    for (const asset of assets) {
      const plain = await fetch(base + asset, { headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(5000) });
      const zipped = await fetch(base + asset, { headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(5000) });
      assert.equal(plain.status, 200, asset);
      assert.equal(zipped.status, 200, asset);
      assert.equal(zipped.headers.get('content-encoding'), 'gzip', asset);
      originalBytes += Number(plain.headers.get('content-length'));
      gzipBytes += Number(zipped.headers.get('content-length'));
      assert.equal(await plain.text(), await zipped.text(), asset + ' decodes identically');
    }
    console.log('Static transfer: ' + JSON.stringify({ assets: assets.length, originalBytes, gzipBytes, reductionPercent: Math.round((1 - gzipBytes / originalBytes) * 100) }));
    for (const raw of ['{', 'null', '[]', 'true', '42', '"text"']) {
      assert.equal((await request('/api/auth/login', { method: 'POST', raw })).status, 400);
    }
    assert.equal((await request('/api/auth/me')).status, 401);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { setupToken: 'wrong' } })).status, 403);
    const admin = { username: 'ops-admin', password: crypto.randomBytes(24).toString('hex') };
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { setupToken: process.env.SETUP_TOKEN, admin } })).status, 200);
    const login = await request('/api/auth/login', { method: 'POST', body: admin });
    assert.equal(login.status, 200);
    const token = login.body.token;
    const saved = await request('/api/life', { method: 'POST', token, body: { content: '备份恢复验收记录' } });
    assert.equal(saved.status, 200);
    const upgrade = require('node:child_process').spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'check-upgrade.cjs')], {
      env: { ...process.env, BACKUP_DIR: path.join(temp, 'upgrade-backups') }, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
    const backup = backupDatabase(process.env.DB_PATH, path.join(temp, 'backups'));
    // A write after the snapshot must disappear on restore, unlike the first log.
    assert.equal((await request('/api/life', { method: 'POST', token, body: { content: '备份之后的记录' } })).status, 200);
    await stop();
    await boot();
    assert.equal((await request('/api/life', { token })).body.logs.length, 2, 'restart preserves committed data and session');
    await stop();
    fs.renameSync(process.env.DB_PATH, path.join(temp, 'after-backup.db'));
    for (const suffix of ['-wal', '-shm']) fs.rmSync(process.env.DB_PATH + suffix, { force: true });
    fs.copyFileSync(backup, process.env.DB_PATH);
    const snapshotBytes = fs.readFileSync(process.env.DB_PATH);
    process.env.MAINTENANCE_MODE = '1';
    await boot();
    assert.equal((await request('/api/life', { token })).status, 503);
    assert.deepEqual(fs.readFileSync(process.env.DB_PATH), snapshotBytes, 'maintenance leaves restored database untouched');
    await stop();
    process.env.MAINTENANCE_MODE = '0';
    await boot();
    const restored = await request('/api/life', { token });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.logs.length, 1);
    assert.equal(restored.body.logs[0].id, saved.body.log.id);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { setupToken: process.env.SETUP_TOKEN, admin } })).status, 400);
    console.log('Operations PASS: maintenance isolation, health, malformed JSON, initialization, auth, isolated upgrade, restart persistence, online backup and restore.');
  } finally {
    await stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
