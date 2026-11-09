'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-reset-test-'));
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const script = path.join(root, 'scripts', 'reset.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'reset.js'), script);
  const defaultDatabase = path.join(root, 'data', 'app.db');
  fs.mkdirSync(path.dirname(defaultDatabase), { recursive: true });
  fs.writeFileSync(defaultDatabase, 'default database marker');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, script, defaultDatabase };
}

function run(workspace, database, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, workspace.script], {
    cwd: workspace.root,
    env: { ...process.env, DB_PATH: database },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function databaseFiles(database) { return [database, database + '-shm', database + '-wal']; }
function createDatabaseFiles(database) {
  fs.mkdirSync(path.dirname(database), { recursive: true });
  for (const file of databaseFiles(database)) fs.writeFileSync(file, 'isolated reset test');
}
function exists(file) { return fs.existsSync(file); }
function noSuccess(result) { assert.doesNotMatch(result.stdout, /完成。|全新状态|引导创建管理员/); }

test('reset uses the configured absolute database and its sidecars, retaining the default database', t => {
  const w = workspace(t), database = path.join(w.root, 'configured', 'custom.db');
  createDatabaseFiles(database);
  const result = run(w, database);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(databaseFiles(database).map(exists), [false, false, false]);
  assert.equal(exists(w.defaultDatabase), true);
  assert.ok(result.stdout.includes(database), result.stdout);
});

test('reset resolves a relative DB_PATH against the same working directory as SQLite', t => {
  const w = workspace(t), database = path.join(w.root, 'relative', 'custom.db');
  createDatabaseFiles(database);
  const result = run(w, path.join('relative', 'custom.db'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(databaseFiles(database).map(exists), [false, false, false]);
  assert.equal(exists(w.defaultDatabase), true);
  assert.ok(result.stdout.includes(database), result.stdout);
});

test('reset retains the original default path when DB_PATH is empty', t => {
  const w = workspace(t);
  createDatabaseFiles(w.defaultDatabase);
  const result = run(w, '');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(databaseFiles(w.defaultDatabase).map(exists), [false, false, false]);
  assert.ok(result.stdout.includes(w.defaultDatabase), result.stdout);
});

test('an in-memory database requires no disk reset and never deletes the default database', t => {
  const w = workspace(t);
  const result = run(w, ':memory:');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(exists(w.defaultDatabase), true);
  assert.match(result.stdout, /:memory:|内存/);
  noSuccess(result);
});

test('reset validates every target type before deleting any database file', t => {
  const w = workspace(t);
  fs.mkdirSync(w.defaultDatabase + '-wal');
  fs.writeFileSync(w.defaultDatabase + '-shm', 'isolated sidecar');
  const result = run(w, '');
  assert.notEqual(result.status, 0);
  assert.deepEqual(databaseFiles(w.defaultDatabase).map(exists), [true, true, true]);
  assert.ok(result.stderr.includes(w.defaultDatabase + '-wal'), result.stderr);
  noSuccess(result);
});

test('reset checks all target permissions before deleting any database file', t => {
  const w = workspace(t);
  createDatabaseFiles(w.defaultDatabase);
  const preload = path.join(w.root, 'deny-permission.cjs');
  fs.writeFileSync(preload, "const fs=require('node:fs'); const original=fs.accessSync; fs.accessSync=(file,...args)=>{if(String(file).endsWith('-wal')){const error=new Error('isolated permission denied');error.code='EACCES';throw error;} return original(file,...args);};");
  const result = run(w, '', ['--require', preload]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(databaseFiles(w.defaultDatabase).map(exists), [true, true, true]);
  assert.match(result.stderr, /permission denied/);
  noSuccess(result);
});

test('a deletion failure after validation exits unsuccessfully without claiming completion', t => {
  const w = workspace(t);
  const preload = path.join(w.root, 'deny-unlink.cjs');
  fs.writeFileSync(preload, "const fs=require('node:fs');fs.unlinkSync=()=>{const error=new Error('isolated delete failure');error.code='EPERM';throw error;};");
  const result = run(w, '', ['--require', preload]);
  assert.notEqual(result.status, 0);
  assert.equal(exists(w.defaultDatabase), true);
  assert.match(result.stderr, /delete failure/);
  noSuccess(result);
});

test('the npm reset entry loads the isolated env file before resolving DB_PATH', t => {
  const w = workspace(t), database = path.join(w.root, 'env-configured.db');
  createDatabaseFiles(database);
  fs.writeFileSync(path.join(w.root, '.env'), 'DB_PATH=env-configured.db\n');
  const command = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts.reset.split(/\s+/);
  assert.equal(command.shift(), 'node');
  const result = spawnSync(process.execPath, command, {
    cwd: w.root, env: { ...process.env, DB_PATH: undefined }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(databaseFiles(database).map(exists), [false, false, false]);
  assert.equal(exists(w.defaultDatabase), true);
});
