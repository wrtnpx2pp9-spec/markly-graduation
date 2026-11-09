'use strict';
const crypto = require('crypto');
const { reviewTimingReady } = require('../plan-lifecycle');

function pendingCountForRelation(db, supervisorId, superviseeId, now = Date.now()) {
  // Match readyForReview's active-period guard and aggregate all candidate
  // stages in one query, including stages with no effective execution days.
  const rows = db.prepare(`SELECT p.id,p.planning_mode,p.due_at,
      COUNT(d.id) AS total,COALESCE(SUM(d.checkin_state='approved'),0) AS done
    FROM plans p
    JOIN supervision_periods h ON h.id=p.cooperation_period_id
      AND h.supervisor_id=p.creator_id AND h.supervisee_id=p.assignee_id AND h.ended_at IS NULL
    JOIN supervision_relations r ON r.supervisor_id=h.supervisor_id
      AND r.supervisee_id=h.supervisee_id AND r.status='active'
    LEFT JOIN plan_days d ON d.plan_id=p.id AND d.status<>'rest' AND d.checkin_state<>'cancelled'
    WHERE p.creator_id=? AND p.assignee_id=? AND p.kind='cycle' AND p.status='active'
      AND NOT EXISTS(SELECT 1 FROM phase_stage_reviews review WHERE review.cycle_plan_id=p.id AND review.locked_at IS NOT NULL)
    GROUP BY p.id`).all(supervisorId, superviseeId);
  return rows.reduce((count, row) => count + Number(reviewTimingReady(row, row, now)), 0);
}

function byCycleId(db, cyclePlanId) {
  return db.prepare('SELECT * FROM phase_stage_reviews WHERE cycle_plan_id=?').get(cyclePlanId);
}

function byCycleIds(db, cyclePlanIds) {
  const out = new Map();
  if (!cyclePlanIds.length) return out;
  const rows = db.prepare(`SELECT * FROM phase_stage_reviews WHERE cycle_plan_id IN (${cyclePlanIds.map(() => '?').join(',')})`).all(...cyclePlanIds);
  rows.forEach((row) => out.set(row.cycle_plan_id, row));
  return out;
}

function ensure(db, data, now) {
  const existing = byCycleId(db, data.cyclePlanId);
  if (existing) return existing;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO phase_stage_reviews(
    id, parent_plan_id, cycle_plan_id, supervisee_id, supervisor_id, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?)`).run(id, data.parentPlanId, data.cyclePlanId, data.superviseeId, data.supervisorId, now, now);
  return byCycleId(db, data.cyclePlanId);
}

function saveSelf(db, data) {
  const row = ensure(db, data, data.now);
  if(row.locked_at)return row;
  db.prepare(`UPDATE phase_stage_reviews SET
    self_summary=?, self_difficulty=?, helpful_method=?, self_next_action=?, self_submitted_at=?,
    supervisee_confirmed=0, supervisor_confirmed=0, locked_at=NULL, content_revision=content_revision+1, updated_at=? WHERE id=?`
  ).run(data.summary, data.difficulty, data.helpfulMethod, data.nextAction, data.now, data.now, row.id);
  return byCycleId(db, data.cyclePlanId);
}

function saveSupervisor(db, data) {
  const row = ensure(db, data, data.now);
  if(row.locked_at)return row;
  db.prepare(`UPDATE phase_stage_reviews SET
    supervisor_observation=?, supervisor_progress=?, supervisor_suggestion=?, result_label=?, recommend_next=?, supervisor_submitted_at=?,
    supervisee_confirmed=0, supervisor_confirmed=0, locked_at=NULL, content_revision=content_revision+1, updated_at=? WHERE id=?`
  ).run(data.observation, data.progress, data.suggestion, data.resultLabel, data.recommendNext, data.now, data.now, row.id);
  return byCycleId(db, data.cyclePlanId);
}

function executionSnapshot(db, cyclePlanId) {
  const row = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN checkin_state='approved' THEN 1 ELSE 0 END), 0) AS done
    FROM plan_days WHERE plan_id=? AND status<>'rest' AND checkin_state<>'cancelled'`).get(cyclePlanId);
  const total = Number(row?.total || 0);
  const done = Number(row?.done || 0);
  return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
}

function confirm(db, cyclePlanId, role, now, expectedRevision) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = byCycleId(db, cyclePlanId);
    // Confirm exactly the text displayed to this participant. Confirming the
    // other side only changes flags, so both can use the same content revision.
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || existing?.content_revision !== expectedRevision) {
      throw Object.assign(new Error('阶段复盘已更新或确认版本缺失，请刷新页面并重新核对后确认'), { code: 'review_revision_conflict' });
    }
    if (existing?.locked_at) { db.exec('COMMIT'); return existing; }
    const column = role === 'supervisee' ? 'supervisee_confirmed' : 'supervisor_confirmed';
    db.prepare(`UPDATE phase_stage_reviews SET ${column}=1, updated_at=? WHERE cycle_plan_id=?`).run(now, cyclePlanId);
    const row = byCycleId(db, cyclePlanId);
    if (row && row.self_submitted_at && row.supervisor_submitted_at && row.supervisee_confirmed && row.supervisor_confirmed) {
      const snapshot = executionSnapshot(db, cyclePlanId);
      const snapshotJson = JSON.stringify(snapshot);
      db.prepare(`UPDATE phase_stage_reviews SET locked_at=?, execution_snapshot=?, updated_at=?
        WHERE cycle_plan_id=? AND locked_at IS NULL`).run(now, snapshotJson, now, cyclePlanId);
    }
    db.exec('COMMIT');
    return byCycleId(db, cyclePlanId);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function parseSnapshot(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function toStageReview(row, viewer) {
  if (!row) return null;
  const bothSubmitted = !!(row.self_submitted_at && row.supervisor_submitted_at);
  const showSelf = bothSubmitted || viewer.role === 'admin' || viewer.id === row.supervisee_id;
  const showSupervisor = bothSubmitted || viewer.role === 'admin' || viewer.id === row.supervisor_id;
  return {
    id: row.id,
    cyclePlanId: row.cycle_plan_id,
    revision: row.content_revision,
    selfSubmitted: !!row.self_submitted_at,
    supervisorSubmitted: !!row.supervisor_submitted_at,
    superviseeConfirmed: !!row.supervisee_confirmed,
    supervisorConfirmed: !!row.supervisor_confirmed,
    lockedAt: row.locked_at,
    executionSnapshot: parseSnapshot(row.execution_snapshot),
    selfSummary: showSelf ? row.self_summary : '',
    selfDifficulty: showSelf ? row.self_difficulty : '',
    helpfulMethod: showSelf ? row.helpful_method : '',
    selfNextAction: showSelf ? row.self_next_action : '',
    supervisorObservation: showSupervisor ? row.supervisor_observation : '',
    supervisorProgress: showSupervisor ? row.supervisor_progress : '',
    supervisorSuggestion: showSupervisor ? row.supervisor_suggestion : '',
    resultLabel: showSupervisor ? row.result_label : '',
    recommendNext: showSupervisor ? row.recommend_next : '',
    updatedAt: row.updated_at,
  };
}

module.exports = { byCycleId, byCycleIds, saveSelf, saveSupervisor, confirm, executionSnapshot, toStageReview, pendingCountForRelation };
