'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const db = getDb();
const { createOutboxWorker } = require('../src/outbox-worker');

test('手动消费停止后不再领取下一条通知', async t => {
  const insert = db.prepare("INSERT INTO notification_outbox(id,channel,payload,status,next_attempt_at,created_at,delivery_key) VALUES(?,'global','{}','pending',0,0,?)");
  insert.run('drain-a', 'a'); insert.run('drain-b', 'b');
  let arrive, release;
  const entered = new Promise(resolve => { arrive = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const worker = createOutboxWorker(db, { concurrency: 1, send: async row => { seen.push(row.id); if (row.id === 'drain-a') { arrive(); await gate; } } });
  t.after(async () => { release(); await worker.stop(); });
  const draining = worker.drain(10);
  await entered;
  const stopping = worker.stop();
  release();
  await Promise.all([draining, stopping]);
  assert.deepEqual(seen, ['drain-a']);
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id='drain-b'").get().status, 'pending');
  assert.equal(worker.stats().inFlight, 0);
});
test.after(() => closeDb());
