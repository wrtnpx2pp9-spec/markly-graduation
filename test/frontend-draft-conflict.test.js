'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const key='daily-editor:student:stage:2030-01-01';
const row=(version=1,status='draft')=>({id:'draft',version,status,proposer_id:'student',day_date:'2030-01-01',payload:{rest:false,items:[{id:'item',title:'服务器事项'}]},reason:'服务器说明'});
function client({cached,draft=row(),response,storageValue}={}){
  const storage=new Map(),fields={},calls=[],listeners={};let onSave,modal;
  if(cached)storage.set(key,JSON.stringify(cached));
  if(storageValue)storage.set(key,storageValue);
  const field=id=>fields[id]||(fields[id]={value:'',checked:false,disabled:false,hidden:false,textContent:'',setAttribute(){}});
  const context=vm.createContext({me:{id:'student'},token:'session',esc:v=>String(v??''),
    window:{addEventListener:(event,fn)=>listeners[event]=fn,removeEventListener:event=>delete listeners[event]},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    $:s=>field(s.slice(1)),$modal:{querySelector:()=>modal},
    openModal:(_title,html,callback)=>{onSave=callback;modal={isConnected:true,querySelector:s=>field(s.slice(1)),setAttribute(){},removeAttribute(){}};for(const id of ['daily-items','daily-reason'])field(id).value=html.match(new RegExp('id="'+id+'"[^>]*>([^<]*)'))?.[1]||'';field('daily-rest').checked=/id="daily-rest"[^>]*checked/.test(html);},
    api:async(method,path,body)=>{calls.push({method,path,body});if(response)return response(method,path,body);return path.endsWith('/days')?{days:[]}:{proposals:[row(2)],writable:true,today:'2030-01-01',lastDate:'2030-01-14'};},toast(){},opened:0});
  vm.runInContext(fs.readFileSync('public/js/daily-planning.js','utf8'),context);context.openDailyPlanner=async()=>context.opened++;
  context.draft=draft;vm.runInContext("dailyEditor({id:'stage'},[],'2030-01-01',draft)",context);
  return {context,storage,fields,calls,listeners,save:()=>field('modal-ok').onclick?field('modal-ok').onclick():onSave(),tick:()=>new Promise(resolve=>setImmediate(resolve)),replace(){modal.isConnected=false;modal={isConnected:true};}};
}
test('reopening a stale cached daily draft preserves local input and requires an explicit version choice',async()=>{
  const c=client({cached:{stamp:'old version',text:'本机未保存事项',rest:true,reason:'本机说明'}});await c.tick();
  assert.equal(c.fields['daily-items'].value,'本机未保存事项');
  assert.equal(c.fields['modal-ok'].disabled,true);
  assert.match(c.fields['daily-conflict-server'].textContent,/服务器事项/);
  assert.equal(c.calls.filter(call=>call.method==='POST').length,0);
});
test('409 recovery keeps local changes and uses the fetched version only on the next explicit save',async()=>{
  let version=2,writes=0;
  const c=client({response:async(method,path,body)=>{
    if(method==='POST'){writes++;if(writes<3)throw Object.assign(new Error('版本变化'),{status:409});return {proposal:row(body.version+1)};}
    return path.endsWith('/days')?{days:[]}:{proposals:[row(version)],writable:true,today:'2030-01-01',lastDate:'2030-01-14'};
  }});
  c.fields['daily-items'].value='本机';c.fields['daily-items'].oninput();await c.save();
  assert.equal(writes,1);assert.equal(c.fields['modal-ok'].disabled,true);await c.save();assert.equal(writes,1);
  c.fields['daily-keep-local'].onclick();assert.equal(writes,1);assert.equal(c.fields['daily-items'].value,'本机');
  version=3;await c.save();assert.equal(c.calls.filter(x=>x.method==='POST')[1].body.version,2);
  assert.equal(c.fields['modal-ok'].disabled,true);c.fields['daily-keep-local'].onclick();await c.save();
  assert.equal(c.calls.filter(x=>x.method==='POST')[2].body.version,3);assert.equal(c.context.opened,1);
});
test('choosing the server replaces all three fields without posting',async()=>{
  const c=client({cached:{stamp:'old',text:'本机',rest:true,reason:'本机说明'}});await c.tick();
  c.fields['daily-use-server'].onclick();assert.equal(c.fields['daily-items'].value,'服务器事项');
  assert.equal(c.fields['daily-rest'].checked,false);assert.equal(c.fields['daily-reason'].value,'服务器说明');
  assert.match(c.fields['daily-replaced-content'].textContent,/本机说明/);
  assert.equal(c.fields['modal-ok'].disabled,false);assert.equal(c.calls.filter(x=>x.method==='POST').length,0);
});
test('failed latest-version reads retain input and permit explicit read retry',async()=>{
  let offline=true;
  const c=client({cached:{stamp:'old',text:'本机',rest:false,reason:''},response:async(_method,path)=>{
    if(offline)throw new Error('离线');return path.endsWith('/days')?{days:[]}:{proposals:[row(2)],writable:true,today:'2030-01-01',lastDate:'2030-01-14'};
  }});await c.tick();assert.match(c.fields['daily-conflict-status'].textContent,/离线/);assert.equal(c.fields['modal-ok'].disabled,true);
  offline=false;await c.fields['daily-conflict-retry'].onclick();assert.equal(c.fields['daily-keep-local'].disabled,false);assert.equal(c.fields['daily-items'].value,'本机');
});
for(const scenario of ['submitted','withdrawn','archived','reviewed','private'])test(`${scenario} cannot be overwritten through conflict recovery`,async()=>{
  const c=client({draft:scenario==='private'?null:row(),response:async(method,path)=>{
    if(method==='POST')throw Object.assign(new Error('不可覆盖'),{status:409});
    return path.endsWith('/days')?{days:scenario==='reviewed'?[{dayDate:'2030-01-01',checkinState:'submitted',items:[]}]:[]}:{proposals:scenario==='private'?[]:[row(2,['submitted','withdrawn'].includes(scenario)?scenario:'draft')],writable:scenario!=='archived',today:'2030-01-01',lastDate:'2030-01-14'};
  }});
  c.fields['daily-items'].value='本机';c.fields['daily-items'].oninput();await c.save();
  assert.equal(c.fields['daily-keep-local'].disabled,true);c.fields['daily-keep-local'].onclick();await c.save();
  assert.equal(c.calls.filter(x=>x.method==='POST').length,1);assert.equal(c.fields['daily-items'].value,'本机');
  c.fields['daily-use-server'].onclick();assert.equal(c.fields['modal-ok'].disabled,true);
});
test('late recovery cannot alter a replacement dialog or a new account cache',async()=>{
  let finish;const pending=new Promise(resolve=>finish=resolve);
  const c=client({cached:{stamp:'old',text:'本机',rest:false,reason:''},response:async(_method,path)=>{await pending;return path.endsWith('/days')?{days:[]}:{proposals:[row(2)],writable:true,today:'2030-01-01',lastDate:'2030-01-14'};}});
  c.replace();c.context.token='another session';c.context.me={id:'another'};c.storage.set(key,'newer cache');finish();await c.tick();
  assert.equal(c.fields['daily-items'].value,'本机');assert.equal(c.storage.get(key),'newer cache');assert.equal(c.context.opened,0);
});
test('cross-tab cache edits require an explicit choice and are not overwritten on typing or save',async()=>{
  const c=client();c.fields['daily-items'].value='当前标签';c.fields['daily-items'].oninput();
  const original=JSON.parse(c.storage.get(key)),other=JSON.stringify({...original,text:'另一标签'});c.storage.set(key,other);c.listeners.storage({key});
  c.fields['daily-items'].value='当前标签继续输入';c.fields['daily-items'].oninput();await c.save();
  assert.equal(c.storage.get(key),other);assert.equal(c.calls.length,0);assert.equal(c.fields['modal-ok'].disabled,true);
  c.fields['daily-keep-tab'].onclick();assert.equal(JSON.parse(c.storage.get(key)).text,'当前标签继续输入');assert.equal(c.fields['modal-ok'].disabled,false);
  c.storage.set(key,other);c.listeners.storage({key});c.fields['daily-use-tab'].onclick();assert.equal(c.fields['daily-items'].value,'另一标签');
});
test('local caches remain scoped to their account and stage',()=>{
  const c=client();c.storage.set('daily-editor:another:stage:2030-01-01',JSON.stringify({stamp:'old',text:'他人私有',rest:false,reason:''}));
  vm.runInContext("dailyEditor({id:'other-stage'},[],'2030-01-01')",c.context);
  assert.equal(c.fields['daily-items'].value,'');assert.equal(c.calls.length,0);
});
test('unavailable local storage does not falsely lock server saves as a cross-tab conflict',async()=>{
  const c=client({response:async()=>({proposal:row(2)})});
  c.context.localStorage.setItem=()=>{throw new Error('quota');};
  c.fields['daily-items'].value='待保存';c.fields['daily-items'].oninput();
  assert.match(c.fields['daily-progress'].textContent,/无法保留/);await c.save();
  assert.equal(c.calls.filter(x=>x.method==='POST').length,1);assert.equal(c.context.opened,1);
});
test('a deliberate new-date editor can start again after withdrawal while retaining old cached input for comparison',async()=>{
  const c=client({draft:null,cached:{stamp:JSON.stringify({draft:{id:'old',version:1},existing:null}),text:'撤回前本机输入',rest:false,reason:''},response:async()=>({days:[],proposals:[{...row(2,'withdrawn'),id:'old'}],writable:true,today:'2030-01-01',lastDate:'2030-01-14'})});
  await c.tick();assert.equal(c.fields['daily-keep-local'].disabled,false);assert.equal(c.fields['daily-items'].value,'撤回前本机输入');
});
