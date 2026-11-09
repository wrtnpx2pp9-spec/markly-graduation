'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createReport, sourceDigest, acquireRunLock } = require('../scripts/release-report.cjs');
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-report-'));
  fs.writeFileSync(path.join(root, 'server.js'), 'original');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const latest = root => JSON.parse(fs.readFileSync(path.join(root, 'output', 'release', 'report.json'), 'utf8'));
test('a new release run immediately invalidates stale PASS and retains isolated evidence', t => {
  const root = workspace(t), first = createReport(root);
  first.finish();
  assert.equal(latest(root).passed, true);
  const second = createReport(root);
  assert.equal(latest(root).passed, false);
  assert.equal(latest(root).status, 'running');
  assert.notEqual(first.directory, second.directory);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.directory, 'report.json'), 'utf8')).passed, true);
  first.save();
  assert.equal(latest(root).runId, second.report.runId);
});
test('source edits during verification, errors and skipped UI cannot produce a release PASS', t => {
  const root = workspace(t), changed = createReport(root);
  fs.writeFileSync(path.join(root, 'server.js'), 'changed');
  assert.equal(changed.finish(), false);
  assert.match(latest(root).error, /Source changed/);
  const skipped = createReport(root, true);
  assert.equal(skipped.finish(), false);
  assert.equal(latest(root).status, 'incomplete');
  const failed = createReport(root);
  failed.finish(new Error('browser failed'));
  assert.equal(latest(root).status, 'failed');
  assert.equal(latest(root).passed, false);
});

test('a source read failure during startup cannot preserve the previous PASS', t => {
  const root = workspace(t), previous = createReport(root);
  previous.finish();
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path.join(root, 'server.js')) throw new Error('source unreadable');
    return read(file, ...args);
  });
  assert.throws(() => createReport(root), /source unreadable/);
  assert.equal(latest(root).passed, false);
  assert.equal(latest(root).status, 'failed');
  assert.match(latest(root).error, /Cannot snapshot source/);
});

test('release verification is exclusive and unlocks without removing another owner', t => {
  const root = workspace(t), unlock = acquireRunLock(root);
  assert.throws(() => acquireRunLock(root), /already locked/);
  unlock();
  const secondUnlock = acquireRunLock(root);
  unlock();
  assert.throws(() => acquireRunLock(root), /already locked/);
  secondUnlock();
  acquireRunLock(root)();
});

test('deployment artifact changes invalidate PASS while real environment secrets stay outside the digest', t => {
  const root = workspace(t);
  const artifacts = ['Dockerfile', 'compose.yaml', '.env.example', '.dockerignore', 'deploy/markly.service', 'deploy/nginx.conf.example'];
  for (const file of artifacts) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'original deployment configuration');
    const report = createReport(root);
    fs.writeFileSync(full, 'changed deployment configuration');
    assert.equal(report.finish(), false, file);
    assert.match(latest(root).error, /Source changed/, file);
  }
  const digest = sourceDigest(root);
  fs.writeFileSync(path.join(root, '.env'), 'DUMMY_TEST_ONLY=not-a-real-secret');
  assert.equal(sourceDigest(root), digest);
});
