'use strict';
const crypto = require('crypto');
const activity = require('./repo/activity.repo');

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// 一次只领取空闲槽位所需的记录。积压留在SQLite中，不装入内存。
function createOutboxWorker(db, { send, concurrency = process.env.NOTIFY_CONCURRENCY, pollMs = 1000, leaseMs = 120000, onError = error => console.error('[outbox]', error.message) } = {}) {
  if (typeof send !== 'function') throw new Error('outbox sender required');
  concurrency = boundedInt(concurrency, 8, 1, 32);
  pollMs = boundedInt(pollMs, 1000, 10, 60000);
  leaseMs = boundedInt(leaseMs, 120000, 100, 3600000);
  const active = new Map();
  const totals = { claimed: 0, sent: 0, failed: 0, skipped: 0 };
  const pausedUntil = { global:0, wechat:0 };
  let running = false, stopped = false, scheduled = null, stopPromise = null;
  const recover = db.prepare("UPDATE notification_outbox SET status='failed',next_attempt_at=?,locked_at=NULL,lock_token=NULL,last_error='delivery lease expired' WHERE status='sending' AND (locked_at IS NULL OR locked_at<?)");
  const claim = db.prepare(`UPDATE notification_outbox SET status='sending',locked_at=?,lock_token=?,attempts=attempts+1
    WHERE id=(SELECT q.id FROM notification_outbox q INDEXED BY idx_outbox_ready
      WHERE q.status IN ('pending','failed') AND q.next_attempt_at<=?
      AND (q.channel!='global' OR ?<=?) AND (q.channel!='wechat' OR ?<=?)
      AND (q.delivery_key='' OR NOT EXISTS (
        SELECT 1 FROM notification_outbox s WHERE s.status='sending' AND s.delivery_key=q.delivery_key))
      ORDER BY q.next_attempt_at,q.created_at,q.id LIMIT 1) RETURNING *`);
  const finish = db.prepare("UPDATE notification_outbox SET status='sent',sent_at=?,locked_at=NULL,lock_token=NULL,last_error=? WHERE id=? AND lock_token=?");
  const fail = db.prepare("UPDATE notification_outbox SET status='failed',next_attempt_at=?,last_error=?,locked_at=NULL,lock_token=NULL WHERE id=? AND lock_token=?");
  const renew = db.prepare("UPDATE notification_outbox SET locked_at=? WHERE id=? AND status='sending' AND lock_token=?");
  const heartbeat = setInterval(() => {
    try { for (const [id, item] of active) renew.run(Date.now(), id, item.token); }
    catch (error) { onError(error); }
  }, Math.max(25, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  async function deliver(row) {
    let payload;
    try {
      // Parse once.  Besides avoiding repeated work in a hot path, this keeps
      // the exact payload used for delivery and activity logging consistent.
      payload = JSON.parse(row.payload);
      const outcome = await send(row, payload);
      const skipped = !!outcome?.skipped;
      if (finish.run(Date.now(), skipped ? 'skipped' : null, row.id, row.lock_token).changes) {
        totals[skipped ? 'skipped' : 'sent']++;
        const recipientId = payload?.recipient?.id;
        // Delivery is already durably complete at this point.  An auxiliary
        // activity-log failure must not turn it into a retry (or, worse,
        // cause a second external notification).
        if (recipientId) {
          try {
            activity.record(db,{subjectId:recipientId,type:skipped?'notification_skipped':'notification_sent',entityType:'notification',entityId:row.id,summary:payload?.title||'',metadata:{channel:row.channel}});
          } catch (error) { onError(error); }
        }
      }
    } catch (error) {
      // 失败让出槽位，不在槽位内sleep；抖动避免大量重试同时发生。
      const base = 10000 * 2 ** Math.min(row.attempts, 8);
      let delay = Math.min(3600000, Math.round(base * (0.75 + Math.random() * 0.5)));
      if (Number(error.code)===429 || Number(error.status)===429 || Number(error.retryAfterMs)>0) {
        delay = Math.max(delay,Math.min(3600000,Number(error.retryAfterMs)||60000));
        pausedUntil[row.channel] = Math.max(pausedUntil[row.channel]||0,Date.now()+delay);
      }
      if (fail.run(Date.now() + delay, String(error.message || error).slice(0,500), row.id, row.lock_token).changes) totals.failed++;
    }
  }

  function launch(row) {
    totals.claimed++;
    // 延迟sender执行，让active先登记，且调用方事务有机会同步完成。
    const promise = Promise.resolve().then(() => deliver(row)).catch(onError).finally(() => {
      active.delete(row.id);
      if (running && !stopped) wake();
    });
    active.set(row.id, { token: row.lock_token, promise });
    return promise;
  }

  function pump() {
    scheduled = null;
    if (stopped || !running) return;
    try {
      recover.run(Date.now(), Date.now()-leaseMs);
      while (active.size < concurrency) {
        const now=Date.now();
        const row = claim.get(now, crypto.randomUUID(), now, pausedUntil.global, now, pausedUntil.wechat, now);
        if (!row) break;
        launch(row);
      }
    } catch (error) { onError(error); }
    // 有积压时由每个完成的槽位立即继续领取；空队列只做低频兜底查询。
    if (active.size < concurrency && !scheduled) {
      scheduled = setTimeout(pump, pollMs);
      scheduled.unref();
    }
  }
  function wake() {
    if (stopped || !running) return;
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(pump, 0);
    scheduled.unref();
  }
  function start() { if (!stopped) { running = true; wake(); } return api; }
  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true; running = false;
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
    stopPromise = Promise.allSettled([...active.values()].map(v=>v.promise)).then(() => { clearInterval(heartbeat); });
    return stopPromise;
  }
  // 兼容测试/手动调用；生产环境使用start持续消费，不按批次等待。
  async function drain(limit = 100) {
    if (running || stopped) return { scanned: 0, sent: 0 };
    limit = boundedInt(limit, 100, 1, 1000);
    const before = { ...totals }; let remaining = limit;
    recover.run(Date.now(), Date.now()-leaseMs);
    while ((!stopped && remaining > 0) || active.size) {
      while (!stopped && remaining > 0 && active.size < concurrency) {
        const now=Date.now();
        const row = claim.get(now, crypto.randomUUID(), now, pausedUntil.global, now, pausedUntil.wechat, now);
        if (!row) { remaining = 0; break; }
        remaining--; launch(row);
      }
      if (active.size) await Promise.race([...active.values()].map(v=>v.promise));
    }
    return { scanned: totals.claimed-before.claimed, sent: totals.sent-before.sent };
  }
  const api = { start, wake, stop, drain, stats: () => ({ running, concurrency, inFlight: active.size, ...totals, pausedUntil:{...pausedUntil} }) };
  return api;
}

module.exports = { createOutboxWorker };
