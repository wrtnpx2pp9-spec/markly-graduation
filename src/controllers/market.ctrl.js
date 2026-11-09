'use strict';
const crypto = require('crypto');
const profiles = require('../repo/profile.repo');
const assessments = require('../repo/assessment.repo');
const users = require('../repo/user.repo');
const displayName = require('../display-name');
const phaseReviews = require('../repo/phase-review.repo');
const { sendJson, sendError } = require('../router');
function str(v, max) { return typeof v === 'string' && v.trim().length <= max ? v.trim() : null; }
function assessmentInput(body) {
  const selfPosition = str(body.selfPosition, 300);
  const primaryGoal = str(body.primaryGoal || '', 500);
  const currentSituation = str(body.currentSituation, 1500);
  const preferredRhythm = str(body.preferredRhythm, 300);
  const obstacles = str(body.obstacles || '', 1000);
  const supportPreferences = str(body.supportPreferences || '', 1000);
  const availableMinutes = body.availableMinutes;
  const desiredStartAt = body.desiredStartAt;
  if (!selfPosition || primaryGoal === null || !currentSituation || !preferredRhythm || obstacles === null || supportPreferences === null || !Number.isInteger(availableMinutes) || availableMinutes < 0 || availableMinutes > 10080 || !Number.isFinite(desiredStartAt)) return null;
  return { selfPosition, primaryGoal, currentSituation, availableMinutes, preferredRhythm, obstacles, supportPreferences, desiredStartAt };
}
function assessmentReady(assessment) { return !!(assessment?.selfPosition && assessment?.currentSituation && assessment?.preferredRhythm && Number.isFinite(assessment?.desiredStartAt)); }
function parseAssessmentSnapshot(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function register(router, { notify }) {
  router.add('PUT', '/api/profile/avatar', c => {
    const avatar = c.body.avatar;
    if (typeof avatar !== 'string' || avatar.length > 60000 || (avatar !== '' && !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/=]+$/.test(avatar))) return sendError(c.res,400,'请选择有效的小尺寸 JPEG 头像');
    c.db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatar,c.user.id);
    sendJson(c.res,200,{ok:true,avatar});
  });
  function signal(c, userId, title, linkType, linkId) {
    notify.deliver(c.db, { userId, kind: 'collaboration', title, content: '打开查看详情并处理。', linkType, linkId, recipientUser: users.byId(c.db,userId) });
  }
  // Persist the collaboration change and its notification together, so a
  // failed enqueue can be safely retried without silently losing the handoff.
  function withNotification(db, work) {
    db.exec('BEGIN IMMEDIATE');
    try { work(); db.exec('COMMIT'); }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  router.add('GET', '/api/profile/me', c => sendJson(c.res,200,{ profile: profiles.publicProfile(c.db,c.user), certifications: c.user.role==='supervisor' ? profiles.certs(c.db,c.user.id) : [] }));
  router.add('PUT', '/api/profile/me', c => {
    const b = c.body, nextDisplayName = b.displayName === undefined ? c.user.display_name : b.displayName, headline = str(b.headline,80), bio = str(b.bio,1000), serviceStyle = str(b.serviceStyle,300);
    const gender = b.gender === undefined ? (c.user.gender || 'unspecified') : b.gender;
    const nameError = b.displayName === undefined ? null : displayName.validate(nextDisplayName);
    if (nameError) return sendError(c.res,400,nameError);
    if (!['male','female','unspecified'].includes(gender)) return sendError(c.res,400,'请选择有效的性别信息');
    if (headline === null || bio === null || serviceStyle === null || !Array.isArray(b.skills) || b.skills.length>12 || b.skills.some(s=>!str(s,20))) return sendError(c.res,400,'请检查简介和技能：最多12项技能，每项20字');
    if (b.displayName !== undefined && c.db.prepare('SELECT 1 FROM users WHERE display_name=? AND id<>?').get(nextDisplayName.trim(),c.user.id)) return sendError(c.res,409,'这个昵称已被使用，请换一个');
    const existing=profiles.own(c.db,c.user.id);
    if(c.user.role==='supervisor' && (['published','accepting','cooperationState','cooperation_state','serviceEnabled','capacityOverride','superviseeLimit','agreementRef'].some(k=>Object.hasOwn(b,k))))return sendError(c.res,403,'合作资格、团队展示和服务人数由平台审核管理');
    const publicVisible = b.publicVisible === undefined ? (b.published === undefined ? existing.publicVisible : b.published) : b.publicVisible;
    if(typeof publicVisible!=='boolean')return sendError(c.res,400,'请选择主页可见性');
    const savedName = b.displayName === undefined ? c.user.display_name : nextDisplayName.trim();
    withNotification(c.db, () => {
      profiles.save(c.db,c.user.id,{headline,bio,serviceStyle,skills:[...new Set(b.skills.map(s=>s.trim()))],published:existing.published,publicVisible,accepting:existing.accepting});
      c.db.prepare('UPDATE users SET display_name=?,gender=? WHERE id=?').run(savedName,gender,c.user.id);
    });
    sendJson(c.res,200,{ok:true,displayName:savedName,gender});
  });
  router.add('GET', '/api/profiles/:id', c => {
    const user = users.byId(c.db,c.params.id);
    const related = user && !!c.db.prepare("SELECT 1 FROM supervision_relations WHERE status='active' AND ((supervisor_id=? AND supervisee_id=?) OR (supervisor_id=? AND supervisee_id=?)) UNION SELECT 1 FROM service_requests WHERE status IN ('discussing','planning','plan_proposed') AND ((supervisor_id=? AND supervisee_id=?) OR (supervisor_id=? AND supervisee_id=?)) LIMIT 1").get(c.user.id,user.id,user.id,c.user.id,c.user.id,user.id,user.id,c.user.id);
    const profile = user && profiles.own(c.db,user.id);
    const teamListed = user && user.role === 'supervisor' && users.isServiceEnabled(user) && profile?.published && profile?.accepting;
    if (!user || (user.status !== 1 && c.user.role !== 'admin') || (!profile.publicVisible && !teamListed && c.user.id !== user.id && c.user.role !== 'admin' && !related)) return sendError(c.res,404,'主页未公开或用户不可用');
    const activeRelation=!!c.db.prepare("SELECT 1 FROM supervision_relations WHERE status='active' AND ((supervisor_id=? AND supervisee_id=?) OR (supervisor_id=? AND supervisee_id=?))").get(c.user.id,user.id,user.id,c.user.id);
    const request=c.db.prepare("SELECT id FROM service_requests WHERE status IN ('discussing','planning','plan_proposed') AND ((supervisor_id=? AND supervisee_id=?) OR (supervisor_id=? AND supervisee_id=?)) ORDER BY created_at DESC LIMIT 1").get(c.user.id,user.id,user.id,c.user.id);
    sendJson(c.res,200,{profile:profiles.publicProfile(c.db,user),related:!!related,activeRelation,requestId:request?.id||null});
  });
  router.add('GET', '/api/market', c => {
    const q = String(c.query.q || '').trim().toLowerCase().slice(0,80), skill = String(c.query.skill || '').trim();
    sendJson(c.res,200,profiles.marketPage(c.db,{q,skill,verified:c.query.verified==='1',available:c.query.available==='1',sort:c.query.sort,offset:c.query.offset,limit:24}));
  });
  router.add('POST', '/api/certifications', c => {
    if (c.user.role !== 'supervisor') return sendError(c.res,403,'只有监督者需要提交平台认证；被监督者请先留下一份服务小档案');
    const title=str(c.body.title,80),issuer=str(c.body.issuer||'',100),evidence=str(c.body.evidence,2000),direction=c.body.direction;
    const application={skills:str(c.body.skills,300),strengths:str(c.body.strengths,1500),availability:str(c.body.availability,500),weeklyMinutes:c.body.weeklyMinutes,serviceStyle:str(c.body.serviceStyle,500)};
    if(!['mentor','supervisor'].includes(direction))return sendError(c.res,400,'请选择认证 Mentor（导师）或 Supervisor（监督者）');
    if(!title||issuer===null||!evidence||!application.skills||!application.strengths||!application.availability||!application.serviceStyle||!Number.isInteger(application.weeklyMinutes)||application.weeklyMinutes<1||application.weeklyMinutes>10080)return sendError(c.res,400,'请填写能力、相关经验、空闲时间、服务方式与核验材料；每周可投入时间为1至10080分钟');
    if(profiles.certs(c.db,c.user.id).filter(x=>x.status==='pending').length>=5) return sendError(c.res,409,'最多同时提交5项待审核认证');
    sendJson(c.res,200,{id:profiles.submitCert(c.db,c.user.id,title,issuer,evidence,direction,application)});
  });
  router.add('GET', '/api/assessment/me', c => {
    if (c.user.role !== 'supervisee') return sendError(c.res,403,'服务小档案仅适用于被监督者');
    sendJson(c.res,200,{assessment:assessments.toAssessment(assessments.byUser(c.db,c.user.id))});
  });
  router.add('PUT', '/api/assessment/me', c => {
    if (c.user.role !== 'supervisee') return sendError(c.res,403,'服务小档案仅适用于被监督者');
    const assessment = assessmentInput(c.body || {});
    if (!assessment) return sendError(c.res,400,'请写下自我定位、现在的状态、希望开始时间、可投入时间和希望的节奏；可投入时间为每周 0 至 10080 分钟');
    sendJson(c.res,200,{assessment:assessments.save(c.db,c.user.id,assessment)});
  });
  router.add('GET', '/api/admin/certifications', c => {
    if(c.user.role!=='admin') return sendError(c.res,403,'仅管理员可审核认证');
    const status=['pending','verified','rejected'].includes(c.query.status)?c.query.status:'';
    const userId=typeof c.query.userId==='string'?c.query.userId:'';
    const offset=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,parseInt(c.query.offset,10)||0)),limit=50;
    const list=c.db.prepare("SELECT c.*,u.display_name,u.status AS user_status FROM certifications c JOIN users u ON u.id=c.user_id WHERE u.role='supervisor' AND (?='' OR c.status=?) AND (?='' OR c.user_id=?) ORDER BY (c.status='pending') DESC,c.created_at DESC,c.id LIMIT ? OFFSET ?").all(status,status,userId,userId,limit+1,offset);
    sendJson(c.res,200,{list:list.slice(0,limit),nextOffset:list.length>limit?offset+limit:null});
  });
  router.addRole('GET','/api/admin/certifications/:id/history',c=>sendJson(c.res,200,{events:c.db.prepare('SELECT r.*,u.display_name AS reviewerName FROM certification_reviews r LEFT JOIN users u ON u.id=r.reviewer_id WHERE certification_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(c.params.id)}),['admin']);
  router.add('PUT', '/api/admin/certifications/:id', c => {
    if(c.user.role!=='admin') return sendError(c.res,403,'仅管理员可审核认证');
    const status=c.body.status,note=str(c.body.reviewNote,300);
    if(!['verified','rejected'].includes(status) || !note) return sendError(c.res,400,'请填写材料核验依据或拒绝、撤销原因');
    try {
      c.db.exec('BEGIN IMMEDIATE');
      const row=c.db.prepare("SELECT c.* FROM certifications c JOIN users u ON u.id=c.user_id WHERE c.id=? AND u.role='supervisor'").get(c.params.id);
      if(!row){c.db.exec('ROLLBACK');return sendError(c.res,404,'认证或监督者不存在');}
      if(c.body.expectedStatus!==undefined&&(c.body.expectedStatus!==row.status||c.body.expectedReviewedAt!==row.reviewed_at)){c.db.exec('ROLLBACK');return sendError(c.res,409,'认证已被其他管理员处理，请刷新后重试');}
      c.db.prepare('UPDATE certifications SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(status,note,c.user.id,Date.now(),row.id);
      c.db.prepare('INSERT INTO certification_reviews(id,certification_id,reviewer_id,previous_status,status,note,created_at) VALUES(?,?,?,?,?,?,?)').run(require('crypto').randomUUID(),row.id,c.user.id,row.status,status,note,Date.now());
      signal(c,row.user_id,status==='verified'?'认证审核通过':'认证审核结果已更新','profile',row.user_id);
      c.db.exec('COMMIT');
    }catch(error){try{c.db.exec('ROLLBACK');}catch{}throw error;}
    sendJson(c.res,200,{ok:true});
  });
  function context(c, readOnly=false) {
    const r=c.db.prepare('SELECT * FROM service_requests WHERE id=?').get(c.params.id);
    if(!r || ![r.supervisor_id,r.supervisee_id].includes(c.user.id)) {sendError(c.res,404,'协商不存在');return null;}
    if (!readOnly && (users.byId(c.db,r.supervisor_id)?.role !== 'supervisor' || users.byId(c.db,r.supervisee_id)?.role !== 'supervisee')) {sendError(c.res,409,'协商参与者身份已变化，请重新发起协商');return null;}
    const otherId=r.supervisor_id===c.user.id?r.supervisee_id:r.supervisor_id;
    if(!readOnly && users.byId(c.db,otherId)?.status!==1){sendError(c.res,409,'对方账号不可用');return null;}
    return r;
  }
  router.add('GET','/api/requests',c=>sendJson(c.res,200,{list:c.db.prepare(`SELECT r.id,r.supervisor_id,r.supervisee_id,r.initiator_id,r.goal,r.status,r.terms,r.supervisor_confirmed,r.supervisee_confirmed,r.intake_mode,r.desired_start_at,r.plan_id,r.created_at,r.updated_at,COALESCE(s.display_name,'已删除账号') AS supervisor_name,COALESCE(e.display_name,'已删除账号') AS supervisee_name
    FROM service_requests r LEFT JOIN users s ON s.id=r.supervisor_id LEFT JOIN users e ON e.id=r.supervisee_id
    WHERE supervisor_id=? OR supervisee_id=? ORDER BY updated_at DESC LIMIT 200`).all(c.user.id,c.user.id)}));
  router.add('POST','/api/requests',c=>{
    if(!['supervisor','supervisee'].includes(c.user.role))return sendError(c.res,403,'请使用监督者或执行人账号');
    const other=users.byId(c.db,c.body.personId),goal=str(c.body.goal,500),mode=c.body.mode==='quick'?'quick':'guided';
    if(!other || other.status!==1 || other.role!==(c.user.role==='supervisor'?'supervisee':'supervisor') || !goal)return sendError(c.res,400,'请选择对方并说明目标');
    const sup=c.user.role==='supervisor'?c.user:other, sub=c.user.role==='supervisee'?c.user:other;
    if (!users.isServiceEnabled(sup)) return sendError(c.res,409,'监督者尚未获得平台合作授权或已暂停新增服务');
    const assessment = assessments.toAssessment(assessments.byUser(c.db,sub.id));
    const desiredStartAt = mode==='guided' ? assessment?.desiredStartAt : c.body.desiredStartAt;
    if (mode==='guided' && !assessmentReady(assessment)) return sendError(c.res,409,'请先补全服务小档案的自我定位、当前状态、节奏和希望开始时间');
    if (!Number.isFinite(desiredStartAt)) return sendError(c.res,400,'请填写希望开始时间');
    if(c.user.role==='supervisee' && (!profiles.own(c.db,sup.id).published || !profiles.own(c.db,sup.id).accepting) && !users.activeSupervisorIds(c.db,sub.id).includes(sup.id))return sendError(c.res,409,'该监督者暂不接收新咨询');
    const existing=c.db.prepare("SELECT id FROM service_requests WHERE supervisor_id=? AND supervisee_id=? AND status IN ('discussing','planning','plan_proposed')").get(sup.id,sub.id);
    if(existing)return sendJson(c.res,200,{id:existing.id,reused:true});
    if(!users.canBind(c.db,sup.id,sub.id))return sendError(c.res,409,'监督者当前容量已满');
    const id=crypto.randomUUID(),now=Date.now();
    withNotification(c.db, () => {
      c.db.prepare('INSERT INTO service_requests(id,supervisor_id,supervisee_id,initiator_id,goal,assessment_snapshot,intake_mode,desired_start_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,sup.id,sub.id,c.user.id,goal,mode==='guided'?JSON.stringify(assessment):'',mode,desiredStartAt,now,now);
      signal(c,other.id,'收到新的目标协商','request',id);
    });
    sendJson(c.res,200,{id});
  });
  router.add('GET','/api/requests/:id',c=>{
    const r=context(c,true);if(!r)return;
    const { assessment_snapshot, ...request } = r;
    request.supervisor_name=users.byId(c.db,r.supervisor_id)?.display_name||'已删除账号';
    request.supervisee_name=users.byId(c.db,r.supervisee_id)?.display_name||'已删除账号';
    sendJson(c.res,200,{request,assessment:parseAssessmentSnapshot(assessment_snapshot),messages:c.db.prepare('SELECT id,author_id,content,created_at FROM request_messages WHERE request_id=? ORDER BY created_at,id').all(r.id)});
  });
  router.add('POST','/api/requests/:id/messages',c=>{
    const r=context(c);if(!r)return;
    const content=str(c.body.content,1000);
    if(r.status!=='discussing' || !content)return sendError(c.res,400,'协商已进入计划阶段、已结束或留言为空');
    withNotification(c.db, () => {
      c.db.prepare('INSERT INTO request_messages(id,request_id,author_id,content,created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(),r.id,c.user.id,content,Date.now());
      c.db.prepare('UPDATE service_requests SET updated_at=? WHERE id=?').run(Date.now(),r.id);
      signal(c,c.user.id===r.supervisor_id?r.supervisee_id:r.supervisor_id,'协商有新回复','request',r.id);
    });
    sendJson(c.res,200,{ok:true});
  });
  router.add('PUT','/api/requests/:id/terms',c=>{
    const r=context(c);if(!r)return;
    const terms=str(c.body.terms,2000);
    if(r.status!=='discussing'||!terms)return sendError(c.res,400,'请填写目标、频率、反馈方式等约定');
    withNotification(c.db, () => {
      c.db.prepare('UPDATE service_requests SET terms=?,updated_at=? WHERE id=?').run(terms,Date.now(),r.id);
      signal(c,c.user.id===r.supervisor_id?r.supervisee_id:r.supervisor_id,'协商记录已更新，请查看','request',r.id);
    });
    sendJson(c.res,200,{ok:true});
  });
  router.add('POST','/api/requests/:id/confirm',c=>{
    const r=context(c);if(!r)return;
    if(r.status==='planning'||r.status==='plan_proposed'||r.status==='accepted')return sendJson(c.res,200,{ok:true});
    if(r.status!=='discussing')return sendError(c.res,409,'本次协商已结束');
    if(c.user.id!==r.supervisor_id)return sendError(c.res,403,'仅监督者可确认接手并制定计划');
    try{
      c.db.exec('BEGIN IMMEDIATE');
      if(!users.canBind(c.db,r.supervisor_id,r.supervisee_id)){c.db.exec('ROLLBACK');return sendError(c.res,409,'监督者当前容量已满，请稍后再确认');}
      const changed=c.db.prepare("UPDATE service_requests SET status='planning',supervisor_confirmed=1,updated_at=? WHERE id=? AND status='discussing'").run(Date.now(),r.id).changes;
      if(!changed){c.db.exec('ROLLBACK');return sendError(c.res,409,'协商状态已更新，请刷新后再试');}
      signal(c,r.supervisee_id,'监督者已确认接手，正在制定计划','request',r.id);
      c.db.exec('COMMIT');
    }catch(e){try{c.db.exec('ROLLBACK');}catch{}throw e;}
    sendJson(c.res,200,{ok:true});
  });
  router.add('POST','/api/requests/:id/close',c=>{
    const r=context(c,true);if(!r)return;
    if(!['discussing','planning','plan_proposed'].includes(r.status))return sendError(c.res,409,'仅可关闭尚未正式开始的协商');
    try {
      c.db.exec('BEGIN IMMEDIATE');
      c.db.prepare("UPDATE service_requests SET status='closed',updated_at=? WHERE id=?").run(Date.now(),r.id);
      c.db.prepare("UPDATE plans SET status='archived' WHERE service_request_id=? AND status IN ('proposed','declined')").run(r.id);
      const otherId=c.user.id===r.supervisor_id?r.supervisee_id:r.supervisor_id;
      if(users.byId(c.db,otherId)?.status===1)signal(c,otherId,'本次协商已关闭','request',r.id);
      c.db.exec('COMMIT');
    }catch(e){try{c.db.exec('ROLLBACK');}catch{}throw e;}
    sendJson(c.res,200,{ok:true});
  });
  router.add('GET','/api/relations/:id/closing-summary',c=>{
    const supervisorId=c.user.role==='supervisor'?c.user.id:c.params.id;
    const superviseeId=c.user.role==='supervisee'?c.user.id:c.params.id;
    if(!['supervisor','supervisee'].includes(c.user.role)||!users.activeSupervisorIds(c.db,superviseeId).includes(supervisorId))return sendError(c.res,404,'监督关系不存在');
    const pendingDays=c.db.prepare("SELECT COUNT(*) n FROM plan_days d JOIN plans p ON p.id=d.plan_id WHERE p.creator_id=? AND p.assignee_id=? AND p.status='active' AND d.checkin_state='submitted'").get(supervisorId,superviseeId).n;
    const pendingTasks=c.db.prepare("SELECT COUNT(*) n FROM tasks WHERE creator_id=? AND assignee_id=? AND status='submitted'").get(supervisorId,superviseeId).n;
    const pendingReviews=phaseReviews.pendingCountForRelation(c.db,supervisorId,superviseeId);
    sendJson(c.res,200,{pendingDays,pendingTasks,pendingReviews});
  });
  router.add('DELETE','/api/relations/:id',c=>{
    const other=users.byId(c.db,c.params.id);
    const supervisorId=c.user.role==='supervisor'?c.user.id:other?.id;
    const superviseeId=c.user.role==='supervisee'?c.user.id:other?.id;
    if(!other || !['supervisor','supervisee'].includes(c.user.role) || other.role===c.user.role || !users.activeSupervisorIds(c.db,superviseeId).includes(supervisorId))return sendError(c.res,404,'监督关系不存在');
    try{c.db.exec('BEGIN IMMEDIATE');
      users.endRelation(c.db,supervisorId,superviseeId);
      c.db.prepare('UPDATE users SET managed_by=? WHERE id=?').run(users.activeSupervisorIds(c.db,superviseeId)[0]||null,superviseeId);
      signal(c,other.id,'监督关系已结束，历史记录保留','profile',other.id);
      c.db.exec('COMMIT');
    }catch(e){try{c.db.exec('ROLLBACK');}catch{}throw e;}
    sendJson(c.res,200,{ok:true});
  });
}
module.exports={register};
