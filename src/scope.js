'use strict';
/** 角色作用域：决定“当前用户能看到哪些任务/计划”。 */
const userRepo = require('./repo/user.repo');

function taskScope(db, user) {
  if (user.role === 'admin') return { all: true };
  // 列表只展示个人记录，以及当前有效监督关系中的协作记录。
  // 已结束关系的历史仍保留在库中，但不再占用当前工作区。
  return { accessUserId: user.id, accessRole: user.role };
}

function planScope(db, user) {
  return taskScope(db, user);
}

function canAccessTask(db, user, task) {
  if (!task || !user || user.status === 0) return false;
  if (user.role === 'admin') return true;
  if (task.creator_id === user.id || task.assignee_id === user.id) return true;
  return false;
}

function canAccessPlan(db, user, plan) {
  if (!plan || !user || user.status === 0) return false;
  if (user.role === 'admin') return true;
  if (plan.creator_id === user.id || plan.assignee_id === user.id) return true;
  return false;
}

// 共享监督关系只授予查看权限；修改仅限管理员和记录双方。
function canEdit(db, user, record) {
  return !!record && !!user && user.status !== 0 &&
    (user.role === 'admin' || record.creator_id === user.id || record.assignee_id === user.id);
}

module.exports = { taskScope, planScope, canAccessTask, canAccessPlan, canEdit };
