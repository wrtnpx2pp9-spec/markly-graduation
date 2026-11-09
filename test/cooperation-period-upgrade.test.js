const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'markly-period-upgrade-'));process.env.DB_PATH=path.join(dir,'test.db');
const database=require('../src/db');let db=database.getDb();
test('合作批次迁移保留原数据，匹配旧批次及接受前制定的当前计划，不猜测不明归档记录',()=>{
  db.prepare("INSERT INTO supervision_relations(id,supervisor_id,supervisee_id,status,created_at) VALUES('relation','mentor','student','active',100)").run();
  db.prepare("INSERT INTO supervision_periods(id,supervisor_id,supervisee_id,started_at,ended_at) VALUES('old','mentor','student',100,900),('new','mentor','student',2000,NULL)").run();
  const insert=db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,status,created_at) VALUES(?,?,'mentor','student',?,?)");
  insert.run('old-plan','原有历史','archived',400);insert.run('new-plan','当前计划','active',1500);insert.run('unknown-plan','时间不足以确认','archived',1500);
  db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,status,created_at) VALUES('new-task','当前任务','mentor','student','pending',1500)").run();
  for(const table of ['plans','tasks'])db.exec(`DROP INDEX idx_${table}_cooperation_period; ALTER TABLE ${table} DROP COLUMN cooperation_period_id`);
  database.closeDb();db=database.getDb();
  const values=db.prepare('SELECT id,title,cooperation_period_id FROM plans ORDER BY id').all();
  assert.equal(values.find(p=>p.id==='old-plan').cooperation_period_id,'old');assert.equal(values.find(p=>p.id==='new-plan').cooperation_period_id,'new');assert.equal(values.find(p=>p.id==='unknown-plan').cooperation_period_id,null);
  assert.equal(values.find(p=>p.id==='old-plan').title,'原有历史');assert.equal(values.length,3);
  assert.equal(db.prepare("SELECT cooperation_period_id FROM tasks WHERE id='new-task'").get().cooperation_period_id,'new');
  database.closeDb();db=database.getDb();assert.deepEqual(db.prepare('SELECT id,title,cooperation_period_id FROM plans ORDER BY id').all(),values);
});
test.after(()=>{database.closeDb();fs.rmSync(dir,{recursive:true,force:true});});
