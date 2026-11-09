'use strict';
const crypto = require('crypto');

function toReview(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    reviewerId: row.reviewer_id,
    supervisorId: row.supervisor_id,
    rating: row.rating,
    content: row.content || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function byPlanId(db, planId) {
  return db.prepare('SELECT * FROM service_reviews WHERE plan_id=?').get(planId);
}

function byPlanIds(db, planIds) {
  if (!planIds?.length) return new Map();
  const rows = db.prepare('SELECT * FROM service_reviews WHERE plan_id IN (' + planIds.map(() => '?').join(',') + ')').all(...planIds);
  return new Map(rows.map((row) => [row.plan_id, row]));
}

function upsert(db, { planId, reviewerId, supervisorId, rating, content, now }) {
  db.prepare(`
    INSERT INTO service_reviews(id, plan_id, reviewer_id, supervisor_id, rating, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_id) DO UPDATE SET
      reviewer_id=excluded.reviewer_id,
      supervisor_id=excluded.supervisor_id,
      rating=excluded.rating,
      content=excluded.content,
      updated_at=excluded.updated_at
  `).run(crypto.randomUUID(), planId, reviewerId, supervisorId, rating, content || '', now, now);
  return byPlanId(db, planId);
}

function refreshSupervisorMetrics(db, supervisorId) {
  const stats = db.prepare('SELECT COUNT(*) AS count, AVG(rating) AS average FROM service_reviews WHERE supervisor_id=?').get(supervisorId);
  const reputationScore = stats.count ? Math.round(Number(stats.average) * 20) : 0;
  db.prepare('UPDATE users SET reputation_score=?, completed_service_count=? WHERE id=?').run(reputationScore, stats.count, supervisorId);
  return { reputationScore, completedServiceCount: stats.count };
}

module.exports = { toReview, byPlanId, byPlanIds, upsert, refreshSupervisorMetrics };
