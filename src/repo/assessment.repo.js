'use strict';
/** 被监督者服务评估：仅保存服务所需的自述信息，不承载医疗诊断。 */
function byUser(db, userId) {
  return db.prepare('SELECT * FROM supervisee_assessments WHERE user_id=?').get(userId);
}
function toAssessment(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    selfPosition: row.self_position || '',
    primaryGoal: row.primary_goal,
    currentSituation: row.current_situation,
    availableMinutes: row.available_minutes,
    preferredRhythm: row.preferred_rhythm,
    obstacles: row.obstacles || '',
    supportPreferences: row.support_preferences || '',
    desiredStartAt: row.desired_start_at,
    updatedAt: row.updated_at,
  };
}
function save(db, userId, assessment) {
  const updatedAt = Date.now();
  db.prepare(`INSERT INTO supervisee_assessments(user_id,self_position,primary_goal,current_situation,available_minutes,preferred_rhythm,obstacles,support_preferences,desired_start_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET self_position=excluded.self_position,primary_goal=excluded.primary_goal,current_situation=excluded.current_situation,
      available_minutes=excluded.available_minutes,preferred_rhythm=excluded.preferred_rhythm,obstacles=excluded.obstacles,
      support_preferences=excluded.support_preferences,desired_start_at=excluded.desired_start_at,updated_at=excluded.updated_at`)
    .run(userId, assessment.selfPosition, assessment.primaryGoal, assessment.currentSituation, assessment.availableMinutes, assessment.preferredRhythm, assessment.obstacles, assessment.supportPreferences, assessment.desiredStartAt, updatedAt);
  return toAssessment(byUser(db, userId));
}

module.exports = { byUser, toAssessment, save };
