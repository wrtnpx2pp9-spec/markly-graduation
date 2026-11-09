'use strict';
/** 看板控制器。 */
const taskRepo = require('../repo/task.repo');
const planRepo = require('../repo/plan.repo');
const noteRepo = require('../repo/note.repo');
const scope = require('../scope');
const { sendJson } = require('../router');

function register(router) {
  router.add('GET','/api/me/worklist', c => {
    const rows=c.db.prepare(`SELECT d.*,p.title AS plan_title,p.creator_id,p.assignee_id,p.status AS plan_status
      FROM plan_days d JOIN plans p ON p.id=d.plan_id
      WHERE (p.creator_id=? OR p.assignee_id=?) AND p.status='active' AND d.status<>'rest' AND d.checkin_state<>'cancelled' ORDER BY d.day_date,d.seq`).all(c.user.id,c.user.id);
    sendJson(c.res,200,{days:rows.map(r=>({...planRepo.toDay(r),planTitle:r.plan_title,creatorId:r.creator_id,assigneeId:r.assignee_id}))});
  });
  router.add('GET', '/api/me/overview', (c) => {
    const { db, user } = c;
    const now = Date.now(), t0 = new Date(now); t0.setHours(0, 0, 0, 0);
    const tomorrow = new Date(t0); tomorrow.setDate(tomorrow.getDate() + 1);
    const data = taskRepo.overview(db, scope.taskScope(db, user), { now, todayStart: t0.getTime(), tomorrow: tomorrow.getTime() });
    sendJson(c.res, 200, {
      role: user.role,
      user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
      unread: noteRepo.unreadCount(db, user.id),
      stats: data.stats,
      todayTasks: data.todayTasks.map(taskRepo.toTask),
      overdue: data.overdue.map(taskRepo.toTask),
      upcoming: data.upcoming.map(taskRepo.toTask),
      plans: planRepo.list(db, scope.planScope(db, user)).map(plan => planRepo.toPlan(plan)),
    });
  });
}

module.exports = { register };
