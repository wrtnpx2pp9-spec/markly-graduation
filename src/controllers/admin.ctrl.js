'use strict';
/**
 * 管理员控制器：管理监督者/被监督者账号（创建、编辑、启停、重置密码、删除、监督关系），平台总览。
 * 所有接口仅 admin 角色可访问（由 router 的 roles 授权）。
 */
const userRepo = require('../repo/user.repo');
const planRepo = require('../repo/plan.repo');
const taskRepo = require('../repo/task.repo');
const auditRepo = require('../repo/audit.repo');
const sessionRepo = require('../repo/session.repo');
const cooperationRepo = require('../repo/cooperation.repo');
const displayName = require('../display-name');
const portrait = require('../user-portrait');
const activity = require('../repo/activity.repo');
const { sendJson, sendError } = require('../router');
const overviewCache = new WeakMap();
const OVERVIEW_CACHE_MS = 15000;

function register(router, deps) {
  const { security, wechat } = deps;
  // 统一给管理员接口加 admin 角色门禁，避免遗漏
  const adm = (method, pattern, handler) => router.addRole(method, pattern, handler, ['admin']);

  adm('GET', '/api/admin/overview', handleOverview);

  adm('GET', '/api/admin/audit', (c) => {
    sendJson(c.res, 200, { logs: auditRepo.list(c.db, c.query.limit).map(auditRepo.toAudit) });
  });

  adm('GET', '/api/admin/health', (c) => {
    const integrity = c.db.prepare('PRAGMA integrity_check').get();
    const outbox = c.db.prepare("SELECT status, COUNT(*) AS count FROM notification_outbox GROUP BY status").all();
    const queue = c.db.prepare("SELECT COUNT(*) AS backlog,MIN(created_at) AS oldestCreatedAt FROM notification_outbox WHERE status IN ('pending','failed','sending')").get();
    sendJson(c.res, 200, { ok: integrity.integrity_check === 'ok', integrity: integrity.integrity_check, outbox, queue: { ...queue, oldestAgeSeconds: queue.oldestCreatedAt ? Math.max(0,Math.floor((Date.now()-queue.oldestCreatedAt)/1000)) : 0, worker: require('../notify').outboxStats(c.db) } });
  });

  adm('GET', '/api/admin/users', (c) => {
    const filter = {};
    if (c.query.role) filter.role = c.query.role;
    if (c.query.status !== undefined) filter.status = c.query.status === '1';
    if (c.query.q) filter.q = c.query.q;
    const limit = Math.min(500, Math.max(1, Number.parseInt(c.query.limit, 10) || 200));
    const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(c.query.offset, 10) || 0));
    const users = userRepo.listWhere(c.db, { ...filter, limit: limit + 1, offset });
    const page=users.slice(0,limit),ids=page.map(u=>u.id),slots=ids.map(()=>'?').join(','),total=userRepo.countWhere(c.db,filter);
    const profiles=ids.length?new Map(c.db.prepare(`SELECT user_id,published FROM user_profiles WHERE user_id IN (${slots})`).all(...ids).map(r=>[r.user_id,!!r.published])):new Map();
    const relations=new Map(),supervisors=new Map(),relationCounts=new Map();
    if(ids.length)for(const row of c.db.prepare(`SELECT r.supervisee_id,r.supervisor_id,u.username,u.display_name,u.status FROM supervision_relations r JOIN users u ON u.id=r.supervisor_id WHERE r.status='active' AND r.supervisee_id IN (${slots}) ORDER BY r.created_at,r.supervisor_id`).all(...ids)){if(!relations.has(row.supervisee_id))relations.set(row.supervisee_id,[]);relations.get(row.supervisee_id).push(row.supervisor_id);if(!supervisors.has(row.supervisee_id))supervisors.set(row.supervisee_id,[]);supervisors.get(row.supervisee_id).push({id:row.supervisor_id,username:row.username,displayName:row.display_name,status:row.status});}
    const supervisorIds=page.filter(u=>u.role==='supervisor').map(u=>u.id),supSlots=supervisorIds.map(()=>'?').join(',');
    if(supervisorIds.length)for(const row of c.db.prepare(`SELECT supervisor_id,COUNT(*) AS count FROM supervision_relations WHERE status='active' AND supervisor_id IN (${supSlots}) GROUP BY supervisor_id`).all(...supervisorIds))relationCounts.set(row.supervisor_id,row.count);
    sendJson(c.res,200,{users:page.map(u=>({...userRepo.toPublic(u),agreementRef:u.agreement_ref||'',cooperationNote:u.cooperation_note||'',cooperationReviewedBy:u.cooperation_reviewed_by,cooperationReviewedAt:u.cooperation_reviewed_at,directoryPublished:profiles.get(u.id)||false,supervisorIds:relations.get(u.id)||[],supervisors:supervisors.get(u.id)||[],activeSuperviseeCount:relationCounts.get(u.id)||0})),total,nextOffset:users.length>limit?offset+limit:null});
  });
  adm('GET', '/api/admin/users/:id/portrait', (c) => {
    const user = userRepo.byId(c.db, c.params.id);
    if (!user) return sendError(c.res, 404, '用户不存在');
    sendJson(c.res, 200, { user: { id:user.id, displayName:user.display_name, role:user.role }, portrait:portrait.get(c.db, user.id) });
  });
  adm('GET', '/api/admin/users/:id/activity', (c) => {
    const user = userRepo.byId(c.db, c.params.id);
    if (!user) return sendError(c.res, 404, '用户不存在');
    sendJson(c.res, 200, { events: activity.listForUser(c.db, user.id, c.query.limit) });
  });

  adm('PUT','/api/admin/users/:id/cooperation',c=>{
    const user=userRepo.byId(c.db,c.params.id),b=c.body;
    if(!user||user.role!=='supervisor')return sendError(c.res,404,'平台合作监督者不存在');
    if(!['pending','active','paused','ended'].includes(b.state)||!Number.isInteger(b.capacity)||b.capacity<0||b.capacity>1000||typeof b.published!=='boolean')return sendError(c.res,400,'请选择合作状态、展示状态及0至1000的整数人数额度');
    if(typeof b.agreementRef!=='string'||b.agreementRef.length>200||typeof b.note!=='string'||!b.note.trim()||b.note.length>1000)return sendError(c.res,400,'请填写审核依据，协议记录最多200字，审核说明最多1000字');
    if(b.state==='active'&&(!b.agreementRef.trim()||b.capacity<1||user.status!==1))return sendError(c.res,400,'启用服务前须确认账号启用、登记合作协议记录并分配至少1人额度');
    let updated;
    try{c.db.exec('BEGIN IMMEDIATE');updated=cooperationRepo.save(c.db,user,c.user.id,{...b,agreementRef:b.agreementRef.trim(),note:b.note.trim()});
      deps.notify.deliver(c.db,{userId:user.id,recipientUser:user,kind:'cooperation',title:'平台合作授权已更新',content:`当前状态：${({pending:'待平台审核',active:'已启用服务',paused:'暂停新增服务',ended:'合作已结束'})[b.state]}；平台分配人数：${b.capacity}。详情请查看“我的”。`,linkType:'profile',linkId:user.id});
      c.db.exec('COMMIT');
    }catch(error){try{c.db.exec('ROLLBACK');}catch{}throw error;}
    invalidateOverview(c.db);
    sendJson(c.res,200,{user:updated});
  });
  adm('GET','/api/admin/users/:id/cooperation-history',c=>{
    const rows=c.db.prepare('SELECT * FROM cooperation_events WHERE supervisor_id=? ORDER BY created_at DESC LIMIT 100').all(c.params.id);
    sendJson(c.res,200,{events:rows.map(r=>({...r,before:JSON.parse(r.before_json),after:JSON.parse(r.after_json),before_json:undefined,after_json:undefined}))});
  });

  adm('POST', '/api/admin/users', (c) => {
    const { db, body } = c;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const role = body.role;
    const identity = body.identity || role;
    if (!(role==='supervisor'?['mentor','supervisor']:['mentee','supervisee']).includes(identity)) return sendError(c.res,400,'身份与角色不匹配');
    const password = body.password;
    if (!username || !password) return sendError(c.res, 400, '用户名和密码不能为空');
    if (username.length > 64 || typeof password !== 'string' || password.length < 8 || password.length > 256) return sendError(c.res, 400, '用户名最多64字，密码需为8至256字');
    if (!['supervisor', 'supervisee'].includes(role)) return sendError(c.res, 400, '只能创建监督者或被监督者账号');
    if (userRepo.byUsername(db, username)) return sendError(c.res, 400, '用户名已存在');
    const nameError = displayName.validate(body.displayName);
    if (nameError) return sendError(c.res, 400, nameError);
    const nickname = body.displayName.trim();
    if (db.prepare('SELECT 1 FROM users WHERE display_name=?').get(nickname)) return sendError(c.res, 409, '这个昵称已被使用，请换一个');
    const managedByIds = role === 'supervisee' ? (Array.isArray(body.managedByIds) ? body.managedByIds : (body.managedBy ? [body.managedBy] : [])) : [];
    if (managedByIds.some((id) => !isSupervisor(db, id))) return sendError(c.res, 400, '监督关系不正确：所选监督者不存在');
    const accountLevel = role === 'supervisor' ? (body.accountLevel || 'basic') : 'basic';
    if (!userRepo.ACCOUNT_LEVELS[accountLevel]) return sendError(c.res, 400, '账号等级不合法');
    if (body.superviseeLimit !== undefined) return sendError(c.res,400,'请在账号创建后通过合作授权分配人数');
    const capacityOverride = 0;

    const salt = security.genSalt();
    let user;
    try {
      db.exec('BEGIN IMMEDIATE');
      user = userRepo.insert(db, {
        username, role,
        passwordHash: security.hashPassword(password, salt),
        salt,
        displayName: nickname,
        managedBy: managedByIds[0] || null,
        accountLevel,
        capacityOverride,
        status: 1,
        createdAt: Date.now(),
      });
      db.prepare('UPDATE users SET identity=? WHERE id=?').run(identity,user.id);
      user=userRepo.byId(db,user.id);
      if (role === 'supervisee' && managedByIds.length) userRepo.setRelations(db, user.id, managedByIds);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if(error.message==='invalid supervision relation')return sendError(c.res,409,'监督者未获平台授权或人数额度已满');
      throw error;
    }
    invalidateOverview(db);
    sendJson(c.res, 200, { user: userRepo.toPublic(user) });
  });

  adm('PUT', '/api/admin/users/:id', (c) => {
    const { db, params, body } = c;
    const target = userRepo.byId(db, params.id);
    if (!target) return sendError(c.res, 404, '用户不存在');
    if (target.role === 'admin') return sendError(c.res, 403, '不能修改管理员账号');
    const fields = {};
    if (body.displayName !== undefined) {
      const nickname = typeof body.displayName === 'string' ? body.displayName.trim() : body.displayName;
      // Preserve historical names when saving unrelated account settings; new names use the current rule.
      if (nickname !== target.display_name) {
        const nameError = displayName.validate(nickname);
        if (nameError) return sendError(c.res, 400, nameError);
        if (db.prepare('SELECT 1 FROM users WHERE display_name=? AND id<>?').get(nickname,target.id)) return sendError(c.res, 409, '这个昵称已被使用，请换一个');
      }
      fields.displayName = nickname;
    }
    if (body.role !== undefined) {
      if (!['supervisor', 'supervisee'].includes(body.role)) return sendError(c.res, 400, '角色不合法');
      fields.role = body.role;
    }
    if (body.status !== undefined) fields.status = body.status ? 1 : 0;
    if (body.managedBy !== undefined) fields.managedBy = body.managedBy || null;
    const finalRole = fields.role || target.role;
    if (body.identity !== undefined) {
      if (!(finalRole==='supervisor'?['mentor','supervisor']:['mentee','supervisee']).includes(body.identity)) return sendError(c.res,400,'身份与角色不匹配');
      fields.identity=body.identity;
    } else if(finalRole!==target.role) fields.identity=finalRole;
    if (target.role === 'supervisor' && finalRole === 'supervisee' && userRepo.relationCount(db, target.id) > 0) return sendError(c.res, 409, '请先解除该监督者的全部监督关系，再修改角色');
    if (finalRole === 'supervisor') fields.managedBy = null;
    if (fields.managedBy && !isSupervisor(db, fields.managedBy)) return sendError(c.res, 400, '监督关系不正确：所选监督者不存在');
    if (body.accountLevel !== undefined) {
      if (!userRepo.ACCOUNT_LEVELS[body.accountLevel]) return sendError(c.res, 400, '账号等级不合法');
      fields.accountLevel = body.accountLevel;

    }
    if (body.superviseeLimit !== undefined) return sendError(c.res,400,'请通过合作授权调整人数，保留审核记录');
    if (finalRole === 'supervisor' && target.role !== 'supervisor') {
      fields.accountLevel = body.accountLevel || 'basic';
      if (!userRepo.ACCOUNT_LEVELS[fields.accountLevel]) return sendError(c.res, 400, '账号等级不合法');

    }
    if (finalRole === 'supervisee' && target.role !== 'supervisee') {
      fields.accountLevel = 'basic';
      fields.capacityOverride = null;
    }
    const relationIds = finalRole === 'supervisee' && (Array.isArray(body.managedByIds) || body.managedBy !== undefined)
      ? (Array.isArray(body.managedByIds) ? body.managedByIds : (body.managedBy ? [body.managedBy] : []))
      : null;
    if (relationIds && relationIds.some((id) => !isSupervisor(db, id))) return sendError(c.res, 400, '监督关系不正确：所选监督者不存在');
    try {
      db.exec('BEGIN IMMEDIATE');
      userRepo.update(db, target.id, fields);
      if (fields.status === 0 || finalRole !== target.role) sessionRepo.removeAllForUser(db, target.id);
      if(finalRole!==target.role){
        db.prepare("UPDATE users SET cooperation_state='pending',agreement_ref='',capacity_override=0,cooperation_note='',cooperation_reviewed_by=NULL,cooperation_reviewed_at=NULL WHERE id=?").run(target.id);
        const profileRepo=require('../repo/profile.repo');profileRepo.save(db,target.id,{...profileRepo.own(db,target.id),published:false,accepting:false});
        userRepo.closePendingRequests(db,target.id);
      }
      if (relationIds) userRepo.setRelations(db, target.id, relationIds);
      if (finalRole === 'supervisor' && target.role !== 'supervisor') userRepo.setRelations(db, target.id, []);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if(error.message==='invalid supervision relation')return sendError(c.res,409,'监督者未获平台授权或人数额度已满');
      throw error;
    }
    invalidateOverview(db);
    sendJson(c.res, 200, { user: userRepo.toPublic(userRepo.byId(db, target.id)) });
  });

  adm('POST', '/api/admin/users/:id/status', (c) => {
    const { db, params, body } = c;
    const target = userRepo.byId(db, params.id);
    if (!target) return sendError(c.res, 404, '用户不存在');
    if (target.role === 'admin' || target.id === c.user.id) return sendError(c.res, 403, '不能停用管理员或当前账号');
    let updated;
    try {
      db.exec('BEGIN IMMEDIATE');
      updated = userRepo.setStatus(db, target.id, body.active ? 1 : 0);
      if (updated.status === 0) sessionRepo.removeAllForUser(db, target.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    invalidateOverview(db);
    sendJson(c.res, 200, { user: userRepo.toPublic(updated) });
  });

  adm('POST', '/api/admin/users/:id/reset-password', (c) => {
    const { db, params, body } = c;
    const target = userRepo.byId(db, params.id);
    if (!target) return sendError(c.res, 404, '用户不存在');
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) return sendError(c.res, 400, '新密码需为8至256字');
    const salt = security.genSalt();
    const passwordHash = security.hashPassword(body.password, salt);
    let updated;
    try {
      db.exec('BEGIN IMMEDIATE');
      updated = userRepo.resetPassword(db, target.id, passwordHash, salt);
      sessionRepo.removeAllForUser(db, target.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res, 200, { user: userRepo.toPublic(updated) });
  });

  adm('DELETE', '/api/admin/users/:id', async (c) => {
    const { db, params } = c;
    const target = userRepo.byId(db, params.id);
    if (!target) return sendError(c.res, 404, '用户不存在');
    if (target.role === 'admin' || target.id === c.user.id) return sendError(c.res, 403, '不能删除管理员或当前账号');
    try {
      db.exec('BEGIN IMMEDIATE');
      userRepo.removeCascade(db, target.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if(error.message==='invalid supervision relation')return sendError(c.res,409,'监督者未获平台授权或人数额度已满');
      throw error;
    }
    if (wechat && typeof wechat.removeUserInstance === 'function') await wechat.removeUserInstance(target.id);
    invalidateOverview(db);
    sendJson(c.res, 200, { ok: true });
  });

  function isSupervisor(db, id) {
    const u = userRepo.byId(db, id);
    return u && u.role === 'supervisor';
  }
}

function readOverview(db) {
  const now=Date.now(), today=new Date(); today.setHours(0,0,0,0); const todayStart=today.getTime();
  const users = db.prepare("SELECT COUNT(*) AS total, SUM(status=1) AS active, SUM(role='admin') AS admin, SUM(role='supervisor') AS supervisor, SUM(role='supervisee') AS supervisee, SUM(status=0) AS disabled FROM users").get();
  const plans = db.prepare("SELECT COUNT(*) AS total, SUM(status='active') AS active, SUM(status='archived') AS archived FROM plans").get();
  const tasks = db.prepare("SELECT COUNT(*) AS total, SUM(status='pending') AS pending, SUM(status='done') AS done, SUM(status='pending' AND due_at IS NOT NULL AND due_at<?) AS overdue, SUM(status='done' AND done_at>=?) AS doneToday FROM tasks").get(now,todayStart);
  const outbox = db.prepare("SELECT COUNT(*) AS total, SUM(status IN ('pending','failed')) AS pending, SUM(status='sending') AS sending, MAX(attempts) AS maxAttempts FROM notification_outbox").get();
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const checkins=db.prepare("SELECT SUM(d.checkin_state='submitted' AND p.status='active') AS waitingReview, SUM(d.checkin_reviewed_at>=? AND d.checkin_state='approved') AS approvedToday, SUM(d.day_date<? AND d.status='pending' AND d.checkin_state!='submitted' AND p.status='active') AS missed FROM plan_days d JOIN plans p ON p.id=d.plan_id").get(todayStart,dayKey(today));
  const relations=db.prepare("SELECT COUNT(*) AS active, SUM(supervisee_id IN (SELECT id FROM users WHERE status=0)) AS inactiveSide FROM supervision_relations WHERE status='active'").get();
  const unbound=db.prepare("SELECT COUNT(*) AS count FROM users u WHERE u.role='supervisee' AND u.status=1 AND NOT EXISTS (SELECT 1 FROM supervision_relations r WHERE r.supervisee_id=u.id AND r.status='active')").get();
  const unread=db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE is_read=0").get();
  const firstDay=new Date(today);firstDay.setDate(firstDay.getDate()-6);
  const since=firstDay.getTime();
  const dateBuckets=[];
  for(let i=0;i<7;i++){
    const start=new Date(firstDay);start.setDate(start.getDate()+i);
    const end=new Date(start);end.setDate(end.getDate()+1);
    dateBuckets.push({key:dayKey(start),start:start.getTime(),end:end.getTime()});
  }
  // Use the same local day boundaries as the headline counts; SQLite's
  // localtime can use a different time zone from JavaScript on Windows.
  const daily=(table,column,condition='1=1')=>{
    const buckets=dateBuckets.map(()=>`WHEN ${column}>=? AND ${column}<? THEN ?`).join(' ');
    const parameters=dateBuckets.flatMap(bucket=>[bucket.start,bucket.end,bucket.key]);
    return new Map(db.prepare(`SELECT CASE ${buckets} END AS date,COUNT(*) AS n FROM ${table} WHERE ${column}>=? AND ${column}<=? AND ${condition} GROUP BY date`).all(...parameters,since,now).map(r=>[r.date,r.n]));
  };
  const newUsers=daily('users','created_at'),doneTasks=daily('tasks','done_at',"status='done'"),approvedDays=daily('plan_days','checkin_reviewed_at',"checkin_state='approved'");
  const trend=[]; for(let i=6;i>=0;i--){const date=new Date(today);date.setDate(date.getDate()-i);const key=dayKey(date);trend.push({date:key.slice(5),users:newUsers.get(key)||0,tasksDone:doneTasks.get(key)||0,checkins:approvedDays.get(key)||0});}
  const recentUsers = db.prepare('SELECT id, username, role, identity, display_name, status, created_at FROM users ORDER BY created_at DESC, id DESC LIMIT 5').all().map((u) => ({
    id: u.id, username: u.username, role: u.role, identity: userRepo.toPublic(u).identity, displayName: u.display_name, status: u.status, createdAt: u.created_at,
  }));
  return {
    generatedAt: now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    intake: { registrations: db.prepare("SELECT COUNT(*) AS n FROM registration_applications WHERE status='pending'").get().n, certifications: db.prepare("SELECT COUNT(*) AS n FROM certifications c JOIN users u ON u.id=c.user_id WHERE c.status='pending' AND u.role='supervisor'").get().n, requests: db.prepare("SELECT COUNT(*) AS n FROM service_requests WHERE status IN ('discussing','planning','plan_proposed')").get().n },
    users: { total: users.total || 0, active: users.active || 0, admin: users.admin || 0, supervisor: users.supervisor || 0, supervisee: users.supervisee || 0, disabled: users.disabled || 0 },
    plans: { total: plans.total || 0, active:plans.active||0, archived: plans.archived || 0 },
    tasks: { total: tasks.total || 0, pending: tasks.pending || 0, done: tasks.done || 0, doneToday:tasks.doneToday||0, overdue: tasks.overdue || 0 },
    outbox: { total: outbox.total || 0, pending: outbox.pending || 0, sending: outbox.sending || 0, maxAttempts: outbox.maxAttempts || 0 },
    operations:{checkins:{waitingReview:checkins.waitingReview||0,approvedToday:checkins.approvedToday||0,missed:checkins.missed||0},relations:{active:relations.active||0,inactiveSide:relations.inactiveSide||0,unbound:unbound.count||0},notifications:{unread:unread.count||0},trend},
    recentUsers,
  };
}
function invalidateOverview(db) { overviewCache.delete(db); }
function handleOverview(c) {
  const fresh = c.query.fresh === '1';
  const cached = overviewCache.get(c.db);
  if (!fresh && cached && Date.now() - cached.at < OVERVIEW_CACHE_MS) return sendJson(c.res, 200, cached.value);
  const value = readOverview(c.db);
  overviewCache.set(c.db, { at: Date.now(), value });
  sendJson(c.res, 200, value);
}
module.exports = { register, readOverview, invalidateOverview };
