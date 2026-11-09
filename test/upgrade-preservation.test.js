'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-upgrade-preservation-'));
  const relative = path.relative(path.resolve(os.tmpdir()), directory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, 'scripts');
  fs.mkdirSync(scripts);
  for (const name of ['check-upgrade.cjs', 'backup.js', 'upgrade-preservation.cjs']) {
    const source = path.join(root, 'scripts', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(scripts, name));
  }
  return { directory, scripts, source: path.join(directory, 'source.db') };
}

function fixture(w) {
  const db = new DatabaseSync(w.source);
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE plans(id TEXT PRIMARY KEY,title TEXT,description TEXT,creator_id TEXT,assignee_id TEXT);
    CREATE TABLE plan_days(id TEXT PRIMARY KEY,content TEXT,note TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,checkin_note TEXT);
    CREATE TABLE life_logs(id TEXT PRIMARY KEY,user_id TEXT,content TEXT);
    CREATE TABLE notifications(id TEXT PRIMARY KEY,user_id TEXT,content TEXT);
    CREATE TABLE daily_plan_proposals(id TEXT PRIMARY KEY,plan_id TEXT,proposer_id TEXT,base_json TEXT,payload_json TEXT);
    CREATE TABLE phase_stage_reviews(id TEXT PRIMARY KEY,self_summary TEXT,supervisor_id TEXT,supervisee_id TEXT,locked_at INTEGER,execution_snapshot TEXT,supervisee_confirmed INTEGER,supervisor_confirmed INTEGER);
    INSERT INTO users VALUES('user-1');
    INSERT INTO plans VALUES('plan-1','original-title','original-body-marker','supervisor-1','supervisee-1');
    INSERT INTO plan_days VALUES('day-1','original-day-body','original-submission-body');
    INSERT INTO tasks VALUES('task-1','original-task-title','original-task-body');
    INSERT INTO life_logs VALUES('log-1','user-1','original-private-body');
    INSERT INTO notifications VALUES('note-1','user-1','original-notice-body');
    INSERT INTO daily_plan_proposals VALUES('proposal-1','plan-1','user-1','{}','{"items":["original-proposal-body"]}');
    INSERT INTO phase_stage_reviews VALUES('review-1','original-review-body','supervisor-1','supervisee-1',100,'{"percent":100}',1,1);
  `);
  db.close();
}

function run(w, sql) {
  fs.writeFileSync(path.join(w.scripts, 'preflight.js'),
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DB_PATH);db.exec(" + JSON.stringify(sql) + ");db.close();console.log('Isolated injected preflight completed.');\n");
  return spawnSync(process.execPath, ['--no-warnings', path.join(w.scripts, 'check-upgrade.cjs')], {
    cwd: w.directory,
    env: { ...process.env, DB_PATH: w.source, BACKUP_DIR: path.join(w.directory, 'backups'), ILINK_STATE_DIR: path.join(w.directory, 'ilink') },
    encoding: 'utf8', timeout: 30000,
  });
}

function runRealPreflight(w) {
  fs.writeFileSync(path.join(w.scripts, 'preflight.js'), 'require(' + JSON.stringify(path.join(root, 'scripts', 'preflight.js')) + ');\n');
  return spawnSync(process.execPath, ['--no-warnings', path.join(w.scripts, 'check-upgrade.cjs')], {
    cwd: w.directory,
    env: { ...process.env, DB_PATH: w.source, BACKUP_DIR: path.join(w.directory, 'backups'), ILINK_STATE_DIR: path.join(w.directory, 'ilink') },
    encoding: 'utf8', timeout: 30000,
  });
}

function seedMigrating(w, missingReviewColumns) {
  // Initialize only this temporary file, then make known historical states for the real migration.
  const seed = spawnSync(process.execPath, ['--no-warnings', '-e',
    'const database=require(' + JSON.stringify(path.join(root, 'src', 'db.js')) + ');database.getDb();database.closeDb();'], {
    cwd: w.directory, env: { ...process.env, DB_PATH: w.source, ILINK_STATE_DIR: path.join(w.directory, 'ilink') },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(seed.status, 0, seed.stderr);
  const db = new DatabaseSync(w.source);
  db.exec(`
    INSERT INTO users(id,username,role,password_hash,salt,display_name,managed_by,created_at)
      VALUES('legacy-sup','legacy-sup','supervisor','test-only-password-marker','test-only-salt-marker','老师',NULL,10),
            ('legacy-sub','legacy-sub','supervisee','test-only-password-marker','test-only-salt-marker','同学','legacy-sup',10);
    INSERT INTO plans(id,title,description,creator_id,assignee_id,status,created_at)
      VALUES('legacy-plan','原目标','原约定正文','legacy-sup','legacy-sub','archived',20);
    INSERT INTO tasks(id,plan_id,title,creator_id,assignee_id,status,checkin_note,created_at)
      VALUES('legacy-task','legacy-plan','保留提交','legacy-sup','legacy-sub','submitted','原提交正文',30);
    INSERT INTO plan_days(id,plan_id,seq,day_date,content,status,checkin_state,note,created_at)
      VALUES('legacy-day','legacy-plan',1,'2030-01-01','原安排正文','done','unsubmitted','原打卡正文',30);
    INSERT INTO daily_plan_proposals(id,plan_id,day_date,proposer_id,base_json,payload_json,status,created_at,updated_at)
      VALUES('legacy-proposal','legacy-plan','2030-01-02','legacy-sub','{}','{"items":["原提案正文"]}','submitted',30,30);
    INSERT INTO service_requests(id,supervisor_id,supervisee_id,initiator_id,goal,status,plan_id,created_at,updated_at)
      VALUES('legacy-request','legacy-sup','legacy-sub','legacy-sub','原协商正文','plan_proposed','legacy-plan',10,30);
    INSERT INTO phase_stage_reviews(id,parent_plan_id,cycle_plan_id,supervisee_id,supervisor_id,self_summary,supervisor_observation,
      supervisee_confirmed,supervisor_confirmed,locked_at,execution_snapshot,content_revision,created_at,updated_at)
      VALUES('legacy-review','legacy-plan','legacy-cycle','legacy-sub','legacy-sup','原自我复盘','原导师复盘',1,1,100,'{"total":1,"done":1,"percent":100}',7,30,100);
    INSERT INTO wechat_bindings(user_id,wxid,nickname,bound_at,last_seen_at,bind_code,created_at)
      VALUES('legacy-sub','test-only-wxid','历史昵称',10,10,'TESTCODE',10);
    INSERT INTO notification_outbox(id,payload,status,next_attempt_at,created_at,channel)
      VALUES('legacy-outbox','{"recipient":{"id":"legacy-sub"},"content":"原通知正文"}','pending',10,10,'');
    DROP INDEX idx_plans_cooperation_period;
    ALTER TABLE plans DROP COLUMN cooperation_period_id;
    DROP INDEX idx_tasks_cooperation_period;
    ALTER TABLE tasks DROP COLUMN cooperation_period_id;
    DROP INDEX idx_outbox_sending_key;
    ALTER TABLE notification_outbox DROP COLUMN delivery_key;
    ALTER TABLE wechat_bindings DROP COLUMN bind_code_hash;
  `);
  if (missingReviewColumns) {
    db.exec('ALTER TABLE phase_stage_reviews DROP COLUMN execution_snapshot; ALTER TABLE phase_stage_reviews DROP COLUMN content_revision;');
  }
  db.close();
}

for (const scenario of [
  { name: 'plan text', sql: "UPDATE plans SET description='changed-body-marker' WHERE id='plan-1'", location: /plans\.description/ },
  { name: 'plan ownership', sql: "UPDATE plans SET creator_id='supervisor-2' WHERE id='plan-1'", location: /plans\.creator_id/ },
  { name: 'daily proposal text', sql: "UPDATE daily_plan_proposals SET payload_json='changed-proposal-marker' WHERE id='proposal-1'", location: /daily_plan_proposals\.payload_json/ },
  { name: 'locked review snapshot', sql: "UPDATE phase_stage_reviews SET execution_snapshot='{\"percent\":0}' WHERE id='review-1'", location: /phase_stage_reviews\.execution_snapshot/ },
  { name: 'review primary key', sql: "UPDATE phase_stage_reviews SET id='replacement-review' WHERE id='review-1'", location: /phase_stage_reviews\.id/ },
]) {
  test('upgrade check rejects same-count changes to ' + scenario.name + ' without changing the source', t => {
    const w = workspace(t);
    fixture(w);
    const sourceBytes = fs.readFileSync(w.source);
    const result = run(w, scenario.sql);
    assert.notEqual(result.status, 0, 'an altered isolated copy must not report Upgrade PASS');
    assert.doesNotMatch(result.stdout, /Upgrade PASS/);
    assert.match(result.stderr, scenario.location);
    assert.doesNotMatch(result.stderr, /original-body-marker|changed-body-marker|original-review-body|changed-proposal-marker/);
    assert.deepEqual(fs.readFileSync(w.source), sourceBytes, 'source is only opened for a consistent read-only backup');
  });
}

for (const missingReviewColumns of [false, true]) {
  test('real copy preflight permits legacy repairs and preserves ' + (missingReviewColumns ? 'old review confirmation while adding columns' : 'existing locked review text, version and snapshot'), t => {
    const w = workspace(t);
    seedMigrating(w, missingReviewColumns);
    const sourceBytes = fs.readFileSync(w.source);
    const result = runRealPreflight(w);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Upgrade PASS/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-password-marker|test-only-salt-marker|TESTCODE|原自我复盘|原通知正文/);
    assert.deepEqual(fs.readFileSync(w.source), sourceBytes, 'real preflight migrates its copy, never the source');

    // Inspect an independently migrated copy to prove every allowed repair actually ran.
    const migrated = path.join(w.directory, 'migration-proof.db');
    fs.copyFileSync(w.source, migrated);
    const proof = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'preflight.js')], {
      cwd: w.directory, env: { ...process.env, DB_PATH: migrated, ILINK_STATE_DIR: path.join(w.directory, 'proof-ilink') },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(proof.status, 0, proof.stderr);
    const db = new DatabaseSync(migrated, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM supervision_relations').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM supervision_periods').get().n, 1);
      assert.ok(db.prepare("SELECT cooperation_period_id FROM plans WHERE id='legacy-plan'").get().cooperation_period_id);
      assert.ok(db.prepare("SELECT cooperation_period_id FROM tasks WHERE id='legacy-task'").get().cooperation_period_id);
      assert.equal(db.prepare("SELECT status FROM tasks WHERE id='legacy-task'").get().status, 'cancelled');
      assert.equal(db.prepare("SELECT checkin_state FROM plan_days WHERE id='legacy-day'").get().checkin_state, 'approved');
      assert.deepEqual({ ...db.prepare("SELECT status,version FROM daily_plan_proposals WHERE id='legacy-proposal'").get() }, { status: 'closed', version: 2 });
      assert.deepEqual({ ...db.prepare("SELECT status,plan_id FROM service_requests WHERE id='legacy-request'").get() }, { status: 'planning', plan_id: null });
      assert.equal(db.prepare("SELECT channel FROM notification_outbox WHERE id='legacy-outbox'").get().channel, 'global');
      assert.equal(db.prepare("SELECT delivery_key FROM notification_outbox WHERE id='legacy-outbox'").get().delivery_key, ':legacy-sub');
      const binding = db.prepare("SELECT bind_code,bind_code_hash FROM wechat_bindings WHERE user_id='legacy-sub'").get();
      assert.equal(binding.bind_code, null);
      assert.equal(binding.bind_code_hash.length, 64);
      const review = db.prepare("SELECT * FROM phase_stage_reviews WHERE id='legacy-review'").get();
      assert.equal(review.self_summary, '原自我复盘');
      assert.equal(review.supervisor_observation, '原导师复盘');
      assert.equal(review.supervisee_confirmed, 1);
      assert.equal(review.supervisor_confirmed, 1);
      assert.equal(review.locked_at, 100);
      assert.equal(review.execution_snapshot, missingReviewColumns ? null : '{"total":1,"done":1,"percent":100}');
      assert.equal(review.content_revision, missingReviewColumns ? 1 : 7);
    } finally { db.close(); }
  });
}

test('missing historical tables and columns do not reject newly added schema fields', t => {
  const w = workspace(t), db = new DatabaseSync(w.source);
  db.exec("CREATE TABLE plans(id TEXT PRIMARY KEY,title TEXT); INSERT INTO plans VALUES('old-plan','original-title');");
  db.close();
  const result = run(w, "ALTER TABLE plans ADD COLUMN description TEXT DEFAULT ''; CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT); CREATE TABLE phase_stage_reviews(id TEXT PRIMARY KEY,self_summary TEXT);");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Upgrade PASS/);
});

test('the stable snapshot contains only schema metadata and digests and streams business rows', t => {
  const w = workspace(t);
  fixture(w);
  const { capturePreservation, assertPreserved } = require('../scripts/upgrade-preservation.cjs');
  const before = new DatabaseSync(w.source, { readOnly: true }), after = new DatabaseSync(w.source, { readOnly: true });
  const prepare = before.prepare.bind(before);
  t.mock.method(before, 'prepare', sql => {
    const statement = prepare(sql);
    if (/^SELECT .* FROM "/.test(sql) && !/^SELECT COUNT/.test(sql)) {
      statement.all = () => { throw new Error('business rows must not be materialized'); };
    }
    return statement;
  });
  try {
    const snapshot = capturePreservation(before);
    assert.doesNotMatch(JSON.stringify(snapshot), /original-body-marker|original-private-body|original-review-body|supervisor-1|review-1/);
    assert.ok(snapshot.every(table => /^[a-f0-9]{64}$/.test(table.digest)));
    assertPreserved(before, after, snapshot);
  } finally { before.close(); after.close(); }
});

test('same-count changes to confirmation, locked time and null review snapshots are rejected', t => {
  const w = workspace(t);
  fixture(w);
  for (const sql of [
    "UPDATE phase_stage_reviews SET supervisee_confirmed=0 WHERE id='review-1'",
    "UPDATE phase_stage_reviews SET locked_at=NULL WHERE id='review-1'",
    "UPDATE phase_stage_reviews SET execution_snapshot=NULL WHERE id='review-1'",
  ]) {
    const result = run(w, sql);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /phase_stage_reviews\.(supervisee_confirmed|locked_at|execution_snapshot)/);
    assert.doesNotMatch(result.stdout, /Upgrade PASS/);
  }
  const db = new DatabaseSync(w.source);
  db.exec("UPDATE phase_stage_reviews SET execution_snapshot=NULL WHERE id='review-1'");
  db.close();
  const invented = run(w, "UPDATE phase_stage_reviews SET execution_snapshot='{\"percent\":100}' WHERE id='review-1'");
  assert.notEqual(invented.status, 0, 'an unknown historical snapshot cannot be invented during migration');
  assert.match(invented.stderr, /phase_stage_reviews\.execution_snapshot/);
});

test('existing stable columns cannot be removed and added relationship rows cannot hide an old row change', t => {
  const w = workspace(t);
  fixture(w);
  let result = run(w, 'ALTER TABLE plans DROP COLUMN description');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plans\.description.*original column removed/);
  const db = new DatabaseSync(w.source);
  db.exec("CREATE TABLE supervision_relations(id TEXT PRIMARY KEY,supervisor_id TEXT,supervisee_id TEXT); INSERT INTO supervision_relations VALUES('关系旧','sup','sub');");
  db.close();
  result = run(w, "INSERT INTO supervision_relations VALUES('a-new','sup2','sub2'); UPDATE supervision_relations SET supervisor_id='changed' WHERE id='关系旧';");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supervision_relations\.supervisor_id/);
});
