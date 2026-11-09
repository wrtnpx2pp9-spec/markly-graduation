'use strict';
// 在一致性备份的副本上验证升级，真实数据库只读打开。
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {DatabaseSync}=require('node:sqlite'),{spawnSync}=require('child_process');
const {capturePreservation,assertPreserved}=require('./upgrade-preservation.cjs');
const source=path.resolve(process.env.DB_PATH||path.resolve(__dirname,'../data/app.db'));
const dir=path.resolve(process.env.BACKUP_DIR||path.join(path.dirname(source),'backups'));
const backup=require('./backup').backupDatabase(source,dir);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'desk-upgrade-')),copy=path.join(temp,'app.db');fs.copyFileSync(backup,copy);
let beforeDb;
try {
  // Keep the consistent backup as an immutable disk baseline; snapshot metadata/digests are small.
  beforeDb=new DatabaseSync(backup,{readOnly:true});
  const before=capturePreservation(beforeDb);
  const check=spawnSync(process.execPath,[path.resolve(__dirname,'preflight.js')],{env:{...process.env,DB_PATH:copy,ILINK_STATE_DIR:path.join(temp,'ilink')},encoding:'utf8',timeout:120000});
  if(check.status!==0)throw new Error(check.stdout+check.stderr+(check.error?.message||''));
  const afterDb=new DatabaseSync(copy,{readOnly:true});
  try{assertPreserved(beforeDb,afterDb,before);assert.equal(afterDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{afterDb.close();}
  console.log(check.stdout.trim());console.log('Upgrade PASS: existing business row counts and stable fields unchanged; original database untouched.');console.log('Backup: '+backup);
}finally{beforeDb?.close();fs.rmSync(temp,{recursive:true,force:true});}
