'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
process.env.DB_PATH = ':memory:';
let spawnImplementation;
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => spawnImplementation(...args);
const database = require('../src/db');
const users = require('../src/repo/user.repo');
// notify captures spawn on require; every test uses a fake process only.
const notify = require('../src/notify');
const turn = () => new Promise(setImmediate);
async function exercise(mode) {
  const db = database.getDb();
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  const killSignals = [];
  let fireTimeout;
  child.kill = signal => { killSignals.push(signal); return true; };
  spawnImplementation = () => child;
  const originalTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === 10000) { fireTimeout = fn; return { unref() {} }; }
    return originalTimeout(fn, ms, ...args);
  };
  let worker, draining, stopping;
  try {
    const user = users.insert(db, { username: `command-stop-${mode}`, role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
    notify.setNotifyConfig(db, { enabled: true, command: 'isolated-command' });
    notify.deliver(db, { userId: user.id, kind: 'feedback', title: 'Isolated command', content: 'No external command runs' });
    let drained = false, stopped = false;
    draining = notify.processOutbox(db, 1).then(() => { drained = true; });
    await turn();
    assert.equal(typeof fireTimeout, 'function');
    worker = notify.startOutbox(db);
    const stopPromise = worker.stop();
    assert.equal(worker.stop(), stopPromise);
    stopping = stopPromise.then(() => { stopped = true; });
    if (mode === 'timeout') fireTimeout();
    if (mode === 'stdin') child.stdin.emit('error', new Error('isolated stdin failure'));
    if (mode === 'spawn') child.emit('error', new Error('isolated spawn failure'));
    await turn();
    const beforeClose = { drained, stopped, inFlight: worker.stats().inFlight, status: db.prepare('SELECT status FROM notification_outbox').get().status };
    // A late success exit cannot erase the earlier timeout or I/O failure.
    child.emit('close', 0);
    await Promise.all([draining, stopping]);
    const afterClose = db.prepare('SELECT status,last_error FROM notification_outbox').get();
    return { beforeClose, afterClose, killSignals };
  } finally {
    child.emit('close', 0);
    await Promise.allSettled([draining, stopping].filter(Boolean));
    await worker?.stop();
    global.setTimeout = originalTimeout;
    database.closeDb();
  }
}
for (const [mode, error] of [['timeout', 'notification command timeout'], ['stdin', 'isolated stdin failure'], ['spawn', 'isolated spawn failure']]) {
  test(`${mode} failure waits for child close before drain and stop complete and retains first failure`, async () => {
    const { beforeClose, afterClose, killSignals } = await exercise(mode);
    assert.deepEqual(beforeClose, { drained: false, stopped: false, inFlight: 1, status: 'sending' });
    if (mode === 'spawn') assert.ok(killSignals.length <= 1);
    else assert.deepEqual(killSignals, ['SIGKILL']);
    assert.equal(afterClose.status, 'failed');
    assert.equal(afterClose.last_error, error);
  });
}
test('synchronous spawn failure completes without waiting for a nonexistent child', async () => {
  const db = database.getDb();
  let worker;
  try {
    spawnImplementation = () => { throw new Error('isolated synchronous spawn failure'); };
    const user = users.insert(db, { username: 'command-stop-sync-throw', role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
    notify.setNotifyConfig(db, { enabled: true, command: 'isolated-command' });
    notify.deliver(db, { userId: user.id, kind: 'feedback', title: 'Synchronous failure', content: 'No child exists' });
    await notify.processOutbox(db, 1);
    worker = notify.startOutbox(db);
    await worker.stop();
    assert.equal(worker.stats().inFlight, 0);
    const row = db.prepare('SELECT status,last_error FROM notification_outbox').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error, 'isolated synchronous spawn failure');
  } finally { await worker?.stop(); database.closeDb(); }
});
test.after(() => { childProcess.spawn = originalSpawn; });
