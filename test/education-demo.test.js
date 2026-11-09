'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const script=path.resolve(__dirname,'../scripts/demo-seed.cjs');
function runSeed(root, extra={}) {
  const env={...process.env};delete env.DB_PATH;delete env.ILINK_STATE_DIR;
  const program=`require(${JSON.stringify(script)}).seedDemo(${JSON.stringify(root)}).catch(e=>{console.error(e.message);process.exitCode=1})`;
  return spawnSync(process.execPath,['--no-warnings','-e',program],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:20000});
}
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'markly-education-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('teaching fixtures create isolated authorized workflows and random local-only credentials', t=>{
  const root=temporary(t),result=runSeed(root);
  assert.equal(result.status,0,result.stderr);
  const accounts=fs.readFileSync(path.join(root,'demo-data/accounts.md'),'utf8');
  const db=new DatabaseSync(path.join(root,'demo-data/app.db'),{readOnly:true});
  try {
    const users=db.prepare('SELECT * FROM users').all();assert.equal(users.length,3);
    const passwords=[];
    for(const user of users){
      const line=accounts.split('\n').find(line=>line.startsWith('| '+user.username+' |'));
      assert.ok(line);const password=line.split('|')[2].trim();passwords.push(password);
      assert.ok(password.length>=24);assert.equal(crypto.scryptSync(password,user.salt,64).toString('hex'),user.password_hash);
      assert.equal((result.stdout+result.stderr).includes(password),false);
    }
    assert.equal(new Set(passwords).size,3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM supervision_relations WHERE status='active'").get().n,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM plans WHERE status='active'").get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_day_items').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM life_logs').get().n,1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally {db.close();}
});
test('teaching seed refuses existing files without changing their bytes', t=>{
  const root=temporary(t),directory=path.join(root,'demo-data');fs.mkdirSync(directory);
  const sentinel=path.join(directory,'app.db');fs.writeFileSync(sentinel,'leave-existing-content-alone');
  const result=runSeed(root);assert.notEqual(result.status,0);assert.match(result.stderr,/已存在/);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'leave-existing-content-alone');
  assert.deepEqual(fs.readdirSync(directory),['app.db']);
});
test('teaching seed rejects inherited database and iLink overrides before creating data', t=>{
  const root=temporary(t),external=path.join(root,'unrelated.db');fs.writeFileSync(external,'untouched');
  for(const extra of [{DB_PATH:external},{ILINK_STATE_DIR:path.join(root,'elsewhere')}]){
    const result=runSeed(root,extra);assert.notEqual(result.status,0);assert.match(result.stderr,/请先清除/);
    assert.equal(fs.existsSync(path.join(root,'demo-data')),false);assert.equal(fs.readFileSync(external,'utf8'),'untouched');
  }
});
