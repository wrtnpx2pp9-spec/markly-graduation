'use strict';
const crypto = require('node:crypto');

// Explicit stable business fields only. Credentials and arbitrary settings are deliberately absent.
// Existing migration repairs can change task/proposal/request state, proposal version/update time,
// request plan_id, and legacy day checkin_state. Newly added columns are never in the old snapshot.
const STABLE_FIELDS = Object.freeze({
  users: 'id username role display_name identity gender status managed_by created_at',
  plans: 'id title description creator_id assignee_id parent_id kind start_at due_at remind_before_minutes remind_hour status service_request_id agreement_note cooperation_period_id planning_mode created_at',
  plan_days: 'id plan_id seq day_date content schedule_json status done_at note mood checkin_submitted_at checkin_reviewed_at checkin_reviewer_id checkin_review_note help_note help_reply created_at',
  plan_day_items: 'id day_id plan_id seq title status done_at removed_at created_at',
  plan_day_comments: 'id day_id plan_id author_id author_role content mood created_at',
  plan_templates: 'id owner_id title content created_at',
  tasks: 'id plan_id title note creator_id assignee_id due_at remind_before_minutes done_at checkin_note cooperation_period_id created_at',
  life_logs: 'id user_id log_date content mood created_at',
  notifications: 'id user_id kind title content link_type link_id is_read created_at',
  service_requests: 'id supervisor_id supervisee_id initiator_id goal terms supervisor_confirmed supervisee_confirmed assessment_snapshot intake_mode desired_start_at created_at',
  request_messages: 'id request_id author_id content created_at',
  daily_plan_proposals: 'id plan_id day_date proposer_id base_json payload_json reason decision_note reviewer_id submitted_at created_at',
  phase_stage_reviews: 'id parent_plan_id cycle_plan_id supervisee_id supervisor_id self_summary self_difficulty helpful_method self_next_action supervisor_observation supervisor_progress supervisor_suggestion result_label recommend_next self_submitted_at supervisor_submitted_at supervisee_confirmed supervisor_confirmed locked_at execution_snapshot content_revision created_at updated_at',
  plan_drafts: 'id owner_id assignee_id request_id version source_json limits_json workspace_json bundle_json reviewed plan_id agent_sources_json created_at updated_at',
  supervision_relations: 'id supervisor_id supervisee_id status created_at ended_at',
  supervision_periods: 'id supervisor_id supervisee_id started_at ended_at',
  service_reviews: 'id plan_id reviewer_id supervisor_id rating content created_at updated_at',
  user_profiles: 'user_id headline bio skills service_style published public_visible accepting updated_at',
  supervisee_assessments: 'user_id self_position primary_goal current_situation available_minutes preferred_rhythm obstacles support_preferences desired_start_at updated_at',
  registration_applications: 'id username display_name role identity age gender contact background expectation status review_note reviewed_by reviewed_at user_id created_at',
  certifications: 'id user_id title issuer evidence direction application_json status review_note reviewed_by reviewed_at created_at',
  certification_reviews: 'id certification_id reviewer_id previous_status status note created_at',
  cooperation_events: 'id supervisor_id actor_id before_json after_json created_at',
  activity_events: 'id actor_id subject_id event_type entity_type entity_id summary metadata_json created_at',
  notification_outbox: 'id payload status attempts next_attempt_at locked_at last_error created_at sent_at webhook_sent_at delivery_key',
  wechat_bindings: 'user_id nickname bound_at created_at',
});
const LEGACY_INSERT_TABLES = new Set(['supervision_relations', 'supervision_periods']);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const columns = (db, table) => new Set(db.prepare('PRAGMA table_info(' + quote(table) + ')').all().map(column => column.name));
const tables = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(table => table.name));
const count = (db, table) => db.prepare('SELECT COUNT(*) n FROM ' + quote(table)).get().n;

function cellBytes(value) {
  return value instanceof Uint8Array
    ? Buffer.concat([Buffer.from('blob\0'), Buffer.from(value)])
    : Buffer.from(typeof value + '\0' + JSON.stringify(value));
}
function addRow(hash, row, fields) {
  for (const field of fields) {
    const bytes = cellBytes(row[field]);
    // Length framing avoids collisions from delimiters inside the user's text without retaining it.
    hash.update(field + '\0' + bytes.length + ':');
    hash.update(bytes);
  }
  hash.update('\n');
}
function rows(db, table, fields, key) {
  // All listed primary keys are text IDs with SQLite's binary ordering. UTF-8 byte comparison
  // below also handles non-ASCII historical IDs without using JavaScript's UTF-16 ordering.
  return db.prepare('SELECT ' + fields.map(quote).join(',') + ' FROM ' + quote(table) +
    ' ORDER BY ' + quote(key) + ' COLLATE BINARY').iterate();
}
function locationError(table, field, key, row, reason) {
  const position = row ? JSON.stringify(row[key]) : '*';
  return new Error('Upgrade preservation failed: ' + table + '.' + field +
    ' [primary-key=' + position + '] (' + reason + ')');
}

function capturePreservation(db) {
  const existing = tables(db), snapshot = [];
  for (const [table, names] of Object.entries(STABLE_FIELDS)) {
    if (!existing.has(table)) continue;
    const available = columns(db, table), declared = names.split(' '), key = declared[0];
    if (!available.has(key)) throw locationError(table, key, key, null, 'missing original primary key');
    const fields = declared.filter(field => available.has(field));
    const hash = crypto.createHash('sha256');
    for (const row of rows(db, table, fields, key)) {
      if (row[key] === null) throw locationError(table, key, key, null, 'null original primary key');
      addRow(hash, row, fields);
    }
    snapshot.push(Object.freeze({ table, key, fields: Object.freeze(fields), count: count(db, table), digest: hash.digest('hex') }));
  }
  return Object.freeze(snapshot);
}

function assertPreserved(beforeDb, afterDb, snapshot) {
  const existing = tables(afterDb);
  for (const entry of snapshot) {
    const { table, key, fields } = entry;
    if (!existing.has(table)) throw locationError(table, key, key, null, 'original table removed');
    const available = columns(afterDb, table);
    for (const field of fields) if (!available.has(field)) throw locationError(table, field, key, null, 'original column removed');
    const allowInsert = LEGACY_INSERT_TABLES.has(table);
    if (!allowInsert && count(afterDb, table) !== entry.count) throw locationError(table, key, key, null, 'row count changed');
    const original = rows(beforeDb, table, fields, key), upgraded = rows(afterDb, table, fields, key);
    const originalHash = crypto.createHash('sha256');
    try {
      let next = upgraded.next();
      for (const row of original) {
        addRow(originalHash, row, fields);
        while (!next.done && Buffer.compare(Buffer.from(String(next.value[key])), Buffer.from(String(row[key]))) < 0) {
          if (!allowInsert) throw locationError(table, key, key, next.value, 'unexpected primary key');
          next = upgraded.next();
        }
        if (next.done || !cellBytes(next.value[key]).equals(cellBytes(row[key]))) {
          throw locationError(table, key, key, row, 'original primary key missing');
        }
        for (const field of fields) if (!cellBytes(row[field]).equals(cellBytes(next.value[field]))) {
          throw locationError(table, field, key, row, 'stable field changed');
        }
        next = upgraded.next();
      }
      if (!allowInsert && !next.done) throw locationError(table, key, key, next.value, 'unexpected primary key');
      if (originalHash.digest('hex') !== entry.digest) throw locationError(table, key, key, null, 'read-only baseline changed');
    } finally {
      original.return?.();
      upgraded.return?.();
    }
  }
}

module.exports = { STABLE_FIELDS, capturePreservation, assertPreserved };
