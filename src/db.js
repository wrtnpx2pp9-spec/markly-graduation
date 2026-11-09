'use strict';
/**
 * 数据库层：使用 Node 内置 node:sqlite，零外部依赖。
 * 数据持久化到 data/app.db（自动创建目录）。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_applications(
      id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
      role TEXT NOT NULL, identity TEXT NOT NULL DEFAULT '', age INTEGER, gender TEXT NOT NULL DEFAULT 'unspecified', contact TEXT NOT NULL, background TEXT NOT NULL, expectation TEXT NOT NULL,
      password_hash TEXT NOT NULL, salt TEXT NOT NULL, receipt_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending', review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT, reviewed_at INTEGER, user_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_pending ON registration_applications(username) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_registration_status ON registration_applications(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS certification_reviews(
      id TEXT PRIMARY KEY, certification_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
      previous_status TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cert_reviews ON certification_reviews(certification_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS user_profiles(
      user_id TEXT PRIMARY KEY, headline TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '[]', service_style TEXT NOT NULL DEFAULT '',
      published INTEGER NOT NULL DEFAULT 0, public_visible INTEGER NOT NULL DEFAULT 0, accepting INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS certifications(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, issuer TEXT NOT NULL,
      evidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cert_user ON certifications(user_id, status);
    CREATE TABLE IF NOT EXISTS supervisee_assessments(
      user_id TEXT PRIMARY KEY,
      self_position TEXT NOT NULL DEFAULT '',
      primary_goal TEXT NOT NULL DEFAULT '',
      current_situation TEXT NOT NULL,
      available_minutes INTEGER NOT NULL,
      preferred_rhythm TEXT NOT NULL,
      obstacles TEXT NOT NULL DEFAULT '',
      support_preferences TEXT NOT NULL DEFAULT '',
      desired_start_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assessments_updated ON supervisee_assessments(updated_at DESC);
    CREATE TABLE IF NOT EXISTS service_requests(
      id TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL, supervisee_id TEXT NOT NULL,
      initiator_id TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'discussing',
      terms TEXT NOT NULL DEFAULT '', supervisor_confirmed INTEGER NOT NULL DEFAULT 0,
      supervisee_confirmed INTEGER NOT NULL DEFAULT 0, assessment_snapshot TEXT NOT NULL DEFAULT '',
      intake_mode TEXT NOT NULL DEFAULT 'guided', desired_start_at INTEGER, plan_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requests_people ON service_requests(supervisor_id, supervisee_id, status);
    CREATE TABLE IF NOT EXISTS request_messages(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_messages ON request_messages(request_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_supervisor_updated ON service_requests(supervisor_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_requests_supervisee_updated ON service_requests(supervisee_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','supervisor','supervisee')),
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      display_name TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT 'unspecified',
      status INTEGER DEFAULT 1,
      managed_by TEXT,
      account_level TEXT DEFAULT 'basic',
      supervisee_limit INTEGER DEFAULT 1,
      capacity_override INTEGER,
      reputation_score INTEGER DEFAULT 0,
      completed_service_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      creator_id TEXT NOT NULL,
      assignee_id TEXT,
      parent_id TEXT,
      kind TEXT DEFAULT 'task',
      start_at INTEGER,
      due_at INTEGER,
      remind_before_minutes INTEGER DEFAULT 30,
      remind_hour INTEGER DEFAULT 20,
      status TEXT DEFAULT 'active',
      service_request_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_days(
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      day_date TEXT NOT NULL,
      content TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      done_at INTEGER,
      note TEXT DEFAULT '',
      mood TEXT DEFAULT '',
      checkin_state TEXT DEFAULT 'unsubmitted',
      checkin_submitted_at INTEGER,
      checkin_reviewed_at INTEGER,
      checkin_reviewer_id TEXT,
      checkin_review_note TEXT DEFAULT '',
      remind_fired_at INTEGER,
      overdue_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );

    -- 一个打卡日可包含多项可执行任务；日打卡仍由监督者统一确认。
    CREATE TABLE IF NOT EXISTS plan_day_items(
      id TEXT PRIMARY KEY,
      day_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
      done_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_day_comments(
      id TEXT PRIMARY KEY,
      day_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_role TEXT NOT NULL,
      content TEXT DEFAULT '',
      mood TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_templates(
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY,
      plan_id TEXT,
      title TEXT NOT NULL,
      note TEXT DEFAULT '',
      creator_id TEXT NOT NULL,
      assignee_id TEXT NOT NULL,
      due_at INTEGER,
      remind_before_minutes INTEGER DEFAULT 30,
      status TEXT DEFAULT 'pending',
      done_at INTEGER,
      checkin_note TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      remind_fired_at INTEGER,
      overdue_fired_at INTEGER,
      overdue_escalated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS life_logs(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      log_date TEXT NOT NULL,
      content TEXT NOT NULL,
      mood TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      link_type TEXT,
      link_id TEXT,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_outbox(
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      locked_at INTEGER,
      lock_token TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit_logs(
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      ip TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduler_leases(
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      locked_until INTEGER NOT NULL
    );

    -- 微信 iLink：用户账号与其微信会话的绑定（接收人把自己的微信绑定到Markly账号）
    CREATE TABLE IF NOT EXISTS wechat_bindings(
      user_id TEXT PRIMARY KEY,
      wxid TEXT UNIQUE NOT NULL,
      context_token TEXT NOT NULL DEFAULT '',
      nickname TEXT DEFAULT '',
      bound_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      bind_code TEXT,
      bind_code_hash TEXT,
      bind_code_expires INTEGER,
      created_at INTEGER NOT NULL
    );

    -- 微信 iLink：收发记录（出站推送 / 入站绑定，供界面与排障查看）
    CREATE TABLE IF NOT EXISTS wechat_deliveries(
      id TEXT PRIMARY KEY,
      user_id TEXT,
      wxid TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out','in')),
      kind TEXT NOT NULL DEFAULT 'send',
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      error TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wechat_bot_instances(
      user_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'real',
      connection_state TEXT NOT NULL DEFAULT 'unbound',
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supervision_relations(
      id TEXT PRIMARY KEY,
      supervisor_id TEXT NOT NULL,
      supervisee_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      UNIQUE(supervisor_id, supervisee_id)
    );

    CREATE TABLE IF NOT EXISTS supervision_periods(
      id TEXT PRIMARY KEY, supervisor_id TEXT NOT NULL, supervisee_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_period_open ON supervision_periods(supervisor_id,supervisee_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_period_people ON supervision_periods(supervisor_id,supervisee_id,started_at);
    CREATE TABLE IF NOT EXISTS service_reviews(
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL UNIQUE,
      reviewer_id TEXT NOT NULL,
      supervisor_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      content TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phase_stage_reviews(
      id TEXT PRIMARY KEY,
      parent_plan_id TEXT NOT NULL,
      cycle_plan_id TEXT NOT NULL UNIQUE,
      supervisee_id TEXT NOT NULL,
      supervisor_id TEXT NOT NULL,
      self_summary TEXT DEFAULT '',
      self_difficulty TEXT DEFAULT '',
      helpful_method TEXT DEFAULT '',
      self_next_action TEXT DEFAULT '',
      supervisor_observation TEXT DEFAULT '',
      supervisor_progress TEXT DEFAULT '',
      supervisor_suggestion TEXT DEFAULT '',
      result_label TEXT DEFAULT '',
      recommend_next TEXT DEFAULT '',
      self_submitted_at INTEGER,
      supervisor_submitted_at INTEGER,
      supervisee_confirmed INTEGER DEFAULT 0,
      supervisor_confirmed INTEGER DEFAULT 0,
      locked_at INTEGER,
      execution_snapshot TEXT,
      content_revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due ON tasks(assignee_id, status, due_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks(status, due_at, remind_fired_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_remind_at ON tasks((due_at - (COALESCE(remind_before_minutes, 30) * 60000)), due_at, id) WHERE status='pending' AND due_at IS NOT NULL AND remind_fired_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_overdue_at ON tasks(due_at, id) WHERE status='pending' AND due_at IS NOT NULL AND overdue_fired_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_overdue_escalation ON tasks(overdue_fired_at, due_at, id) WHERE status='pending' AND due_at IS NOT NULL AND overdue_fired_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_status_done ON tasks(status, done_at);
    CREATE INDEX IF NOT EXISTS idx_plans_assignee_created ON plans(assignee_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_plans_creator_created ON plans(creator_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_plans_status_created ON plans(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_plans_parent_status_dates ON plans(parent_id, status, start_at, due_at);
    CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_users_role_status_created ON users(role, status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_plan_days_plan_seq ON plan_days(plan_id, seq);
    CREATE INDEX IF NOT EXISTS idx_plan_day_items_day_seq ON plan_day_items(day_id, seq);
    CREATE INDEX IF NOT EXISTS idx_plan_day_comments_day ON plan_day_comments(day_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_plan_days_pending_date ON plan_days(status, day_date, remind_fired_at, overdue_fired_at);
    CREATE INDEX IF NOT EXISTS idx_plan_days_checkin_review ON plan_days(checkin_state, checkin_reviewed_at);
    CREATE INDEX IF NOT EXISTS idx_life_logs_user_date ON life_logs(user_id, log_date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON notification_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_logs(actor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduler_lease_until ON scheduler_leases(locked_until);
    CREATE INDEX IF NOT EXISTS idx_relations_supervisor ON supervision_relations(supervisor_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_relations_supervisee ON supervision_relations(supervisee_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_reviews_supervisor ON service_reviews(supervisor_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON service_reviews(reviewer_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phase_reviews_parent ON phase_stage_reviews(parent_plan_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phase_reviews_people ON phase_stage_reviews(supervisee_id, supervisor_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wechat_bindings_code ON wechat_bindings(bind_code);
    CREATE INDEX IF NOT EXISTS idx_wechat_bindings_wxid ON wechat_bindings(wxid);
    CREATE INDEX IF NOT EXISTS idx_wechat_deliveries_user ON wechat_deliveries(user_id, created_at DESC);
  `);
}

let _db = null;
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function getDb() {
  if (!_db) {
    ensureDir();
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL;');
    _db.exec('PRAGMA busy_timeout = 5000;');
    _db.exec('PRAGMA foreign_keys = ON;')
    createSchema(_db);
    migrate(_db);
  }
  return _db;
}

// 轻量迁移：为已存在的表补充新增列（方便旧库平滑升级）
function migrate(db) {
  const certificationColumns=db.prepare('PRAGMA table_info(certifications)').all().map(c=>c.name);
  if(!certificationColumns.includes('direction'))db.exec("ALTER TABLE certifications ADD COLUMN direction TEXT NOT NULL DEFAULT ''");
  if(!certificationColumns.includes('application_json'))db.exec("ALTER TABLE certifications ADD COLUMN application_json TEXT NOT NULL DEFAULT '{}'");
  if (!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='identity')) db.exec("ALTER TABLE users ADD COLUMN identity TEXT NOT NULL DEFAULT ''");
  const registrationColumns = db.prepare('PRAGMA table_info(registration_applications)').all().map(c => c.name);
  if (!registrationColumns.includes('identity')) db.exec("ALTER TABLE registration_applications ADD COLUMN identity TEXT NOT NULL DEFAULT ''");
  if (!registrationColumns.includes('age')) db.exec('ALTER TABLE registration_applications ADD COLUMN age INTEGER');
  if (!registrationColumns.includes('gender')) db.exec("ALTER TABLE registration_applications ADD COLUMN gender TEXT NOT NULL DEFAULT 'unspecified'");
  const profileColumns = db.prepare('PRAGMA table_info(user_profiles)').all().map((c) => c.name);
  if (!profileColumns.includes('public_visible')) { db.exec('ALTER TABLE user_profiles ADD COLUMN public_visible INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE user_profiles SET public_visible=published WHERE published=1'); }
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  const users = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!users.includes('gender')) db.exec("ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT 'unspecified'");
  if (!users.includes('cooperation_state')) db.exec("ALTER TABLE users ADD COLUMN cooperation_state TEXT NOT NULL DEFAULT 'pending'");
  if (!users.includes('agreement_ref')) db.exec("ALTER TABLE users ADD COLUMN agreement_ref TEXT NOT NULL DEFAULT ''");
  if (!users.includes('cooperation_note')) db.exec("ALTER TABLE users ADD COLUMN cooperation_note TEXT NOT NULL DEFAULT ''");
  if (!users.includes('cooperation_reviewed_by')) db.exec('ALTER TABLE users ADD COLUMN cooperation_reviewed_by TEXT');
  if (!users.includes('cooperation_reviewed_at')) db.exec('ALTER TABLE users ADD COLUMN cooperation_reviewed_at INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS cooperation_events(
    id TEXT PRIMARY KEY,supervisor_id TEXT NOT NULL,actor_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cooperation_events_user ON cooperation_events(supervisor_id,created_at DESC);`);
  if (!users.includes('status')) db.exec('ALTER TABLE users ADD COLUMN status INTEGER DEFAULT 1');
  if (!users.includes('managed_by')) db.exec('ALTER TABLE users ADD COLUMN managed_by TEXT');
  if (!users.includes('account_level')) db.exec("ALTER TABLE users ADD COLUMN account_level TEXT DEFAULT 'basic'");
  if (!users.includes('supervisee_limit')) db.exec('ALTER TABLE users ADD COLUMN supervisee_limit INTEGER DEFAULT 1');
  if (!users.includes('capacity_override')) db.exec('ALTER TABLE users ADD COLUMN capacity_override INTEGER');
  if (!users.includes('reputation_score')) db.exec('ALTER TABLE users ADD COLUMN reputation_score INTEGER DEFAULT 0');
  if (!users.includes('completed_service_count')) db.exec('ALTER TABLE users ADD COLUMN completed_service_count INTEGER DEFAULT 0');
  const plans = db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name);
  if (!plans.includes('agreement_note')) db.exec("ALTER TABLE plans ADD COLUMN agreement_note TEXT DEFAULT ''");
  if (!plans.includes('parent_id')) db.exec('ALTER TABLE plans ADD COLUMN parent_id TEXT');
  if (!plans.includes('kind')) db.exec("ALTER TABLE plans ADD COLUMN kind TEXT DEFAULT 'task'");
  if (!plans.includes('remind_hour')) db.exec('ALTER TABLE plans ADD COLUMN remind_hour INTEGER DEFAULT 20');
  const requests = db.prepare('PRAGMA table_info(service_requests)').all().map((c) => c.name);
  if (!requests.includes('assessment_snapshot')) db.exec("ALTER TABLE service_requests ADD COLUMN assessment_snapshot TEXT NOT NULL DEFAULT ''");
  if (!requests.includes('intake_mode')) db.exec("ALTER TABLE service_requests ADD COLUMN intake_mode TEXT NOT NULL DEFAULT 'guided'");
  if (!requests.includes('desired_start_at')) db.exec('ALTER TABLE service_requests ADD COLUMN desired_start_at INTEGER');
  if (!requests.includes('plan_id')) db.exec('ALTER TABLE service_requests ADD COLUMN plan_id TEXT');
  const assessments = db.prepare('PRAGMA table_info(supervisee_assessments)').all().map((c) => c.name);
  if (!assessments.includes('self_position')) db.exec("ALTER TABLE supervisee_assessments ADD COLUMN self_position TEXT NOT NULL DEFAULT ''");
  if (!assessments.includes('desired_start_at')) db.exec('ALTER TABLE supervisee_assessments ADD COLUMN desired_start_at INTEGER');
  const planColumns = db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name);
  if (!planColumns.includes('service_request_id')) db.exec('ALTER TABLE plans ADD COLUMN service_request_id TEXT');
  db.exec("INSERT OR IGNORE INTO supervision_relations(id, supervisor_id, supervisee_id, status, created_at) SELECT lower(hex(randomblob(16))), managed_by, id, 'active', created_at FROM users WHERE role='supervisee' AND managed_by IS NOT NULL");
  db.exec("INSERT INTO supervision_periods(id,supervisor_id,supervisee_id,started_at,ended_at) SELECT r.id,r.supervisor_id,r.supervisee_id,r.created_at,CASE WHEN r.status='ended' THEN COALESCE(r.ended_at,r.created_at) ELSE NULL END FROM supervision_relations r WHERE NOT EXISTS(SELECT 1 FROM supervision_periods h WHERE h.supervisor_id=r.supervisor_id AND h.supervisee_id=r.supervisee_id)");
  for (const table of ['plans','tasks']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='cooperation_period_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN cooperation_period_id TEXT`);
      db.exec(`UPDATE ${table} SET cooperation_period_id=(SELECT h.id FROM supervision_periods h WHERE h.supervisor_id=${table}.creator_id AND h.supervisee_id=${table}.assignee_id AND ((SELECT COUNT(*) FROM supervision_periods allh WHERE allh.supervisor_id=h.supervisor_id AND allh.supervisee_id=h.supervisee_id)=1 OR (${table}.created_at>=h.started_at AND (h.ended_at IS NULL OR ${table}.created_at<=h.ended_at)) OR (h.ended_at IS NULL AND ${table}.status IN ('active','pending','submitted','proposed') AND ${table}.created_at>COALESCE((SELECT MAX(previous.ended_at) FROM supervision_periods previous WHERE previous.supervisor_id=h.supervisor_id AND previous.supervisee_id=h.supervisee_id),0))) ORDER BY h.started_at DESC LIMIT 1) WHERE creator_id<>assignee_id`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_cooperation_period ON ${table}(cooperation_period_id)`);
  }
  db.exec("UPDATE users SET capacity_override=NULL WHERE role='supervisor' AND capacity_override IS NULL AND supervisee_limit IN (1, 3, 10, 30)");
  const pd = db.prepare('PRAGMA table_info(plan_days)').all().map((c) => c.name);
  if (!pd.includes('schedule_json')) db.exec("ALTER TABLE plan_days ADD COLUMN schedule_json TEXT NOT NULL DEFAULT ''");
  if (!pd.includes('help_note')) db.exec("ALTER TABLE plan_days ADD COLUMN help_note TEXT DEFAULT ''");
  if (!pd.includes('help_reply')) db.exec("ALTER TABLE plan_days ADD COLUMN help_reply TEXT DEFAULT ''");
  if (!pd.includes('remind_fired_at')) db.exec('ALTER TABLE plan_days ADD COLUMN remind_fired_at INTEGER');
  if (!pd.includes('overdue_fired_at')) db.exec('ALTER TABLE plan_days ADD COLUMN overdue_fired_at INTEGER');
  if (!pd.includes('checkin_state')) db.exec("ALTER TABLE plan_days ADD COLUMN checkin_state TEXT DEFAULT 'unsubmitted'");
  if (!pd.includes('checkin_submitted_at')) db.exec('ALTER TABLE plan_days ADD COLUMN checkin_submitted_at INTEGER');
  if (!pd.includes('checkin_reviewed_at')) db.exec('ALTER TABLE plan_days ADD COLUMN checkin_reviewed_at INTEGER');
  if (!pd.includes('checkin_reviewer_id')) db.exec('ALTER TABLE plan_days ADD COLUMN checkin_reviewer_id TEXT');
  if (!pd.includes('checkin_review_note')) db.exec("ALTER TABLE plan_days ADD COLUMN checkin_review_note TEXT DEFAULT ''");
  if (!pd.includes('mood')) db.exec("ALTER TABLE plan_days ADD COLUMN mood TEXT DEFAULT ''");
  const phaseReviewColumns = db.prepare('PRAGMA table_info(phase_stage_reviews)').all().map((c) => c.name);
  if (!phaseReviewColumns.includes('execution_snapshot')) db.exec('ALTER TABLE phase_stage_reviews ADD COLUMN execution_snapshot TEXT');
  if (!phaseReviewColumns.includes('content_revision')) db.exec('ALTER TABLE phase_stage_reviews ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1');
  const draftCols = db.prepare('PRAGMA table_info(plan_drafts)').all().map((c) => c.name);
  if (draftCols.length && !draftCols.includes('agent_sources_json')) db.exec("ALTER TABLE plan_drafts ADD COLUMN agent_sources_json TEXT NOT NULL DEFAULT '[]'");
  db.exec("UPDATE plan_days SET checkin_state='approved' WHERE status='done' AND (checkin_state IS NULL OR checkin_state='unsubmitted')");
  const tasks = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!tasks.includes('overdue_escalated_at')) db.exec('ALTER TABLE tasks ADD COLUMN overdue_escalated_at INTEGER');
  // 微信 iLink：旧库升级时给外部通知队列补充 channel 列（global=webhook/命令，wechat=微信推送）
  const outbox = db.prepare('PRAGMA table_info(notification_outbox)').all().map((c) => c.name);
  if (!outbox.includes('channel')) db.exec("ALTER TABLE notification_outbox ADD COLUMN channel TEXT NOT NULL DEFAULT 'global'");
  if (!outbox.includes('webhook_sent_at')) db.exec('ALTER TABLE notification_outbox ADD COLUMN webhook_sent_at INTEGER');
  if (!outbox.includes('delivery_key')) {
    db.exec("ALTER TABLE notification_outbox ADD COLUMN delivery_key TEXT NOT NULL DEFAULT ''");
    db.exec(`UPDATE notification_outbox SET delivery_key=channel || ':' || COALESCE(json_extract(payload,'$.recipient.id'),'') WHERE json_valid(payload)`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_ready ON notification_outbox(next_attempt_at,created_at,id) WHERE status IN ('pending','failed');
    CREATE INDEX IF NOT EXISTS idx_outbox_sending_key ON notification_outbox(delivery_key,locked_at) WHERE status='sending';
    CREATE INDEX IF NOT EXISTS idx_outbox_sending_lock ON notification_outbox(locked_at) WHERE status='sending';`);
  // 历史通知默认补成 global 通道（保持原 webhook/命令行为不变）
  db.exec("UPDATE notification_outbox SET channel='global' WHERE channel IS NULL OR channel=''");
  const wechatBindings = db.prepare('PRAGMA table_info(wechat_bindings)').all().map((c) => c.name);
  if (!wechatBindings.includes('bind_code_hash')) db.exec('ALTER TABLE wechat_bindings ADD COLUMN bind_code_hash TEXT');
  const legacyCodes = db.prepare("SELECT user_id, bind_code FROM wechat_bindings WHERE bind_code IS NOT NULL AND bind_code<>'' AND (bind_code_hash IS NULL OR bind_code_hash='')").all();
  const migrateCode = db.prepare('UPDATE wechat_bindings SET bind_code=NULL, bind_code_hash=? WHERE user_id=?');
  for (const row of legacyCodes) {
    migrateCode.run(crypto.createHash('sha256').update(String(row.bind_code).trim().toUpperCase()).digest('hex'), row.user_id);
  }
  require('./plan-drafts').init(db);
  require('./repo/activity.repo').init(db);
  require('./repo/daily-planning.repo').init(db);
  require('./repo/plan.repo').repairArchivedWorkflows(db);
}

module.exports = { getDb, closeDb, DB_PATH, DATA_DIR };
