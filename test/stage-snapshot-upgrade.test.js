'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'markly-snapshot-upgrade-'));
process.env.DB_PATH=path.join(dir,'upgrade.db');
const database=require('../src/db');
test('existing database upgrade retains locked review and leaves unknown confirmation statistics empty',()=>{
  let db=database.getDb();
  db.exec('ALTER TABLE phase_stage_reviews DROP COLUMN execution_snapshot');
  db.prepare(`INSERT INTO phase_stage_reviews(id,parent_plan_id,cycle_plan_id,supervisee_id,supervisor_id,self_summary,locked_at,created_at,updated_at) VALUES('legacy','parent','cycle','sub','sup','original review',100,90,100)`).run();
  database.closeDb();
  db=database.getDb();
  const row=db.prepare("SELECT * FROM phase_stage_reviews WHERE id='legacy'").get();
  assert.equal(row.self_summary,'original review');assert.equal(row.locked_at,100);assert.equal(row.execution_snapshot,null);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  database.closeDb();db=database.getDb();assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phase_stage_reviews').get().n,1);
});
test.after(()=>{database.closeDb();fs.rmSync(dir,{recursive:true,force:true});});
