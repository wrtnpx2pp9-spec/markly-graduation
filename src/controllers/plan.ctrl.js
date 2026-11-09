'use strict';
/** 监督计划控制器：普通计划 + 长期/周期子计划 + 每日打卡 + 常用内容模板。 */
const crypto = require('crypto');
const { normalizeSchedule, slotTitle } = require('../plan-schedule');
const activity = require('../repo/activity.repo');
const planRepo = require('../repo/plan.repo');
const reviewRepo = require('../repo/service-review.repo');
const phaseReviewRepo = require('../repo/phase-review.repo');
const userRepo = require('../repo/user.repo');
const scope = require('../scope');
const lifecycle = require('../plan-lifecycle');
const { sendJson, sendError } = require('../router');
const RECENT_WORK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function planInputError(body) {
  if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120)) return '请填写120字以内计划标题';
  for (const [field, max, label] of [['description', 1000, '计划说明'], ['dailyContent', 500, '每日内容']]) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > max)) return `${label}请填写${max}字以内的文字`;
  }
  if (['startAt', 'dueAt'].some(key => body[key] != null && (!Number.isFinite(body[key]) || !Number.isFinite(new Date(body[key]).getTime())))) return '日期不正确';
  if (body.remindBeforeMinutes !== undefined && (!Number.isInteger(body.remindBeforeMinutes) || body.remindBeforeMinutes < 0 || body.remindBeforeMinutes > 10080)) return '提醒需为0至10080分钟的整数';
  if (['assigneeId', 'parentId'].some(key => body[key] != null && typeof body[key] !== 'string')) return '执行人或所属计划格式不正确';
  return null;
}

function register(router, deps = {}) {
  const notify = deps.notify || require('../notify');
  function daySignal(db, plan, recipientId, title, dayId) {
    const day = dayId ? planRepo.dayById(db, dayId) : null;
    const content = day ? `${plan.title} · ${day.day_date}：${day.content}。请登录 Markly，在“消息 → 查看并处理”中查看打卡内容与审核结果。` : plan.title;
    notify.deliver(db, { userId: recipientId, kind: 'plan_update', title, content,
      linkType: dayId ? 'day' : 'plan', linkId: dayId || plan.id, recipientUser: userRepo.byId(db, recipientId) });
  }
  router.add('POST', '/api/plan-bundles', c => {
    const { db, user, body: b } = c;
    if(user.role!=='supervisor')return sendError(c.res,403,'仅监督者可发送监督计划');
    if(b.planningMode!==undefined&&!['fixed','rolling'].includes(b.planningMode))return sendError(c.res,400,'计划编排方式不正确');
    if(b.draftId){const error=require('../plan-drafts').publishGuard(db,user,b);if(error)return sendError(c.res,error.status,error.error);}
    if(!userRepo.isServiceEnabled(user)||!userRepo.canBind(db,user.id,b.assigneeId))return sendError(c.res,409,'平台合作授权不可用或服务人数额度已满');
    const request = b.requestId ? db.prepare('SELECT * FROM service_requests WHERE id=?').get(b.requestId) : null;
    if (b.requestId && (!request || request.supervisor_id!==user.id || request.supervisee_id!==b.assigneeId || request.status!=='planning')) return sendError(c.res,403,'该协商尚未确认接手或无权制定计划');
    if(!request && !userRepo.activeSuperviseeIds(db,user.id).includes(b.assigneeId))return sendError(c.res,403,'请先确认接手协商，或为已建立关系制定计划');
    if (request && db.prepare("SELECT id FROM plans WHERE service_request_id=? AND status='proposed' LIMIT 1").get(request.id)) return sendError(c.res,409,'已有待接受的计划，请等待对方处理');
    if(typeof b.title!=='string'||!b.title.trim()||b.title.length>120)return sendError(c.res,400,'请填写120字以内的目标');
    const cycles = normalizeBundleCycles(b);
    if (!cycles) return sendError(c.res, 400, '请至少安排一个阶段；每个阶段需有名称、每日安排与正确日期');
    if (cycles.some((cycle) => cycle.days.length > 120) || cycles.reduce((total, cycle) => total + cycle.days.length, 0) > 365) return sendError(c.res, 400, '每个阶段最多120天，首次计划合计最多365天');
    let parent;
    try{
      db.exec('BEGIN IMMEDIATE');
      const base={creatorId:user.id,assigneeId:b.assigneeId,startAt:Math.min(...cycles.map(c=>c.startAt)),dueAt:Math.max(...cycles.map(c=>c.dueAt)),description:String(b.description||'').slice(0,1000),remindBeforeMinutes:30,status:'proposed',serviceRequestId:request?.id||null,createdAt:Date.now()};
      base.planningMode=b.planningMode||'fixed';
      parent=planRepo.insert(db,{...base,title:b.title.trim(),kind:'phase'});
      for (const cycleData of cycles) {
        const cycle=planRepo.insert(db,{...base,description:base.planningMode==='rolling'?cycleData.rhythm:base.description,title:cycleData.title,kind:'cycle',parentId:parent.id,startAt:cycleData.startAt,dueAt:cycleData.dueAt,remindHour:cycleData.remindHour});
        planRepo.insertDays(db,cycle.id,cycleData.days);
      }
      if (request) db.prepare("UPDATE service_requests SET status='plan_proposed',plan_id=?,updated_at=? WHERE id=?").run(parent.id,Date.now(),request.id);
      daySignal(db,parent,parent.assignee_id,'收到新计划，请确认后开始');
      if(b.draftId)db.prepare('UPDATE plan_drafts SET plan_id=?,updated_at=? WHERE id=?').run(parent.id,Date.now(),b.draftId);
      db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
    sendJson(c.res,200,{plan:planRepo.toPlan(parent),cycleCount:cycles.length});
  });
  router.add('POST','/api/plans/:id/agreement',c=>{
    if(!['accept','decline'].includes(c.body.decision))return sendError(c.res,400,'请选择接受或暂不接受');
    const note=String(c.body.note||'').trim().slice(0,500);
    if(c.body.decision==='decline'&&!note)return sendError(c.res,400,'请说明需要调整的内容');
    const status=c.body.decision==='accept'?'active':'declined';
    let p, request;
    try{c.db.exec('BEGIN IMMEDIATE');
      // Always re-read after taking the write lock. The request and the whole
      // initial bundle must still be in the state in which they were offered.
      p=planRepo.byId(c.db,c.params.id);
      if(!p || p.assignee_id!==c.user.id){c.db.exec('ROLLBACK');return sendError(c.res,403,'仅计划执行人可确认');}
      if(p.status!=='proposed'){c.db.exec('ROLLBACK');return sendError(c.res,409,'计划已处理');}
      if (p.parent_id) {
        const parent = planRepo.byId(c.db, p.parent_id);
        if (!parent || parent.kind !== 'phase' || parent.creator_id !== p.creator_id || parent.assignee_id !== p.assignee_id || !lifecycle.writable(c.db, parent) || parent.cooperation_period_id !== p.cooperation_period_id) {
          c.db.exec('ROLLBACK'); return sendError(c.res,409,'请从长期目标接受整套计划；独立续期阶段要求所属目标及合作仍有效');
        }
        if (status === 'active' && lifecycle.overlappingStage(c.db, parent.id, p.start_at, p.due_at, p.id)) {
          c.db.exec('ROLLBACK'); return sendError(c.res,409,'阶段日期与已有待接受或进行中的阶段重叠，请调整后重发');
        }
      }
      request = p.service_request_id ? c.db.prepare('SELECT * FROM service_requests WHERE id=?').get(p.service_request_id) : null;
      if (p.service_request_id && !request) {
        c.db.exec('ROLLBACK'); return sendError(c.res,409,'关联协商不存在或已关闭，请刷新后处理');
      }
      if (!request && !lifecycle.currentPeriod(c.db, p)) {
        c.db.exec('ROLLBACK'); return sendError(c.res,409,'所属合作已结束，请重新协商并发送新计划');
      }
      if (request && (request.plan_id!==p.id || p.parent_id!==null || p.kind!=='phase' || request.supervisor_id!==p.creator_id || request.supervisee_id!==p.assignee_id || request.status!=='plan_proposed')) {
        c.db.exec('ROLLBACK'); return sendError(c.res,409,'关联协商状态已更新，请刷新后处理');
      }

      // A request-backed bundle is confirmed only through its root phase.
      // For a root without a request, confirm its complete proposed tree;
      // an independently added cycle is confirmed on its own.
      let tree=[p];
      if(!p.parent_id){
        tree=c.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM plans WHERE id=? UNION ALL SELECT child.id FROM plans child JOIN tree parent ON child.parent_id=parent.id) SELECT * FROM plans WHERE id IN (SELECT id FROM tree)`).all(p.id);
        if(tree.some(item=>item.creator_id!==p.creator_id||item.assignee_id!==p.assignee_id||item.status!=='proposed'||(request && item.service_request_id!==request.id))) {
          c.db.exec('ROLLBACK'); return sendError(c.res,409,'计划树状态已更新，请刷新后处理');
        }
      }
      if(status==='active'&&p.creator_id!==p.assignee_id&&userRepo.byId(c.db,p.creator_id)?.role==='supervisor'&&!userRepo.canBind(c.db,p.creator_id,p.assignee_id)){c.db.exec('ROLLBACK');return sendError(c.res,409,'平台合作授权不可用或服务人数额度已满');}
      if (request && status==='active') {
        if(!userRepo.canBind(c.db,request.supervisor_id,request.supervisee_id)){c.db.exec('ROLLBACK');return sendError(c.res,409,'监督者当前容量已满，暂时无法开始');}
        userRepo.setRelations(c.db,request.supervisee_id,[...userRepo.activeSupervisorIds(c.db,request.supervisee_id),request.supervisor_id]);
        const period=c.db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(request.supervisor_id,request.supervisee_id);
        if(!period){c.db.exec('ROLLBACK');return sendError(c.res,409,'当前合作周期已关闭，请刷新后处理');}
        c.db.prepare('UPDATE plans SET cooperation_period_id=? WHERE id IN ('+tree.map(()=>'?').join(',')+')').run(period.id,...tree.map(item=>item.id));
        c.db.prepare("UPDATE service_requests SET status='accepted',supervisee_confirmed=1,updated_at=? WHERE id=? AND status='plan_proposed' AND plan_id=?").run(Date.now(),request.id,p.id);
      }
      c.db.prepare('UPDATE plans SET status=?,agreement_note=? WHERE id IN ('+tree.map(()=>'?').join(',')+') AND status=?').run(status,note,...tree.map(item=>item.id),'proposed');
      if (request && status==='declined') c.db.prepare("UPDATE service_requests SET status='planning',plan_id=NULL,updated_at=? WHERE id=? AND status='plan_proposed' AND plan_id=?").run(Date.now(),request.id,p.id);
      daySignal(c.db,p,p.creator_id,status==='active'?'对方已接受计划':'计划暂未接受，请查看调整建议');
      c.db.exec('COMMIT');
    }catch(e){try{c.db.exec('ROLLBACK');}catch{}throw e;}
    sendJson(c.res,200,{ok:true});
  });
  router.add('GET', '/api/plans', (c) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(c.query.limit, 10) || 200));
    const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(c.query.offset, 10) || 0));
    const recentSince = c.query.window === 'recent' ? Date.now() - RECENT_WORK_WINDOW_MS : null;
    const plans = planRepo.list(c.db, scope.planScope(c.db, c.user), limit + 1, offset, { recentSince });
    const page = plans.slice(0, limit);
    const reviews = reviewRepo.byPlanIds(c.db, page.map((plan) => plan.id));
    const phaseReviews = phaseReviewRepo.byCycleIds(c.db, page.filter((plan) => plan.kind === 'cycle').map((plan) => plan.id));
    const coverage = planRepo.coverageByParentIds(c.db, page.filter((plan) => plan.kind === 'phase').map((plan) => plan.id));
    sendJson(c.res, 200, {
      plans: page.map((plan) => {
        const review = reviews.get(plan.id);
        const visibleReview = review && (c.user.role === 'admin' || review.reviewer_id === c.user.id || review.supervisor_id === c.user.id) ? reviewRepo.toReview(review) : null;
        return planRepo.toPlan(plan, visibleReview, phaseReviewRepo.toStageReview(phaseReviews.get(plan.id), c.user), coverage.get(plan.id) || null);
      }),
      nextOffset: plans.length > limit ? offset + limit : null,
    });
  });

  router.add('POST', '/api/plans', (c) => {
    const { db, user, body } = c;
    const invalid = planInputError(body);
    if (invalid) return sendError(c.res, 400, invalid);
    if (typeof body.title!=='string'||!body.title.trim()||body.title.length>120) return sendError(c.res, 400, '请填写120字以内计划标题');
    if(!['phase','cycle','task',undefined].includes(body.kind))return sendError(c.res,400,'计划类型不正确');
    if(['startAt','dueAt'].some(k=>body[k]!=null&&(!Number.isFinite(body[k])||!Number.isFinite(new Date(body[k]).getTime()))))return sendError(c.res,400,'日期不正确');
    if(body.startAt!=null&&body.dueAt!=null&&body.dueAt<body.startAt)return sendError(c.res,400,'结束时间不能早于开始');
    if(body.parentId&&body.kind!=='cycle')return sendError(c.res,400,'只有阶段可以指定父计划');
    const assigneeId = body.assigneeId || user.id;
    if(user.role==='supervisor'&&assigneeId!==user.id&&!userRepo.canBind(db,user.id,assigneeId))return sendError(c.res,409,'平台合作授权不可用或服务人数额度已满');
    const assignee = userRepo.byId(db, assigneeId);
    if (!assignee || assignee.status === 0) return sendError(c.res, 400, '被指派者不存在或已停用');
    if (assigneeId !== user.id && user.role !== 'admin' && !(user.role === 'supervisor' && userRepo.activeSuperviseeIds(db, user.id).includes(assigneeId))) return sendError(c.res, 403, '不能指派给该用户');
    const kind = body.kind || 'task';

    // 周期子计划：必须挂在某个长期计划下
    if (kind === 'cycle') {
      if (!body.parentId) return sendError(c.res, 400, '请选择所属的长期计划');
      const parent = planRepo.byId(db, body.parentId);
      if (!parent || parent.kind !== 'phase' || parent.creator_id !== user.id || parent.status !== 'active') return sendError(c.res, 400, '所属长期计划不可添加阶段');
      if (!lifecycle.writable(db, parent)) return sendError(c.res,409,'所属合作已结束，旧目标仅供查阅');
      if(assigneeId!==parent.assignee_id)return sendError(c.res,400,'阶段执行人必须与长期计划一致');
      if (!body.startAt || !body.dueAt) return sendError(c.res, 400, '子计划需要开始与结束日期');
      if (!body.dailyContent) return sendError(c.res, 400, '请填写每天要做的内容');
      const days = buildDays(body.startAt, body.dueAt, body.dailyContent);
      if (!days.length) return sendError(c.res, 400, '子计划日期范围不正确');
      if (days.length > 120) return sendError(c.res, 400, '一个子计划最多 120 天，请拆分');
      let plan;
      try {
        db.exec('BEGIN IMMEDIATE');
        if (!lifecycle.writable(db, planRepo.byId(db, parent.id))) {
          db.exec('ROLLBACK'); return sendError(c.res,409,'所属目标或合作已结束');
        }
        if (lifecycle.overlappingStage(db, parent.id, body.startAt, body.dueAt)) {
          db.exec('ROLLBACK'); return sendError(c.res,409,'阶段日期与已有待接受或进行中的阶段重叠，请调整日期');
        }
        plan = planRepo.insert(db, {
          title: body.title,
          description: parent.planning_mode==='rolling'?[body.dailyContent,body.description].filter(Boolean).join('\n'):(body.description || body.dailyContent || ''),
          creatorId: user.id,
          assigneeId,
          parentId: parent.id,
          kind,
          startAt: body.startAt,
          dueAt: body.dueAt,
          remindBeforeMinutes: body.remindBeforeMinutes ?? 30,
          remindHour: clampHour(body.remindHour),
          status: user.id===assigneeId?'active':'proposed',
          createdAt: Date.now(),
        });
        if(parent.planning_mode!=='rolling')planRepo.insertDays(db, plan.id, days);
        if(plan.status==='proposed')daySignal(db,plan,plan.assignee_id,'收到新阶段，请确认后开始');
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
      sendJson(c.res, 200, { plan: planRepo.toPlan(plan), days: planRepo.listDays(db, plan.id).map(day => planRepo.toDay(day)) });
      return;
    }

    if (kind === 'phase') {
      if (body.dueAt && body.startAt && body.dueAt <= body.startAt) return sendError(c.res, 400, '结束时间需晚于开始时间');
      const plan = planRepo.insert(db, {
        title: body.title,
        description: body.description || '',
        creatorId: user.id,
        assigneeId,
        parentId: null,
        kind: 'phase',
        startAt: body.startAt ?? null,
        dueAt: body.dueAt ?? null,
        remindBeforeMinutes: body.remindBeforeMinutes ?? 30,
        status: user.id===assigneeId?'active':'proposed',
        createdAt: Date.now(),
      });
      sendJson(c.res, 200, { plan: planRepo.toPlan(plan) });
      return;
    }

    // 普通任务型计划（兼容原行为）
    const plan = planRepo.insert(db, {
      title: body.title,
      description: body.description || '',
      creatorId: user.id,
      assigneeId,
      parentId: body.parentId || null,
      kind: 'task',
      startAt: body.startAt ?? null,
      dueAt: body.dueAt ?? null,
      remindBeforeMinutes: body.remindBeforeMinutes ?? 30,
      status: user.id===assigneeId?'active':'proposed',
      createdAt: Date.now(),
    });
    sendJson(c.res, 200, { plan: planRepo.toPlan(plan) });
  });

  router.add('PUT', '/api/plans/:id', (c) => {
    const { db, user, params, body } = c;
    const p = planRepo.byId(db, params.id);
    if (!p) return sendError(c.res, 404, '计划不存在');
    if (!scope.canEdit(db, user, p)) return sendError(c.res, 403, '无权操作该计划');
    if (p.status === 'archived') return sendError(c.res,409,'已归档计划仅供查阅');
    if(p.creator_id!==user.id && user.role!=='admin')return sendError(c.res,403,'请向监督者提出调整建议');
    if(p.creator_id!==p.assignee_id)return sendError(c.res,409,'已发送的约定不可直接改写，请归档后发送调整后的计划');
    const invalid = planInputError(body);
    if (invalid) return sendError(c.res, 400, invalid);
    const startAt = body.startAt === undefined ? p.start_at : body.startAt;
    const dueAt = body.dueAt === undefined ? p.due_at : body.dueAt;
    if (startAt != null && dueAt != null && dueAt < startAt) return sendError(c.res, 400, '结束时间不能早于开始');
    if((body.assigneeId!==undefined&&body.assigneeId!==p.assignee_id)||(p.kind==='cycle'&&((body.startAt!==undefined&&body.startAt!==p.start_at)||(body.dueAt!==undefined&&body.dueAt!==p.due_at))))return sendError(c.res,400,'请新建计划调整执行人或阶段日期，保留历史记录');
    const assigneeId = body.assigneeId !== undefined ? body.assigneeId : p.assignee_id;
    const assignee = userRepo.byId(db, assigneeId);
    if (!assignee || assignee.status === 0) return sendError(c.res, 400, '被指派者不存在或已停用');
    if (assigneeId !== p.assignee_id && user.role !== 'admin' && !(user.role === 'supervisor' && userRepo.activeSuperviseeIds(db, user.id).includes(assigneeId))) return sendError(c.res, 403, '不能指派给该用户');
    const plan = planRepo.update(db, p.id, {
      title: body.title ?? p.title,
      description: body.description ?? p.description,
      assigneeId,
      startAt: body.startAt !== undefined ? body.startAt : p.start_at,
      dueAt: body.dueAt !== undefined ? body.dueAt : p.due_at,
      remindBeforeMinutes: body.remindBeforeMinutes !== undefined ? body.remindBeforeMinutes : p.remind_before_minutes,
      status: p.status,
    });
    sendJson(c.res, 200, { plan: planRepo.toPlan(plan) });
  });

  router.add('POST', '/api/plans/:id/archive', (c) => {
    const { db, user, params } = c;
    const p = planRepo.byId(db, params.id);
    if (!p) return sendError(c.res, 404, '计划不存在');
    if (!scope.canEdit(db, user, p)) return sendError(c.res, 403, '无权操作该计划');
    if (p.parent_id && planRepo.byId(db,p.parent_id)?.status === 'proposed') return sendError(c.res,409,'请从长期目标撤销整套待接受计划');
    planRepo.archive(db, params.id);
    sendJson(c.res, 200, { ok: true });
  });

  router.add('PUT', '/api/plans/:id/review', (c) => {
    const { db, user, params, body } = c;
    const plan = planRepo.byId(db, params.id);
    if (!plan) return sendError(c.res, 404, '计划不存在');
    if (plan.kind === 'cycle' || plan.parent_id) return sendError(c.res, 400, '周期子计划不单独评价，请评价所属服务计划');
    if (user.role !== 'supervisee' || plan.assignee_id !== user.id) return sendError(c.res, 403, '只有该计划的执行人可以评价服务');
    const supervisor = userRepo.byId(db, plan.creator_id);
    if (!supervisor || supervisor.role !== 'supervisor') return sendError(c.res, 400, '该计划不是监督者提供的服务');
    const rating = Number(body.rating);
    if(!serviceEligible(db,plan))return sendError(c.res,400,'服务结束且有确认交付后才能评价');
    const content = String(body.content || '').trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return sendError(c.res, 400, '评分必须是 1 到 5 星');
    if (content.length > 500) return sendError(c.res, 400, '评价内容最多 500 字');
    let review;
    let metrics;
    try {
      db.exec('BEGIN IMMEDIATE');
      review = reviewRepo.upsert(db, { planId: plan.id, reviewerId: user.id, supervisorId: supervisor.id, rating, content, now: Date.now() });
      metrics = reviewRepo.refreshSupervisorMetrics(db, supervisor.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res, 200, { review: reviewRepo.toReview(review), supervisor: metrics });
  });

  router.add('PUT', '/api/plans/:id/stage-review/self', (c) => {
    const context = stageContext(c);
    if (!context) return;
    if (!stageEnded(c.db, context.cycle)) return sendError(c.res, 400, '阶段结束后才能提交复盘');
    if (c.user.role !== 'admin' && c.user.id !== context.cycle.assignee_id) return sendError(c.res, 403, '只有被监督者可以提交自我复盘');
    const summary = stageText(c.body.summary, 600);
    if (!summary) return sendError(c.res, 400, '请填写本阶段总结');
    const review = phaseReviewRepo.saveSelf(c.db, {
      ...context.data,
      summary,
      difficulty: stageText(c.body.difficulty, 300),
      helpfulMethod: stageText(c.body.helpfulMethod, 300),
      nextAction: stageText(c.body.nextAction, 40),
      now: Date.now(),
    });
    sendJson(c.res, 200, { stageReview: phaseReviewRepo.toStageReview(review, c.user) });
  });

  router.add('PUT', '/api/plans/:id/stage-review/supervisor', (c) => {
    const context = stageContext(c);
    if (!context) return;
    if (!stageEnded(c.db, context.cycle)) return sendError(c.res, 400, '阶段结束后才能提交评价');
    if (c.user.role !== 'admin' && c.user.id !== context.parent.creator_id) return sendError(c.res, 403, '只有监督者可以提交阶段评价');
    const observation = stageText(c.body.observation, 600);
    if (!observation) return sendError(c.res, 400, '请填写观察到的具体变化');
    const allowed = ['明显进步', '有所进步', '基本稳定', '暂无明显变化', '需要调整目标', '双方意见不一致'];
    const resultLabel = allowed.includes(c.body.resultLabel) ? c.body.resultLabel : '基本稳定';
    const review = phaseReviewRepo.saveSupervisor(c.db, {
      ...context.data,
      observation,
      progress: stageText(c.body.progress, 300),
      suggestion: stageText(c.body.suggestion, 300),
      resultLabel,
      recommendNext: stageText(c.body.recommendNext, 40),
      now: Date.now(),
    });
    sendJson(c.res, 200, { stageReview: phaseReviewRepo.toStageReview(review, c.user) });
  });

  router.add('POST', '/api/plans/:id/stage-review/confirm', (c) => {
    const context = stageContext(c);
    if (!context) return;
    if (!stageEnded(c.db, context.cycle)) return sendError(c.res,409,'阶段尚未到期、未全部确认，或已归档；不能确认复盘');
    const row = phaseReviewRepo.byCycleId(c.db, context.cycle.id);
    if (!row || !row.self_submitted_at || !row.supervisor_submitted_at) return sendError(c.res, 400, '双方完成评价后才能确认');
    let role = c.user.role;
    if (role === 'admin') role = c.body.asRole === 'supervisor' ? 'supervisor' : 'supervisee';
    if (role === 'supervisee' && c.user.role !== 'admin' && c.user.id !== context.cycle.assignee_id) return sendError(c.res, 403, '无权确认');
    if (role === 'supervisor' && c.user.role !== 'admin' && c.user.id !== context.parent.creator_id) return sendError(c.res, 403, '无权确认');
    let review;
    try {
      review = phaseReviewRepo.confirm(c.db, context.cycle.id, role, Date.now(), c.body.revision);
    } catch (error) {
      if (error.code === 'review_revision_conflict') return sendError(c.res, 409, error.message);
      throw error;
    }
    sendJson(c.res, 200, { stageReview: phaseReviewRepo.toStageReview(review, c.user) });
  });

  function stageContext(c) {
    const cycle = planRepo.byId(c.db, c.params.id);
    if (!cycle || cycle.kind !== 'cycle' || !cycle.parent_id) { sendError(c.res, 404, '阶段不存在'); return null; }
    if (!scope.canAccessPlan(c.db, c.user, cycle)) { sendError(c.res, 403, '无权访问该阶段'); return null; }
    const parent = planRepo.byId(c.db, cycle.parent_id);
    if (!parent) { sendError(c.res, 404, '长期计划不存在'); return null; }
    if(phaseReviewRepo.byCycleId(c.db,cycle.id)?.locked_at && !c.req?.url?.endsWith('/confirm')) { sendError(c.res,409,'双方已确认的阶段记录不能改写');return null; }
    return { cycle, parent, data: { cyclePlanId: cycle.id, parentPlanId: parent.id, superviseeId: cycle.assignee_id, supervisorId: parent.creator_id } };
  }

  function stageText(value, max) {
    return String(value || '').trim().slice(0, max);
  }

  function stageEnded(db, cycle) {
    return lifecycle.readyForReview(db, cycle);
  }

  // ---------- 每日打卡 ----------
  router.add('GET', '/api/plans/:id/days', (c) => {
    const { db, user, params } = c;
    const p = planRepo.byId(db, params.id);
    if (!p) return sendError(c.res, 404, '计划不存在');
    if (!scope.canAccessPlan(db, user, p)) return sendError(c.res, 403, '无权访问该计划');
    const comments = planRepo.dayComments(db, params.id);
    const items = planRepo.dayItems(db, params.id);
    sendJson(c.res, 200, { days: planRepo.listDays(db, params.id).map((day) => planRepo.toDay(day, comments.get(day.id) || [], items.get(day.id) || [])) });
  });

  router.add('POST', '/api/plans/:id/days/:dayId/comments', (c) => {
    const { db, user, params, body } = c;
    const plan = planRepo.byId(db, params.id);
    const day = planRepo.dayById(db, params.dayId);
    if (!plan || !day || day.plan_id !== plan.id) return sendError(c.res, 404, '打卡日不存在');
    if (!scope.canAccessPlan(db, user, plan)) return sendError(c.res, 403, '无权访问该记录');
    if (user.id !== plan.assignee_id && user.id !== plan.creator_id) return sendError(c.res, 403, '只有监督双方可以留言');
    if (!lifecycle.writable(db, plan)) return sendError(c.res,409,'计划未接受或已结束，历史记录仅供查阅');
    const content = String((body || {}).content || '').trim().slice(0, 300);
    const mood = ['happy', 'calm', 'tired', 'tough', 'cheer'].includes((body || {}).mood) ? body.mood : '';
    if (!content && !mood) return sendError(c.res, 400, '请选择一个状态或留一句话');
    const comment = planRepo.addDayComment(db, { dayId: day.id, planId: plan.id, authorId: user.id, authorRole: user.role, content, mood, createdAt: Date.now() });
    sendJson(c.res, 200, { comment });
  });

  router.add('POST', '/api/plans/:id/days/:dayId/checkin', (c) => {
    const { db, user, params, body } = c;
    const plan = planRepo.byId(db, params.id);
    const day = planRepo.dayById(db, params.dayId);
    if (!plan || !day || day.plan_id !== plan.id) return sendError(c.res, 404, '打卡日不存在');
    if (!scope.canAccessPlan(db, user, plan)) return sendError(c.res, 403, '无权操作该计划');
    if (user.id !== plan.assignee_id) return sendError(c.res, 403, '只有被监督者可以提交打卡');
    if(plan.status!=='active')return sendError(c.res,409,'仅进行中的计划可打卡');
    if(day.checkin_state==='cancelled')return sendError(c.res,409,'双方已确认休息，无需打卡');
    if(day.day_date>localDay())return sendError(c.res,400,'尚未到这一天，不能提前打卡');
    if (day.checkin_state === 'submitted') return sendError(c.res, 400, '这次打卡正在等待监督者确认');
    if (day.checkin_state === 'approved') return sendError(c.res, 400, '这次打卡已经确认');
    const incomplete = planRepo.incompleteDayItemCount(db, day.id);
    const itemCount = planRepo.dayItemCount(db, day.id);
    if (incomplete && itemCount > 1) return sendError(c.res, 400, `还有 ${incomplete} 项当天任务未完成`);
    const note = String((body || {}).note || '').trim().slice(0,1000);
    const mood = ['😊', '😌', '😤', '😴', '💪'].includes((body || {}).mood) ? body.mood : '';
    let result;
    try{db.exec('BEGIN IMMEDIATE');if(itemCount===1)planRepo.completeDayItems(db,day.id);result=planRepo.submitDay(db,day.id,note,mood);activity.record(db,{actorId:user.id,subjectId:plan.assignee_id,type:'plan_checkin_submitted',entityType:'plan_day',entityId:day.id,summary:day.content});
      daySignal(db,plan,plan.creator_id,'收到打卡，等待你确认',day.id);db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
    sendJson(c.res, 200, { day: planRepo.toDay(result, [], planRepo.dayItems(db, plan.id).get(result.id) || []) });
  });

  router.add('POST', '/api/plans/:id/days/:dayId/items/:itemId/toggle', (c) => {
    const { db, user, params, body } = c;
    const plan = planRepo.byId(db, params.id);
    const day = planRepo.dayById(db, params.dayId);
    const item = planRepo.dayItemById(db, params.itemId);
    if (!plan || !day || !item || item.removed_at || day.plan_id !== plan.id || item.day_id !== day.id) return sendError(c.res, 404, '当天任务不存在');
    if (!scope.canAccessPlan(db, user, plan) || user.id !== plan.assignee_id) return sendError(c.res, 403, '只有执行人可以勾选当天任务');
    if (plan.status !== 'active' || day.day_date > localDay()) return sendError(c.res, 409, '尚未开始或当天尚未到达');
    if(day.checkin_state==='cancelled')return sendError(c.res,409,'双方已确认休息');
    if (['submitted', 'approved'].includes(day.checkin_state)) return sendError(c.res, 409, '打卡已提交，不能再修改任务');
    const done = body && body.done !== undefined ? !!body.done : item.status !== 'done';
    if (item.status === (done ? 'done' : 'pending')) return sendJson(c.res, 200, { item: planRepo.toDayItem(item) });
    let updated;
    try {
      db.exec('BEGIN IMMEDIATE');
      updated = planRepo.setDayItemStatus(db, item.id, done ? 'done' : 'pending');
      if (done) activity.record(db,{actorId:user.id,subjectId:plan.assignee_id,type:'plan_item_completed',entityType:'plan_day_item',entityId:item.id,summary:item.title,metadata:{planDayId:day.id}});
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res, 200, { item: planRepo.toDayItem(updated) });
  });

  router.add('POST', '/api/plans/:id/days/:dayId/withdraw', (c) => {
    const { db, user, params } = c;
    const plan = planRepo.byId(db, params.id);
    const day = planRepo.dayById(db, params.dayId);
    if (!plan || !day || day.plan_id !== plan.id) return sendError(c.res, 404, '打卡日不存在');
    if (!scope.canAccessPlan(db, user, plan)) return sendError(c.res, 403, '无权操作该计划');
    if (user.id !== plan.assignee_id) return sendError(c.res, 403, '只有被监督者可以撤回打卡');
    if(plan.status!=='active')return sendError(c.res,409,'计划已结束，不能撤回');
    if (day.checkin_state !== 'submitted') return sendError(c.res, 400, '只有待确认的打卡可以撤回');
    sendJson(c.res, 200, { day: planRepo.toDay(planRepo.withdrawDay(db, day.id)) });
  });

  router.add('POST', '/api/plans/:id/days/:dayId/review', (c) => {
    const { db, user, params, body } = c;
    const plan = planRepo.byId(db, params.id);
    const day = planRepo.dayById(db, params.dayId);
    if (!plan || !day || day.plan_id !== plan.id) return sendError(c.res, 404, '打卡日不存在');
    if (!scope.canAccessPlan(db, user, plan)) return sendError(c.res, 403, '无权操作该计划');
    if (user.id !== plan.creator_id) return sendError(c.res, 403, '只有监督者可以确认打卡');
    if(plan.status!=='active')return sendError(c.res,409,'计划未开始或已结束');
    if (day.checkin_state !== 'submitted') return sendError(c.res, 400, '这次打卡不在待确认状态');
    const decision = body && body.decision;
    if (!['approved', 'rejected'].includes(decision)) return sendError(c.res, 400, '请选择确认或驳回');
    const reviewNote = String((body || {}).reviewNote || '').trim().slice(0, 300);
    if (decision === 'rejected' && !reviewNote) return sendError(c.res, 400, '驳回时请填写原因');
    let result;
    try{db.exec('BEGIN IMMEDIATE');result=planRepo.reviewDay(db,day.id,user.id,decision,reviewNote);activity.record(db,{actorId:user.id,subjectId:plan.assignee_id,type:decision==='approved'?'plan_checkin_confirmed':'plan_checkin_rejected',entityType:'plan_day',entityId:day.id,summary:day.content});
      daySignal(db,plan,plan.assignee_id,decision==='approved'?'打卡已确认':'打卡需要补充，请查看原因',day.id);db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
    sendJson(c.res, 200, { day: planRepo.toDay(result) });
  });
  router.add('POST','/api/plans/:id/days/:dayId/help',c=>{
    const p=planRepo.byId(c.db,c.params.id),d=planRepo.dayById(c.db,c.params.dayId);
    if(!p||!d||d.plan_id!==p.id||!scope.canAccessPlan(c.db,c.user,p))return sendError(c.res,404,'记录不存在');
    if(p.status!=='active')return sendError(c.res,409,'计划未开始或已结束');
    const text=String(c.body.content||'').trim().slice(0,500);
    if(!text)return sendError(c.res,400,'请说明困难或处理建议');
    const reply=c.user.id===p.creator_id;
    if(!reply&&c.user.id!==p.assignee_id)return sendError(c.res,403,'仅监督双方可处理');
    if(reply&&!d.help_note)return sendError(c.res,400,'没有待处理的困难');
    try {
      c.db.exec('BEGIN IMMEDIATE');
      if(reply)c.db.prepare('UPDATE plan_days SET help_reply=? WHERE id=?').run(text,d.id);
      else c.db.prepare("UPDATE plan_days SET help_note=?,help_reply='' WHERE id=?").run(text,d.id);
      daySignal(c.db,p,reply?p.assignee_id:p.creator_id,reply?'监督者回复了你的困难':'执行人遇到困难，请跟进',d.id);
      c.db.exec('COMMIT');
    } catch (error) {
      try { c.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res,200,{ok:true});
  });
  router.add('GET','/api/days/:id',c=>{
    const day=planRepo.dayById(c.db,c.params.id),plan=day&&planRepo.byId(c.db,day.plan_id);
    if(!plan||!scope.canAccessPlan(c.db,c.user,plan))return sendError(c.res,404,'记录不存在');
    sendJson(c.res,200,{day:planRepo.toDay(day,[],planRepo.dayItems(c.db,plan.id).get(day.id)||[]),plan:planRepo.toPlan(plan)});
  });

  // ---------- 常用内容模板（监督者维护） ----------
  router.add('GET', '/api/plan-templates', (c) => {
    if (c.user.role !== 'supervisor') return sendError(c.res, 403, '无权限');
    sendJson(c.res, 200, { templates: planRepo.listTemplates(c.db, c.user.id).map((t) => ({
      id: t.id, title: t.title, content: t.content, createdAt: t.created_at,
    })) });
  });
  router.add('POST', '/api/plan-templates', (c) => {
    const { db, user, body } = c;
    if (user.role !== 'supervisor') return sendError(c.res, 403, '无权限');
    if (typeof body.title !== 'string' || typeof body.content !== 'string') return sendError(c.res, 400, '模板标题和内容请填写文字');
    const title = body.title.trim();
    const content = body.content.trim();
    if (!title || !content) return sendError(c.res, 400, '模板标题和内容都要填');
    const t = planRepo.insertTemplate(db, user.id, title, content);
    sendJson(c.res, 200, { template: { id: t.id, title: t.title, content: t.content, createdAt: t.created_at } });
  });
  router.add('DELETE', '/api/plan-templates/:id', (c) => {
    const { db, user, params } = c;
    if (user.role !== 'supervisor') return sendError(c.res, 403, '无权限');
    if (!planRepo.deleteTemplate(db, params.id, user.id)) return sendError(c.res, 404, '模板不存在或无权删除');
    sendJson(c.res, 200, { ok: true });
  });
}

// 按本地日期生成 start..due(含当天) 的打卡日列表
function clampHour(h) {
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(23, Math.max(0, Math.round(n)));
  return 20;
}

function normalizeBundleCycles(body) {
  const source = Array.isArray(body.cycles) && body.cycles.length
    ? body.cycles
    : [{ title: body.cycleTitle || '第1阶段', startAt: body.startAt, dueAt: body.dueAt, dailyContent: body.dailyContent, remindHour: body.remindHour }];
  if (source.length > 12) return null;
  const seenDates = new Set();
  const cycles = [];
  for (let index = 0; index < source.length; index++) {
    let item = source[index] || {};
    if (item.startDate !== undefined || item.endDate !== undefined) {
      const { validDate } = require('../plan-import');
      if (!validDate(item.startDate) || !validDate(item.endDate)) return null;
      item = { ...item, startAt: +new Date(item.startDate+'T00:00:00'), dueAt: +new Date(item.endDate+'T23:59:59') };
    }
    const title = String(item.title || `第${index + 1}阶段`).trim();
    const content = String(item.rhythm || item.dailyContent || '').trim();
    if (!title || title.length > 120 || !content || content.length > 500 || !Number.isFinite(item.startAt) || !Number.isFinite(item.dueAt) || item.dueAt < item.startAt) return null;
    const calendar = buildDays(item.startAt, item.dueAt, content);
    if (!calendar.length || calendar.length > 120 || calendar.some(day => seenDates.has(day.day_date))) return null;
    calendar.forEach(day => seenDates.add(day.day_date));
    if (seenDates.size > 365) return null;
    const days = body.planningMode==='rolling'?[]:buildDays(item.startAt, item.dueAt, content, item.dailyItems);
    if (body.planningMode!=='rolling' && !days.length) return null;
    if(body.planningMode==='rolling' && item.dailyItems?.length)return null;
    cycles.push({ title, rhythm:content, startAt: item.startAt, dueAt: item.dueAt, remindHour: clampHour(item.remindHour), days });
  }
  return cycles;
}

function buildDays(startAt, dueAt, content, dailyItems) {
  const custom = new Map();
  if (dailyItems !== undefined) {
    if (!Array.isArray(dailyItems)) return [];
    for (const item of dailyItems) {
      if (item?.rest === true) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) || custom.has(item.date) || (item.tasks !== undefined && (!Array.isArray(item.tasks) || item.tasks.length))) return [];
        custom.set(item.date, { rest: true });
        continue;
      }
      let schedule;
      try { schedule = normalizeSchedule(item?.schedule); } catch { return []; }
      const itemContent = String(item && item.content || '').trim();
      const tasks = schedule ? schedule.slots.map(slotTitle) : normalizeDayTasks(item && item.tasks !== undefined ? item.tasks : [itemContent]);
      if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) || !itemContent || itemContent.length > 500 || !tasks || custom.has(item.date)) return [];
      custom.set(item.date, { content: itemContent, tasks, schedule });
    }
  }
  const out = [];
  const d = new Date(startAt);
  d.setHours(0, 0, 0, 0);
  const end = new Date(dueAt);
  end.setHours(23, 59, 59, 999);
  if (!Number.isFinite(d.getTime()) || !Number.isFinite(end.getTime()) || end < d) return out;
  const pad = (n) => String(n).padStart(2, '0');
  let seq = 1;
  const visited = new Set();
  while (d.getTime() <= end.getTime() && seq <= 370) {
    const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const item = custom.get(date);
    visited.add(date);
    if (!item?.rest) out.push({
      id: crypto.randomUUID(),
      seq,
      day_date: date,
      content: item?.content || String(content || '').trim(),
      items: item?.tasks || [String(content || '').trim()],
      schedule: item?.schedule,
      createdAt: Date.now(),
    });
    seq++;
    d.setDate(d.getDate() + 1);
  }
  if (d.getTime() <= end.getTime()) return [];
  if (custom.size && [...custom.keys()].some((date) => !visited.has(date))) return [];
  return out;
}

function normalizeDayTasks(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.length > 12) return null;
  const tasks = value.map((task) => String(task || '').trim());
  return tasks.every((task) => task && task.length <= 200) ? tasks : null;
}

module.exports = { register };

function localDay(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function serviceEligible(db,p){
  if(p.status!=='archived' && !(p.status==='active'&&p.due_at&&p.due_at<Date.now()))return false;
  if(db.prepare("SELECT id FROM plans WHERE parent_id=? AND status IN ('active','proposed') AND (due_at IS NULL OR due_at>=?) LIMIT 1").get(p.id,Date.now()))return false;
  return !!db.prepare("SELECT id FROM tasks WHERE plan_id=? AND status='done' LIMIT 1").get(p.id) ||
    !!db.prepare("SELECT d.id FROM plan_days d JOIN plans c ON c.id=d.plan_id WHERE (c.id=? OR c.parent_id=?) AND d.checkin_state='approved' LIMIT 1").get(p.id,p.id);
}
