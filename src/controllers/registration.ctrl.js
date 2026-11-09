'use strict';
const crypto = require('crypto');
const users = require('../repo/user.repo');
const names = require('../display-name');
const {sendJson,sendError} = require('../router');
const { createClientIpResolver } = require('../client-ip');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const HOUR = 3600000;
function createLimiter(max, maxKeys = 10000) {
  const buckets = new Map();
  return { check(key, now) {
    for (const [oldKey, row] of buckets) if (row.until <= now) buckets.delete(oldKey);
    let row = buckets.get(key);
    if (!row) {
      if (buckets.size >= maxKeys) return false;
      row = { count: 0, until: now + HOUR }; buckets.set(key, row);
    }
    if (row.count >= max) return false;
    row.count++;
    return true;
  } };
}
function register(router, {db,security}) {
  const clientIp = createClientIpResolver();
  const validAttempts = createLimiter(5);
  const invalidAttempts = createLimiter(10);
  router.addPublic('POST','/api/auth/register', c => {
    if (!users.countByRole(db,'admin')) return sendError(c.res,409,'平台尚未完成初始化');
    const b=c.body||{}, now=Date.now(), ip=clientIp(c.req);
    const identities={mentor:'supervisor',mentee:'supervisee',supervisor:'supervisor',supervisee:'supervisee'};
    const role=Object.hasOwn(identities,b.role)?identities[b.role]:null;
    const fields={username:64,displayName:7,contact:120};
    let validationError;
    for(const [key,max] of Object.entries(fields)) if(typeof b[key]!=='string'||!b[key].trim()||b[key].length>max) validationError='请完整填写表单，内容不能超过字数限制';
    if(!validationError && (!/^[a-zA-Z0-9_-]{3,64}$/.test(b.username.trim())||!role||typeof b.password!=='string'||b.password.length<8||b.password.length>256||b.consent!==true)) validationError='账号需为3至64位字母、数字、下划线或短横线；密码8至256字，并确认资料用途';
    if(!validationError && (!Number.isInteger(b.age)||b.age<1||b.age>120||!['male','female','unspecified'].includes(b.gender))) validationError='请填写1至120岁的整数年龄并选择性别';
    if(!validationError) for(const key of ['background','expectation'])if(b[key]!==undefined&&(typeof b[key]!=='string'||b[key].length>1000)) validationError='补充资料格式不正确';
    if(!validationError) validationError=names.validate(b.displayName);
    if(validationError){
      if(!invalidAttempts.check(ip,now)) return sendError(c.res,429,'请求过于频繁，请稍后再试');
      return sendError(c.res,400,validationError);
    }
    if(!validAttempts.check(ip,now)) return sendError(c.res,429,'提交过于频繁，请稍后再试');
    if(users.byUsername(db,b.username.trim())||db.prepare("SELECT id FROM registration_applications WHERE username=? AND status='pending'").get(b.username.trim()))return sendError(c.res,409,'该账号已被使用或正在审核');
    const id=crypto.randomUUID(),receiptToken=crypto.randomBytes(32).toString('hex'),salt=security.genSalt();
    db.prepare('INSERT INTO registration_applications(id,username,display_name,role,identity,age,gender,contact,background,expectation,password_hash,salt,receipt_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,b.username.trim(),b.displayName.trim(),role,b.role,b.age,b.gender,b.contact.trim(),(b.background||'').trim(),(b.expectation||'').trim(),security.hashPassword(b.password,salt),salt,digest(receiptToken),now);
    sendJson(c.res,201,{id,receiptToken,status:'pending'});
  });
  router.addPublic('POST','/api/auth/registration-status', c=>{
    if(typeof c.body?.receiptToken!=='string'||!/^[a-f0-9]{64}$/.test(c.body.receiptToken))return sendError(c.res,400,'请填写有效的查询凭证');
    const row=db.prepare('SELECT username,status,review_note AS reviewNote,created_at AS createdAt FROM registration_applications WHERE receipt_hash=?').get(digest(c.body.receiptToken));
    if(!row)return sendError(c.res,404,'未找到申请，请检查查询凭证');
    sendJson(c.res,200,{application:row});
  });
  router.addRole('GET','/api/admin/registrations',c=>{
    const status=['pending','approved','rejected'].includes(c.query.status)?c.query.status:'pending';
    const offset=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,parseInt(c.query.offset,10)||0)),limit=50;
    const rows=db.prepare('SELECT id,username,display_name AS displayName,role,identity,age,gender,contact,background,expectation,status,review_note AS reviewNote,created_at AS createdAt,reviewed_at AS reviewedAt,user_id AS userId FROM registration_applications WHERE status=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(status,limit+1,offset);
    sendJson(c.res,200,{list:rows.slice(0,limit),nextOffset:rows.length>limit?offset+limit:null});
  },['admin']);
  router.addRole('PUT','/api/admin/registrations/:id',c=>{
    const b=c.body||{};
    if(!['approved','rejected'].includes(b.status)||typeof b.reviewNote!=='string'||!b.reviewNote.trim()||b.reviewNote.length>500)return sendError(c.res,400,'请选择审核结果并填写500字以内的审核说明');
    try {
      db.exec('BEGIN IMMEDIATE');
      const row=db.prepare('SELECT * FROM registration_applications WHERE id=?').get(c.params.id);
      if(!row||row.status!=='pending'){db.exec('ROLLBACK');return sendError(c.res,409,'申请不存在或已处理，请刷新');}
      let userId=null;
      if(b.status==='approved'){
        if(users.byUsername(db,row.username)||db.prepare('SELECT id FROM users WHERE display_name=?').get(row.display_name)){db.exec('ROLLBACK');return sendError(c.res,409,'账号或昵称已被使用，请拒绝并说明重新申请方式');}
        userId=users.insert(db,{username:row.username,displayName:row.display_name,role:row.role,passwordHash:row.password_hash,salt:row.salt,capacityOverride:0,createdAt:Date.now()}).id;
        db.prepare('UPDATE users SET gender=?,identity=? WHERE id=?').run(row.gender,row.identity||row.role,userId);
      }
      db.prepare("UPDATE registration_applications SET status=?,review_note=?,reviewed_by=?,reviewed_at=?,user_id=?,password_hash='',salt='' WHERE id=?").run(b.status,b.reviewNote.trim(),c.user.id,Date.now(),userId,row.id);
      db.exec('COMMIT');sendJson(c.res,200,{ok:true,userId});
    }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  },['admin']);
}
module.exports={register};
