'use strict';
const crypto = require('crypto');
const users = require('./user.repo');
const number = value => Number(value) || 0;

function own(db, id) {
  const row = db.prepare('SELECT * FROM user_profiles WHERE user_id=?').get(id);
  return row ? { headline: row.headline, bio: row.bio, skills: JSON.parse(row.skills), serviceStyle: row.service_style, published: !!row.published, publicVisible: !!row.public_visible, accepting: !!row.accepting } :
    { headline: '', bio: '', skills: [], serviceStyle: '', published: false, publicVisible: false, accepting: true };
}
function save(db, id, p) {
  db.prepare(`INSERT INTO user_profiles(user_id,headline,bio,skills,service_style,published,public_visible,accepting,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET headline=excluded.headline,bio=excluded.bio,skills=excluded.skills,service_style=excluded.service_style,published=excluded.published,public_visible=excluded.public_visible,accepting=excluded.accepting,updated_at=excluded.updated_at`)
    .run(id, p.headline, p.bio, JSON.stringify(p.skills), p.serviceStyle, +p.published, +(p.publicVisible ?? false), +p.accepting, Date.now());
}
function certs(db, id) { return db.prepare('SELECT * FROM certifications WHERE user_id=? ORDER BY created_at DESC').all(id); }
function hasVerifiedCert(db, id) { return !!db.prepare("SELECT 1 FROM certifications WHERE user_id=? AND status='verified' LIMIT 1").get(id); }
function stats(db, id) {
  // 已到期的每日约定作为分母；只统计该监督者创建的服务，不公开服务对象和内容。
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const days = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(pd.checkin_state='approved'),0) AS completed
    FROM plan_days pd JOIN plans p ON p.id=pd.plan_id
    WHERE p.creator_id=? AND p.assignee_id<>p.creator_id AND pd.status<>'rest' AND pd.checkin_state<>'cancelled' AND pd.day_date<? AND p.status IN ('active','archived')`).get(id, today);
  const tasks = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(status='done'),0) AS completed FROM tasks
    WHERE creator_id=? AND assignee_id<>creator_id AND due_at<? AND status<>'cancelled'`).get(id, d.getTime());
  const total = days.total + tasks.total, completed = days.completed + tasks.completed;
  const reviews = db.prepare('SELECT COUNT(*) AS count, AVG(rating) AS rating FROM service_reviews WHERE supervisor_id=?').get(id);
  return { total, completed, completionRate: total ? Math.round(completed / total * 100) : null,
    reviewCount: reviews.count, rating: reviews.rating == null ? null : Math.round(reviews.rating * 10) / 10,
    used: users.relationCount(db, id), capacity: users.supervisorCapacity(db, id) };
}
function publicProfile(db, user) {
  const p = own(db, user.id);
  const reviews = user.role === 'supervisor' ? db.prepare("SELECT rating,content,created_at FROM service_reviews WHERE supervisor_id=? AND TRIM(content)!='' ORDER BY updated_at DESC LIMIT 6").all(user.id).map(r => ({ rating:r.rating, content:r.content.slice(0,300), createdAt:r.created_at })) : [];
  return { id: user.id, displayName: user.display_name, avatar: user.avatar || '', gender: user.gender || 'unspecified', role: user.role, identity: users.toPublic(user).identity, ...p,
    ...(user.role==='supervisor'?{cooperationState:user.cooperation_state||'pending',serviceEnabled:users.isServiceEnabled(user),accepting:users.isServiceEnabled(user)&&p.accepting}:{}),
    certifications: user.role === 'supervisor' ? certs(db, user.id).filter(c => c.status === 'verified').map(c => ({ id: c.id, title: c.title, issuer: c.issuer, direction:c.direction||'', skills:JSON.parse(c.application_json||'{}').skills||'', reviewedAt: c.reviewed_at })) : [],
    stats: user.role === 'supervisor' ? stats(db, user.id) : null,
    reviews };
}
function marketProfiles(db) {
  const rows = db.prepare(`SELECT u.*,p.headline,p.bio,p.skills,p.service_style,p.published,p.public_visible,p.accepting
    FROM users u JOIN user_profiles p ON p.user_id=u.id
    WHERE u.role='supervisor' AND u.status=1 AND p.published=1 AND p.accepting=1
    AND u.cooperation_state='active' AND TRIM(u.agreement_ref)!='' AND u.capacity_override>0`).all();
  if (!rows.length) return [];
  const ids = rows.map(u=>u.id), slots = ids.map(()=>'?').join(',');
  const date = new Date(); date.setHours(0,0,0,0);
  const today = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const keyed = rows => new Map(rows.map(r=>[r.id,r]));
  const days = keyed(db.prepare(`SELECT p.creator_id AS id,COUNT(*) AS total,SUM(d.checkin_state='approved') AS completed
    FROM plans p JOIN plan_days d ON d.plan_id=p.id WHERE p.creator_id IN (${slots}) AND p.assignee_id<>p.creator_id
    AND p.status IN ('active','archived') AND d.status<>'rest' AND d.checkin_state<>'cancelled' AND d.day_date<? GROUP BY p.creator_id`).all(...ids,today));
  const tasks = keyed(db.prepare(`SELECT creator_id AS id,COUNT(*) AS total,SUM(status='done') AS completed FROM tasks
    WHERE creator_id IN (${slots}) AND assignee_id<>creator_id AND due_at<? AND status<>'cancelled' GROUP BY creator_id`).all(...ids,date.getTime()));
  const reviews = keyed(db.prepare(`SELECT supervisor_id AS id,COUNT(*) AS count,AVG(rating) AS rating FROM service_reviews WHERE supervisor_id IN (${slots}) GROUP BY supervisor_id`).all(...ids));
  const relations = keyed(db.prepare(`SELECT supervisor_id AS id,COUNT(*) AS used FROM supervision_relations WHERE supervisor_id IN (${slots}) AND status='active' GROUP BY supervisor_id`).all(...ids));
  const certifications = new Map();
  for (const c of db.prepare(`SELECT id,user_id,title,issuer,reviewed_at,direction,application_json FROM certifications WHERE user_id IN (${slots}) AND status='verified' ORDER BY created_at DESC`).all(...ids)) {
    if (!certifications.has(c.user_id)) certifications.set(c.user_id,[]);
    certifications.get(c.user_id).push({id:c.id,title:c.title,issuer:c.issuer,direction:c.direction||'',skills:JSON.parse(c.application_json||'{}').skills||'',reviewedAt:c.reviewed_at});
  }
  // Keep the market page at a fixed query count. Previously this ran one
  // review query per supervisor, which becomes expensive once the directory
  // reaches hundreds of people.
  const reviewSamples = new Map();
  const sampled = db.prepare(`SELECT supervisor_id,rating,content,created_at FROM (
      SELECT supervisor_id,rating,content,created_at,
        ROW_NUMBER() OVER (PARTITION BY supervisor_id ORDER BY updated_at DESC) AS row_num
      FROM service_reviews
      WHERE supervisor_id IN (${slots}) AND TRIM(content)<>''
    ) WHERE row_num<=6`).all(...ids);
  for (const row of sampled) {
    if (!reviewSamples.has(row.supervisor_id)) reviewSamples.set(row.supervisor_id, []);
    reviewSamples.get(row.supervisor_id).push({rating:row.rating,content:row.content.slice(0,300),createdAt:row.created_at});
  }
  return rows.map(u=>{
    const total=(days.get(u.id)?.total||0)+(tasks.get(u.id)?.total||0);
    const completed=(days.get(u.id)?.completed||0)+(tasks.get(u.id)?.completed||0);
    const review=reviews.get(u.id);
    return {id:u.id,displayName:u.display_name,avatar:u.avatar||'',gender:u.gender||'unspecified',role:u.role,identity:users.toPublic(u).identity,headline:u.headline,bio:u.bio,skills:JSON.parse(u.skills),serviceStyle:u.service_style,published:!!u.published,publicVisible:!!u.public_visible,accepting:!!u.accepting,cooperationState:u.cooperation_state,serviceEnabled:users.isServiceEnabled(u),
      certifications:certifications.get(u.id)||[],reviews:reviewSamples.get(u.id)||[],stats:{total,completed,completionRate:total?Math.round(completed/total*100):null,
        reviewCount:review?.count||0,rating:review?.rating==null?null:Math.round(review.rating*10)/10,used:relations.get(u.id)?.used||0,capacity:users.toPublic(u).superviseeLimit}};
  });
}

// The directory is frequently filtered on mobile.  Do the filtering and
// pagination before calculating reviews/progress, rather than enriching every
// supervisor and throwing most of those objects away in the controller.
function marketPage(db, filters = {}) {
  const q = String(filters.q || '').trim().toLowerCase().slice(0, 80);
  const skill = String(filters.skill || '').trim().slice(0, 80);
  const verified = filters.verified === true;
  const available = filters.available === true;
  const sort = ['completion', 'rating'].includes(filters.sort) ? filters.sort : 'name';
  const limit = Math.min(50, Math.max(1, Number.parseInt(filters.limit, 10) || 24));
  const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(filters.offset, 10) || 0));
  const where = ["u.role='supervisor'", 'u.status=1', 'p.published=1', 'p.accepting=1', "u.cooperation_state='active'", "TRIM(u.agreement_ref)<>''", 'u.capacity_override>0'];
  const args = [];
  const like = value => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';
  if (q) {
    where.push("(u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR p.headline LIKE ? ESCAPE '\\' COLLATE NOCASE OR p.bio LIKE ? ESCAPE '\\' COLLATE NOCASE OR p.skills LIKE ? ESCAPE '\\' COLLATE NOCASE)");
    args.push(like(q), like(q), like(q), like(q));
  }
  if (skill) { where.push("json_valid(p.skills) AND EXISTS(SELECT 1 FROM json_each(p.skills) AS searched_skill WHERE searched_skill.value=?)"); args.push(skill); }
  if (verified) where.push("EXISTS(SELECT 1 FROM certifications c WHERE c.user_id=u.id AND c.status='verified')");
  if (available) where.push("(SELECT COUNT(*) FROM supervision_relations r WHERE r.supervisor_id=u.id AND r.status='active') < u.capacity_override");
  const base = `FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS count ${base}`).get(...args).count;
  const skillRows = db.prepare(`SELECT DISTINCT all_skill.value AS skill FROM users u JOIN user_profiles p ON p.user_id=u.id, json_each(p.skills) AS all_skill
    WHERE u.role='supervisor' AND u.status=1 AND p.published=1 AND p.accepting=1 AND u.cooperation_state='active' AND TRIM(u.agreement_ref)<>'' AND u.capacity_override>0 AND json_valid(p.skills)
    ORDER BY all_skill.value COLLATE NOCASE`).all();
  const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
  const today = `${todayDate.getFullYear()}-${String(todayDate.getMonth()+1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;
  const candidates = `SELECT u.id,u.role,u.identity,u.display_name,u.avatar,u.gender,u.cooperation_state,u.capacity_override,p.headline,p.bio,p.skills,p.service_style,p.published,p.public_visible,p.accepting ${base}`;
  const order = sort === 'completion'
    ? 'completion_rate DESC, total DESC, display_name COLLATE NOCASE, id'
    : sort === 'rating'
      ? 'rating DESC, review_count DESC, display_name COLLATE NOCASE, id'
      : 'display_name COLLATE NOCASE, id';
  const rows = db.prepare(`WITH candidates AS (${candidates}),
    day_stats AS (SELECT p.creator_id AS id,COUNT(*) AS total,SUM(d.checkin_state='approved') AS completed FROM candidates c JOIN plans p ON p.creator_id=c.id JOIN plan_days d ON d.plan_id=p.id WHERE p.assignee_id<>p.creator_id AND p.status IN ('active','archived') AND d.status<>'rest' AND d.checkin_state<>'cancelled' AND d.day_date<? GROUP BY p.creator_id),
    task_stats AS (SELECT t.creator_id AS id,COUNT(*) AS total,SUM(t.status='done') AS completed FROM candidates c JOIN tasks t ON t.creator_id=c.id WHERE t.assignee_id<>t.creator_id AND t.due_at<? AND t.status<>'cancelled' GROUP BY t.creator_id),
    review_stats AS (SELECT r.supervisor_id AS id,COUNT(*) AS review_count,AVG(r.rating) AS rating FROM candidates c JOIN service_reviews r ON r.supervisor_id=c.id GROUP BY r.supervisor_id),
    relation_stats AS (SELECT r.supervisor_id AS id,COUNT(*) AS used FROM candidates c JOIN supervision_relations r ON r.supervisor_id=c.id WHERE r.status='active' GROUP BY r.supervisor_id)
    SELECT c.*,COALESCE(day_stats.total,0)+COALESCE(task_stats.total,0) AS total,COALESCE(day_stats.completed,0)+COALESCE(task_stats.completed,0) AS completed,
      CASE WHEN COALESCE(day_stats.total,0)+COALESCE(task_stats.total,0)>0 THEN CAST(COALESCE(day_stats.completed,0)+COALESCE(task_stats.completed,0) AS REAL)/(COALESCE(day_stats.total,0)+COALESCE(task_stats.total,0)) ELSE -1 END AS completion_rate,
      COALESCE(review_stats.review_count,0) AS review_count,review_stats.rating AS rating,COALESCE(relation_stats.used,0) AS used
    FROM candidates c LEFT JOIN day_stats ON day_stats.id=c.id LEFT JOIN task_stats ON task_stats.id=c.id LEFT JOIN review_stats ON review_stats.id=c.id LEFT JOIN relation_stats ON relation_stats.id=c.id
    ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, today, todayDate.getTime(), limit + 1, offset);
  const page = rows.slice(0, limit), ids = page.map(row => row.id);
  const certifications = new Map(), reviewSamples = new Map();
  if (ids.length) {
    const slots = ids.map(() => '?').join(',');
    for (const c of db.prepare(`SELECT id,user_id,title,issuer,reviewed_at,direction,application_json FROM certifications WHERE user_id IN (${slots}) AND status='verified' ORDER BY created_at DESC`).all(...ids)) {
      if (!certifications.has(c.user_id)) certifications.set(c.user_id, []);
      let application = {}; try { application = JSON.parse(c.application_json || '{}'); } catch {}
      certifications.get(c.user_id).push({id:c.id,title:c.title,issuer:c.issuer,direction:c.direction||'',skills:application.skills||'',reviewedAt:c.reviewed_at});
    }
    for (const row of db.prepare(`SELECT supervisor_id,rating,content,created_at FROM (
        SELECT supervisor_id,rating,content,created_at,ROW_NUMBER() OVER (PARTITION BY supervisor_id ORDER BY updated_at DESC) AS row_num
        FROM service_reviews WHERE supervisor_id IN (${slots}) AND TRIM(content)<>''
      ) WHERE row_num<=6`).all(...ids)) {
      if (!reviewSamples.has(row.supervisor_id)) reviewSamples.set(row.supervisor_id, []);
      reviewSamples.get(row.supervisor_id).push({rating:row.rating,content:row.content.slice(0,300),createdAt:row.created_at});
    }
  }
  const safeSkills = value => { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
  return { list: page.map(row => ({
    id:row.id,displayName:row.display_name,avatar:row.avatar||'',gender:row.gender||'unspecified',role:'supervisor',identity:users.toPublic(row).identity,headline:row.headline,bio:row.bio,skills:safeSkills(row.skills),serviceStyle:row.service_style,published:!!row.published,publicVisible:!!row.public_visible,accepting:!!row.accepting,cooperationState:row.cooperation_state,serviceEnabled:true,
    certifications:certifications.get(row.id)||[],reviews:reviewSamples.get(row.id)||[],stats:{total:number(row.total),completed:number(row.completed),completionRate:number(row.total)?Math.round(number(row.completed)/number(row.total)*100):null,reviewCount:number(row.review_count),rating:row.rating==null?null:Math.round(Number(row.rating)*10)/10,used:number(row.used),capacity:number(row.capacity_override)}})),
    skills:skillRows.map(row => row.skill).filter(Boolean),total,nextOffset:rows.length>limit?offset+limit:null };
}
function submitCert(db, userId, title, issuer, evidence, direction = '', application = {}) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO certifications(id,user_id,title,issuer,evidence,created_at,direction,application_json) VALUES (?,?,?,?,?,?,?,?)').run(id,userId,title,issuer,evidence,Date.now(),direction,JSON.stringify(application));
  return id;
}
module.exports = { own, save, certs, hasVerifiedCert, stats, publicProfile, marketProfiles, marketPage, submitCert };
