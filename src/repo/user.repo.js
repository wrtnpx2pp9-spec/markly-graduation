'use strict';
/** 用户数据访问。所有 SQL 与字段映射集中在此，业务层只面向 camelCase 对象。 */
const crypto = require('crypto');

const ROLES = ['admin', 'supervisor', 'supervisee'];
const ACCOUNT_LEVELS = {
  basic: { label: '基础' },
  trusted: { label: '成长' },
  professional: { label: '专业' },
  expert: { label: '资深' },
};

function isServiceEnabled(u) {
  return !!u && u.role === 'supervisor' && u.status === 1 && u.cooperation_state === 'active' && !!u.agreement_ref?.trim();
}
function effectiveCapacity(u) {
  return isServiceEnabled(u) ? Math.max(0, Number(u.capacity_override) || 0) : 0;
}
function toPublic(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role, identity: (u.role==='supervisor'&&u.identity==='mentor')||(u.role==='supervisee'&&u.identity==='mentee')?u.identity:u.role, displayName: u.display_name, avatar: u.avatar || '', gender: u.gender || 'unspecified',
    status: u.status, managedBy: u.managed_by, accountLevel: u.account_level || 'basic', superviseeLimit: effectiveCapacity(u), cooperationState: u.cooperation_state || 'pending', serviceEnabled: isServiceEnabled(u), capacityOverride: u.capacity_override ?? 0, capacitySource: 'admin', reputationScore: u.reputation_score || 0, completedServiceCount: u.completed_service_count || 0, createdAt: u.created_at,
  };
}
function toUser(u) {
  return toPublic(u);
}

function all(db) {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
}
function peopleFor(db, user) {
  const columns = 'u.id,u.username,u.role,u.identity,u.display_name,u.avatar,u.gender,u.status';
  if (user.role === 'admin') return db.prepare(`SELECT ${columns} FROM users u WHERE u.role!='admin' AND u.status=1 ORDER BY u.created_at`).all();
  if (user.role === 'supervisee') return db.prepare(`SELECT ${columns} FROM users u JOIN supervision_relations r ON r.supervisor_id=u.id WHERE r.supervisee_id=? AND r.status='active' ORDER BY u.created_at`).all(user.id);
  const hasCapacity = relationCount(db, user.id) < supervisorCapacity(db, user.id);
  return db.prepare(`SELECT ${columns} FROM users u WHERE u.role='supervisee' AND u.status=1 AND (? OR EXISTS (SELECT 1 FROM supervision_relations r WHERE r.supervisee_id=u.id AND r.supervisor_id=? AND r.status='active')) ORDER BY u.created_at`).all(hasCapacity ? 1 : 0, user.id);
}
function byId(db, id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
function byUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username=?').get(username);
}
function count(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}
function countByRole(db, role) {
  return db.prepare('SELECT COUNT(*) AS c FROM users WHERE role=?').get(role).c;
}
function countActive(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM users WHERE status=1').get().c;
}
function whereForList({ role, status, q } = {}) {
  const conds = []; const args = [];
  if (role) { conds.push('role=?'); args.push(role); }
  if (status !== undefined) { conds.push('status=?'); args.push(status ? 1 : 0); }
  const keyword = typeof q === 'string' ? q.trim().slice(0, 64) : '';
  if (keyword) { conds.push("(username LIKE ? ESCAPE '\\' COLLATE NOCASE OR display_name LIKE ? ESCAPE '\\' COLLATE NOCASE)"); const like='%' + keyword.replace(/[\\%_]/g, '\\$&') + '%'; args.push(like, like); }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', args };
}
// 按筛选条件查用户（管理后台）
function listWhere(db, { role, status, q, limit = 200, offset = 0 } = {}) {
  // Public pages cap at 500; the controller needs one extra row to detect the next page.
  const safeLimit = Math.min(501, Math.max(1, Number.parseInt(limit, 10) || 200));
  const safeOffset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(offset, 10) || 0));
  const filter = whereForList({ role, status, q });
  return db.prepare('SELECT * FROM users ' + filter.where + ' ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?').all(...filter.args, safeLimit, safeOffset);
}
function countWhere(db, filters = {}) { const filter=whereForList(filters); return db.prepare('SELECT COUNT(*) AS count FROM users ' + filter.where).get(...filter.args).count; }
function superviseeIds(db) {
  return db.prepare("SELECT id FROM users WHERE role='supervisee'").all().map((r) => r.id);
}
// 监督者可“指派 / 看见”的被监督者（绑定隔离）：
// 已绑定给我的 → 只看到这些；我还没绑定任何人 → 可见尚未绑定监督者的被监督者
function activeSuperviseeIds(db, supervisorId) {
  return db.prepare("SELECT supervisee_id AS id FROM supervision_relations WHERE supervisor_id=? AND status='active' ORDER BY created_at ASC").all(supervisorId).map((r) => r.id);
}
function activeSupervisorIds(db, superviseeId) {
  return db.prepare("SELECT supervisor_id AS id FROM supervision_relations WHERE supervisee_id=? AND status='active' ORDER BY created_at ASC").all(superviseeId).map((r) => r.id);
}
function relationCount(db, supervisorId) {
  return db.prepare("SELECT COUNT(*) AS c FROM supervision_relations WHERE supervisor_id=? AND status='active'").get(supervisorId).c;
}
function supervisorCapacity(db, supervisorId) {
  const user = byId(db, supervisorId);
  if (!user) return 0;
  return effectiveCapacity(user);
}
function canBind(db, supervisorId, superviseeId) {
  const supervisor = byId(db, supervisorId);
  const supervisee = byId(db, superviseeId);
  if (!supervisor || supervisor.role !== 'supervisor' || supervisor.status !== 1) return false;
  if (!isServiceEnabled(supervisor) || supervisorCapacity(db,supervisorId) <= 0) return false;
  if (!supervisee || supervisee.role !== 'supervisee' || supervisee.status !== 1) return false;
  if (activeSupervisorIds(db, superviseeId).includes(supervisorId)) return true;
  return relationCount(db, supervisorId) < supervisorCapacity(db, supervisorId);
}
function assignableSuperviseeIds(db, supervisorId) {
  const bound = activeSuperviseeIds(db, supervisorId);
  if (bound.length >= supervisorCapacity(db, supervisorId)) return bound;
  const rows = db.prepare("SELECT id FROM users WHERE role='supervisee' AND status=1 AND id NOT IN (SELECT supervisee_id FROM supervision_relations WHERE supervisor_id=? AND status='active') ORDER BY created_at ASC").all(supervisorId);
  return [...bound, ...rows.map((r) => r.id)];
}
function boundSuperviseeIds(db, supervisorId) { return activeSuperviseeIds(db, supervisorId); }
// Call inside the caller's transaction so every entry point closes the same workflow.
function endRelation(db, supervisorId, superviseeId) {
  const now = Date.now();
  db.prepare("INSERT INTO supervision_periods(id,supervisor_id,supervisee_id,started_at) SELECT lower(hex(randomblob(16))),supervisor_id,supervisee_id,created_at FROM supervision_relations r WHERE supervisor_id=? AND supervisee_id=? AND status='active' AND NOT EXISTS(SELECT 1 FROM supervision_periods h WHERE h.supervisor_id=r.supervisor_id AND h.supervisee_id=r.supervisee_id AND h.ended_at IS NULL)").run(supervisorId,superviseeId);
  db.prepare('UPDATE supervision_periods SET ended_at=? WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').run(now,supervisorId,superviseeId);
  db.prepare("UPDATE supervision_relations SET status='ended', ended_at=? WHERE supervisor_id=? AND supervisee_id=? AND status='active'").run(now,supervisorId,superviseeId);
  db.prepare("UPDATE service_requests SET status='closed',updated_at=? WHERE supervisor_id=? AND supervisee_id=? AND status!='closed'").run(now,supervisorId,superviseeId);
  db.prepare("UPDATE plans SET status='archived' WHERE creator_id=? AND assignee_id=?").run(supervisorId,superviseeId);
  db.prepare("UPDATE daily_plan_proposals SET status='closed',version=version+1,updated_at=? WHERE status IN ('draft','submitted') AND plan_id IN (SELECT id FROM plans WHERE creator_id=? AND assignee_id=?)").run(now,supervisorId,superviseeId);
  db.prepare("UPDATE tasks SET status='cancelled' WHERE creator_id=? AND assignee_id=? AND status IN ('pending','submitted')").run(supervisorId,superviseeId);
}
// Role changes also invalidate negotiations that have not created a relationship yet.
// Keep their plans and messages as history, and call this inside the role-change transaction.
function closePendingRequests(db, userId) {
  db.prepare("UPDATE plans SET status='archived' WHERE status IN ('proposed','declined') AND service_request_id IN (SELECT id FROM service_requests WHERE (supervisor_id=? OR supervisee_id=?) AND status IN ('discussing','planning','plan_proposed'))").run(userId,userId);
  db.prepare("UPDATE service_requests SET status='closed',updated_at=? WHERE (supervisor_id=? OR supervisee_id=?) AND status IN ('discussing','planning','plan_proposed')").run(Date.now(),userId,userId);
}
function setRelations(db, superviseeId, supervisorIds) {
  const unique = [...new Set((supervisorIds || []).filter(Boolean))];
  for (const supervisorId of unique) {
    const existing = activeSupervisorIds(db, superviseeId).includes(supervisorId);
    if (!existing && !canBind(db, supervisorId, superviseeId)) throw new Error('invalid supervision relation');
    const supervisor = byId(db, supervisorId);
    const supervisee = byId(db, superviseeId);
    // Existing disabled participants may be retained while another relationship is removed.
    // New relationships still pass canBind above, including enabled accounts and service capacity.
    if (!supervisor || supervisor.role !== 'supervisor' || !supervisee || supervisee.role !== 'supervisee') throw new Error('invalid supervision relation');
  }
  const current = activeSupervisorIds(db, superviseeId);
  for (const supervisorId of current) if (!unique.includes(supervisorId)) endRelation(db, supervisorId, superviseeId);
  for (const supervisorId of unique) {
    db.prepare("INSERT INTO supervision_periods(id,supervisor_id,supervisee_id,started_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL)").run(crypto.randomUUID(),supervisorId,superviseeId,Date.now(),supervisorId,superviseeId);
  }
  for (const supervisorId of unique) db.prepare("INSERT INTO supervision_relations(id, supervisor_id, supervisee_id, status, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, 'active', ?) ON CONFLICT(supervisor_id, supervisee_id) DO UPDATE SET status='active', ended_at=NULL").run(supervisorId, superviseeId, Date.now());
  db.prepare("UPDATE users SET managed_by=? WHERE id=?").run(unique[0] || null, superviseeId);
}
function insert(db, { username, role, passwordHash, salt, displayName, managedBy, status, accountLevel, superviseeLimit, capacityOverride, reputationScore, completedServiceCount, createdAt }) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO users(id, username, role, password_hash, salt, display_name, status, managed_by, account_level, supervisee_limit, capacity_override, reputation_score, completed_service_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, username, role, passwordHash, salt, displayName || username, status ?? 1, managedBy || null, accountLevel || 'basic', role === 'supervisor' ? 1 : 0, capacityOverride ?? null, reputationScore || 0, completedServiceCount || 0, createdAt);
  return byId(db, id);
}
// 允许更新的字段
function update(db, id, fields) {
  const allowed = { identity:'identity', displayName: 'display_name', role: 'role', managedBy: 'managed_by', status: 'status', accountLevel: 'account_level', superviseeLimit: 'capacity_override', capacityOverride: 'capacity_override', reputationScore: 'reputation_score', completedServiceCount: 'completed_service_count' };
  const sets = []; const args = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (fields[k] !== undefined) { sets.push(col + '=?'); args.push(fields[k]); }
  }
  if (!sets.length) return byId(db, id);
  args.push(id);
  db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id=?').run(...args);
  return byId(db, id);
}
function setStatus(db, id, status) {
  return update(db, id, { status });
}
function resetPassword(db, id, passwordHash, salt) {
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(passwordHash, salt, id);
  return byId(db, id);
}
function removeCascade(db, id) {
  // Retain shared cooperation records for the surviving participant.
  const relations=db.prepare("SELECT supervisor_id,supervisee_id FROM supervision_relations WHERE (supervisor_id=? OR supervisee_id=?) AND status='active'").all(id,id);
  for(const r of relations) {
    endRelation(db,r.supervisor_id,r.supervisee_id);
    db.prepare('UPDATE users SET managed_by=? WHERE id=?').run(activeSupervisorIds(db,r.supervisee_id)[0]||null,r.supervisee_id);
  }
  db.prepare("UPDATE service_requests SET status='closed',updated_at=? WHERE supervisor_id=? OR supervisee_id=?").run(Date.now(),id,id);
  db.prepare("UPDATE plans SET status='archived' WHERE (creator_id=? OR assignee_id=?) AND creator_id<>assignee_id").run(id,id);
  db.prepare("UPDATE tasks SET status='cancelled' WHERE (creator_id=? OR assignee_id=?) AND creator_id<>assignee_id AND status IN ('pending','submitted')").run(id,id);
  for(const table of ['certifications','supervisee_assessments','user_profiles'])db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);
  for(const table of ['plan_day_comments','plan_day_items','plan_days'])db.prepare(`DELETE FROM ${table} WHERE plan_id IN (SELECT id FROM plans WHERE creator_id=? AND assignee_id=?)`).run(id,id);
  db.prepare('DELETE FROM tasks WHERE creator_id=? AND assignee_id=?').run(id,id);
  db.prepare('DELETE FROM plans WHERE creator_id=? AND assignee_id=?').run(id,id);
  db.prepare('DELETE FROM plan_templates WHERE owner_id=?').run(id);
  db.prepare('DELETE FROM life_logs WHERE user_id=?').run(id);
  db.prepare('DELETE FROM notifications WHERE user_id=?').run(id);
  db.prepare('DELETE FROM wechat_deliveries WHERE user_id=?').run(id);
  db.prepare('DELETE FROM wechat_bindings WHERE user_id=?').run(id);
  db.prepare('DELETE FROM wechat_bot_instances WHERE user_id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('UPDATE audit_logs SET actor_id=NULL WHERE actor_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
}

function remove(db, id) {
  removeCascade(db, id);
}
function listSupervisorIds(db) {
  return db.prepare("SELECT id FROM users WHERE role='supervisor' AND status=1").all().map((r) => r.id);
}

module.exports = {
  ROLES, toPublic, toUser, all, peopleFor, byId, byUsername, count, countByRole, countActive, isServiceEnabled,
  listWhere, countWhere, superviseeIds, insert, update, setStatus, resetPassword, remove, removeCascade, listSupervisorIds,
  endRelation, closePendingRequests, ACCOUNT_LEVELS, activeSuperviseeIds, activeSupervisorIds, relationCount, supervisorCapacity, canBind, assignableSuperviseeIds, boundSuperviseeIds, setRelations,
};
