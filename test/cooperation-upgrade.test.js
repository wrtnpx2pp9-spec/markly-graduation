'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
test('旧监督者和公开主页不会被自动视为已签约，历史关系计划保留',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cooperation-upgrade-'));process.env.DB_PATH=path.join(dir,'app.db');
  const {getDb,closeDb}=require('../src/db'),users=require('../src/repo/user.repo'),profiles=require('../src/repo/profile.repo');
  let db=getDb();
  try{
    const user=users.insert(db,{username:'old',role:'supervisor',passwordHash:'hash',salt:'salt',displayName:'旧监督者',capacityOverride:30,createdAt:1});
    profiles.save(db,user.id,{headline:'旧主页',bio:'保留',skills:[],serviceStyle:'每天',published:true,accepting:true});
    db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,status,created_at) VALUES ('old-plan','历史计划',?,'old-sub','active',1)").run(user.id);
    db.prepare("INSERT INTO supervision_relations(id,supervisor_id,supervisee_id,status,created_at) VALUES ('old-relation',?,'old-sub','active',1)").run(user.id);
    for(const col of ['cooperation_state','agreement_ref','cooperation_note','cooperation_reviewed_by','cooperation_reviewed_at'])db.exec('ALTER TABLE users DROP COLUMN '+col);
    closeDb();db=getDb();
    assert.equal(users.byId(db,user.id).cooperation_state,'pending');assert.equal(users.supervisorCapacity(db,user.id),0);
    assert.equal(users.byId(db,user.id).capacity_override,30,'旧分配保留为审核参考，不直接开通');
    assert.equal(profiles.marketProfiles(db).length,0);assert.equal(users.relationCount(db,user.id),1);
    assert.equal(db.prepare("SELECT title FROM plans WHERE id='old-plan'").get().title,'历史计划');
  }finally{closeDb();fs.rmSync(dir,{recursive:true,force:true});}
});
