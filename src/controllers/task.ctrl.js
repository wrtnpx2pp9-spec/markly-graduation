'use strict';
/** 任务控制器：新建/编辑/打卡/取消打卡/删除。 */
const taskRepo = require('../repo/task.repo');
const userRepo = require('../repo/user.repo');
const planRepo = require('../repo/plan.repo');
const scope = require('../scope');
const lifecycle = require('../plan-lifecycle');
const { sendJson, sendError } = require('../router');
const activity = require('../repo/activity.repo');

// 工作台默认只需要近期已结束记录；未处理任务无论创建时间都不能遗漏。
const RECENT_WORK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function noteViolation(value) {
  return value !== undefined && typeof value !== 'string' ? '任务说明和打卡备注需填写文字' : null;
}

function inputViolation(body, partial = false) {
  if ((!partial || body.title !== undefined) && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120)) return '请填写120字以内任务标题';
  const invalidNote = noteViolation(body.note);
  if (invalidNote) return invalidNote;
  if (body.assigneeId !== undefined && (typeof body.assigneeId !== 'string' || !body.assigneeId.trim())) return '执行人标识不正确';
  if (body.planId != null && typeof body.planId !== 'string') return '计划标识不正确';
  if (body.dueAt != null && (!Number.isFinite(body.dueAt) || !Number.isFinite(new Date(body.dueAt).getTime()))) return '截止时间不正确';
  if (body.remindBeforeMinutes != null && (!Number.isInteger(body.remindBeforeMinutes) || body.remindBeforeMinutes < 0 || body.remindBeforeMinutes > 10080)) return '提醒需为0至10080分钟的整数';
  return null;
}

function register(router, deps) {
  const { notify } = deps;

  // Notifications can point to tasks older than the recent workspace window.
  router.add('GET', '/api/tasks/:id', (c) => {
    const task = taskRepo.byId(c.db, c.params.id);
    if (!scope.canAccessTask(c.db, c.user, task)) return sendError(c.res, 404, '任务不存在或无权查看');
    const participant = task.creator_id === c.user.id || task.assignee_id === c.user.id;
    const writable = participant && task.status !== 'cancelled'
      && !(task.status === 'done' && task.creator_id !== task.assignee_id)
      && lifecycle.currentPeriod(c.db, task)
      && (!task.plan_id || lifecycle.writable(c.db, planRepo.byId(c.db, task.plan_id)));
    sendJson(c.res, 200, { task: taskRepo.toTask(task), writable });
  });

  router.add('GET', '/api/tasks', (c) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(c.query.limit, 10) || 200));
    const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(c.query.offset, 10) || 0));
    const recentSince = c.query.window === 'recent' ? Date.now() - RECENT_WORK_WINDOW_MS : null;
    const tasks = taskRepo.list(c.db, scope.taskScope(c.db, c.user), limit + 1, offset, { recentSince });
    sendJson(c.res, 200, { tasks: tasks.slice(0, limit).map(taskRepo.toTask), nextOffset: tasks.length > limit ? offset + limit : null });
  });

  router.add('POST', '/api/tasks', (c) => {
    const { db, user, body } = c;
    const invalid = inputViolation(body);
    if (invalid) return sendError(c.res, 400, invalid);
    const assigneeId = body.assigneeId || user.id;
    if(user.role==='supervisor'&&assigneeId!==user.id&&!userRepo.canBind(db,user.id,assigneeId))return sendError(c.res,409,'平台合作授权不可用或服务人数额度已满');
    const assignee = userRepo.byId(db, assigneeId);
    if (!assignee || assignee.status === 0) return sendError(c.res, 400, '被分配者不存在或已停用');
    if (assigneeId !== user.id && user.role !== 'admin' && !(user.role === 'supervisor' && userRepo.activeSuperviseeIds(db, user.id).includes(assigneeId))) return sendError(c.res, 403, '不能指派给该用户');
    if (body.planId) {
      const plan = planRepo.byId(db, body.planId);
      if (!plan || !scope.canEdit(db, user, plan)) return sendError(c.res, 403, '无权向该计划添加任务');
      if (plan.status !== 'active' || plan.assignee_id !== assigneeId) return sendError(c.res, 400, '任务需指派给进行中计划的执行人');
    }
    const task = taskRepo.insert(db, {
      planId: body.planId || null,
      title: body.title,
      note: body.note ?? '',
      creatorId: user.id,
      assigneeId,
      dueAt: body.dueAt ?? null,
      remindBeforeMinutes: body.remindBeforeMinutes ?? 30,
      status: 'pending',
      createdAt: Date.now(),
    });
    sendJson(c.res, 200, { task: taskRepo.toTask(task) });
  });

  router.add('PUT', '/api/tasks/:id', (c) => {
    const { db, user, params, body } = c;
    const t = taskRepo.byId(db, params.id);
    if (!t) return sendError(c.res, 404, '任务不存在');
    if (!scope.canEdit(db, user, t)) return sendError(c.res, 403, '无权操作该任务');
    if (user.id !== t.creator_id && user.role !== 'admin') return sendError(c.res, 403, '仅创建者可修改任务约定');
    if (t.status !== 'pending') return sendError(c.res, 409, '仅待执行任务可修改');
    if (t.plan_id && !lifecycle.writable(db,planRepo.byId(db,t.plan_id))) return sendError(c.res,409,'所属计划已结束，任务仅供查阅');
    const invalid = inputViolation(body, true);
    if (invalid) return sendError(c.res, 400, invalid);
    const assigneeId = body.assigneeId !== undefined ? body.assigneeId : t.assignee_id;
    if(user.role==='supervisor'&&assigneeId!==t.assignee_id&&!userRepo.canBind(db,user.id,assigneeId))return sendError(c.res,409,'平台合作授权不可用或服务人数额度已满');
    if (t.plan_id && assigneeId !== t.assignee_id) return sendError(c.res, 400, '关联计划的任务不能单独更换执行人');
    const assignee = userRepo.byId(db, assigneeId);
    if (!assignee || assignee.status === 0) return sendError(c.res, 400, '被分配者不存在或已停用');
    if (assigneeId !== t.assignee_id && user.role !== 'admin' && !(user.role === 'supervisor' && userRepo.activeSuperviseeIds(db, user.id).includes(assigneeId))) return sendError(c.res, 403, '不能指派给该用户');
    const task = taskRepo.update(db, t.id, {
      title: body.title ?? t.title,
      note: body.note ?? t.note,
      assigneeId,
      dueAt: body.dueAt !== undefined ? body.dueAt : t.due_at,
      remindBeforeMinutes: body.remindBeforeMinutes !== undefined ? body.remindBeforeMinutes ?? 30 : t.remind_before_minutes,
    });
    sendJson(c.res, 200, { task: taskRepo.toTask(task) });
  });

  router.add('POST', '/api/tasks/:id/checkin', (c) => {
    const { db, user, params, body } = c;
    const t = taskRepo.byId(db, params.id);
    if (!t) return sendError(c.res, 404, '任务不存在');
    if (!scope.canEdit(db, user, t)) return sendError(c.res, 403, '无权操作该任务');
    if (user.id !== t.assignee_id && user.id !== t.creator_id) return sendError(c.res, 403, '你不是这项任务的负责人，无法打卡');
    const invalidNote = noteViolation(body.note);
    if (invalidNote) return sendError(c.res, 400, invalidNote);
    if (t.status === 'done') return sendJson(c.res, 200, { task: taskRepo.toTask(t) });
    if(t.status==='cancelled')return sendError(c.res,409,'任务已取消');
    if(user.id!==t.assignee_id)return sendError(c.res,403,'仅执行人可提交，监督者请在待确认中审核');
    if(t.plan_id && planRepo.byId(db,t.plan_id)?.status!=='active')return sendError(c.res,409,'所属计划未开始或已结束');
    if(t.status==='submitted')return sendJson(c.res,200,{task:taskRepo.toTask(t)});
    if(t.creator_id!==t.assignee_id){
      let task;
      try { db.exec('BEGIN IMMEDIATE');
      task=taskRepo.setStatus(db,t.id,'submitted',null,(body.note ?? '').slice(0,1000));
      activity.record(db,{actorId:user.id,subjectId:t.assignee_id,type:'task_checkin_submitted',entityType:'task',entityId:t.id,summary:t.title});
      notify.deliver(db,{userId:t.creator_id,kind:'task_submitted',title:'任务已提交，等待你确认',content:t.title,linkType:'task',linkId:t.id,recipientUser:userRepo.byId(db,t.creator_id)});
      db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      return sendJson(c.res,200,{task:taskRepo.toTask(task)});
    }
    const note = (body.note ?? '').slice(0,1000);
    let task;
    try {
      db.exec('BEGIN IMMEDIATE');
      task = taskRepo.setStatus(db, t.id, 'done', Date.now(), note);
      activity.record(db,{actorId:user.id,subjectId:t.assignee_id,type:'task_completed',entityType:'task',entityId:t.id,summary:t.title});
      if (t.status !== 'done') notifyForCheckin(db, t, user, note);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res, 200, { task: taskRepo.toTask(task) });
  });

  router.add('POST', '/api/tasks/:id/uncheck', (c) => {
    const { db, user, params } = c;
    const t = taskRepo.byId(db, params.id);
    if (!t) return sendError(c.res, 404, '任务不存在');
    if (!scope.canEdit(db, user, t)) return sendError(c.res, 403, '无权操作该任务');
    if (user.id !== t.assignee_id && user.id !== t.creator_id) return sendError(c.res, 403, '无权操作');
    if(t.status==='cancelled')return sendError(c.res,409,'任务已取消');
    if(t.plan_id && !lifecycle.writable(db,planRepo.byId(db,t.plan_id)))return sendError(c.res,409,'所属计划未开始或已结束，不能撤回');
    if(t.creator_id!==t.assignee_id && (user.id!==t.assignee_id||t.status!=='submitted'))return sendError(c.res,409,'只能撤回自己待确认的提交');
    sendJson(c.res, 200, { task: taskRepo.toTask(taskRepo.setStatus(db, t.id, 'pending', null, '')) });
  });

  router.add('POST','/api/tasks/:id/review',c=>{
    const t=taskRepo.byId(c.db,c.params.id);
    if(!t||t.creator_id!==c.user.id||t.assignee_id===c.user.id)return sendError(c.res,403,'仅监督者可审核');
    if(t.status!=='submitted')return sendError(c.res,409,'任务不在待确认状态');
    if(t.plan_id&&planRepo.byId(c.db,t.plan_id)?.status!=='active')return sendError(c.res,409,'所属计划未开始或已结束');
    const invalidNote = noteViolation(c.body.note);
    if (invalidNote) return sendError(c.res,400,invalidNote);
    const ok=c.body.decision==='approved',note=String(c.body.note||'').trim().slice(0,500);
    if(!['approved','rejected'].includes(c.body.decision)||(!ok&&!note))return sendError(c.res,400,'需要补充时请说明原因');
    let task;
    try { c.db.exec('BEGIN IMMEDIATE');
    task=taskRepo.setStatus(c.db,t.id,ok?'done':'pending',ok?Date.now():null,ok?t.checkin_note:'需要补充：'+note);
    activity.record(c.db,{actorId:c.user.id,subjectId:t.assignee_id,type:ok?'task_completed_confirmed':'task_checkin_rejected',entityType:'task',entityId:t.id,summary:t.title});
    notify.deliver(c.db,{userId:t.assignee_id,kind:'task_review',title:ok?'任务已确认完成':'任务需要补充',content:note||t.title,linkType:'task',linkId:t.id,recipientUser:userRepo.byId(c.db,t.assignee_id)});
    c.db.exec('COMMIT');
    } catch (error) { try { c.db.exec('ROLLBACK'); } catch {} throw error; }
    sendJson(c.res,200,{task:taskRepo.toTask(task)});
  });

  router.add('POST', '/api/tasks/:id/cancel', c => {
    const t = taskRepo.byId(c.db,c.params.id);
    if (!t || t.creator_id !== c.user.id) return sendError(c.res,403,'仅创建者可取消任务');
    if (!['pending','submitted'].includes(t.status)) return sendError(c.res,409,'只能取消未完成任务，已确认记录需保留');
    if (!lifecycle.currentPeriod(c.db,t) || (t.plan_id && !lifecycle.writable(c.db,planRepo.byId(c.db,t.plan_id)))) return sendError(c.res,409,'所属计划或合作已结束，历史记录仅供查阅');
    c.db.exec('BEGIN IMMEDIATE');
    try {
      c.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(t.id);
      activity.record(c.db,{actorId:c.user.id,subjectId:t.assignee_id,type:'task_cancelled',entityType:'task',entityId:t.id,summary:t.title});
      if (t.creator_id !== t.assignee_id) notify.deliver(c.db,{userId:t.assignee_id,kind:'task_update',title:'任务已取消，原记录保留',content:t.title,linkType:'task',linkId:t.id,recipientUser:userRepo.byId(c.db,t.assignee_id)});
      c.db.exec('COMMIT');
    } catch(error) { c.db.exec('ROLLBACK'); throw error; }
    sendJson(c.res,200,{task:taskRepo.toTask(taskRepo.byId(c.db,t.id))});
  });

  router.add('DELETE', '/api/tasks/:id', (c) => {
    const { db, user, params } = c;
    const t = taskRepo.byId(db, params.id);
    if (!t) return sendError(c.res, 404, '任务不存在');
    if (!scope.canEdit(db, user, t)) return sendError(c.res, 403, '无权操作该任务');
    if (user.id !== t.creator_id) return sendError(c.res, 403, '只能删除自己创建的任务');
    if (t.creator_id !== t.assignee_id) return sendError(c.res,409,'共同任务需保留历史记录，不能删除；未完成任务可取消');
    if (t.plan_id && planRepo.byId(db,t.plan_id)?.status === 'archived') return sendError(c.res,409,'已归档计划中的任务不能删除');
    try {
      db.exec('BEGIN IMMEDIATE');
      taskRepo.removeRelatedNotes(db, t.id);
      taskRepo.remove(db, t.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res, 200, { ok: true });
  });

  // 打卡成功后通知对方（双向）
  function notifyForCheckin(db, task, user, note) {
    const assignee = userRepo.byId(db, task.assignee_id);
    const creator = userRepo.byId(db, task.creator_id);
    if (creator && (!assignee || creator.id !== assignee.id)) {
      notify.deliver(db, {
        userId: creator.id,
        kind: 'task_done',
        title: '他完成了：' + task.title,
        content: (assignee ? assignee.display_name : '被监督者') + ' 已完成「' + task.title + '」' + (note ? '，备注：' + note : '') + '。',
        linkType: 'task',
        linkId: task.id,
        recipientUser: creator,
      });
    }
    if (assignee && (!creator || assignee.id !== creator.id)) {
      notify.deliver(db, {
        userId: assignee.id,
        kind: 'task_done',
        title: '你的任务已完成：' + task.title,
        content: '「' + task.title + '」已完成，别忘了记录到生活里。',
        linkType: 'task',
        linkId: task.id,
        recipientUser: assignee,
      });
    }
  }
}

module.exports = { register };
