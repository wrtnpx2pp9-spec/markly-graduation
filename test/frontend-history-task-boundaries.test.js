'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const modalGuard=fs.readFileSync('public/js/core.js','utf8').match(/function modalReadGuard\(\) \{[\s\S]*?\n\}/)[0];
function client(){
  const requests=[],messages=[],opened=[];let dialog=null,callback,fields=new Map();
  const context=vm.createContext({token:'session-a',me:{id:'sub',role:'supervisee'},st:{view:'history'},URLSearchParams,SIDEBAR_ITEMS:[{}, {icon:''}],
    document:{addEventListener(){}},esc:String,fmtTime:String,fmtDate:String,goView:v=>context.st.view=v,
    $:selector=>fields.get(selector.slice(1))??null,$modal:{querySelector:()=>dialog},
    api:(method,path,body)=>{const gate=deferred();requests.push({...gate,method,path,body});return gate.promise;},
    toast:message=>messages.push(message),loadSection:async()=>{},renderView:()=>context.rendered++,rendered:0,
    closeModal:()=>{vm.runInContext('modalReadSerial++',context);if(dialog)dialog.isConnected=false;dialog=null;context.closed++;},closed:0,
    openModal:(title,html,onSave)=>{
      vm.runInContext('modalReadSerial++',context);if(dialog)dialog.isConnected=false;opened.push(title);fields=new Map();
      for(const match of html.matchAll(/<(button|input|textarea|select)\b([^>]*)>/g)){
        const id=/\bid="([^"]+)"/.exec(match[2])?.[1];if(id)fields.set(id,{id,isConnected:true,disabled:false,value:'',textContent:'',setAttribute(){},removeAttribute(){}});
      }
      for(const id of ['modal-ok','modal-cancel'])fields.set(id,{id,isConnected:true,disabled:false,textContent:'',setAttribute(){},removeAttribute(){}});
      const originalFields=fields;dialog={title,isConnected:true,querySelector:s=>originalFields.get(s.slice(1))??null,querySelectorAll:()=>[...originalFields.values()],setAttribute(){},removeAttribute(){}};callback=onSave;
    }});
  vm.runInContext('let modalReadSerial=0;'+modalGuard,context);
  vm.runInContext(fs.readFileSync('public/js/cooperation-history.js','utf8')+'\n'+fs.readFileSync('public/js/experience.js','utf8'),context);
  context.showHistoryPlan=detail=>context.openModal(detail.rootId,'',()=>{});
  const controls=new Map(['history-back','history-current','history-search','history-person','history-period','history-query','history-prev','history-next'].map(id=>[id,{value:'',addEventListener(){}}]));
  const buttons=['goal-a','goal-b'].map(id=>({dataset:{historyPlan:id},disabled:false}));
  const panel={isConnected:true,innerHTML:'',querySelector:s=>controls.get(s.slice(1))??null,querySelectorAll:()=>buttons};
  return {context,requests,messages,opened,buttons,panel,get dialog(){return dialog;},field:id=>fields.get(id),save:()=>callback(),
    async history(){const loading=context.renderCooperationHistory(panel);requests[0].resolve({list:[]});requests[1].resolve({plans:buttons.map(b=>({id:b.dataset.historyPlan,title:b.dataset.historyPlan,creatorId:'sub',assigneeId:'sub',status:'archived',done:1,total:1})),nextOffset:null});await loading;},
    async task({owner=false,status='pending'}={}){context.st.view='notes';if(owner)context.me={id:'sup',role:'supervisor'};const loading=context.openTask('task-a'),request=requests.at(-1);request.resolve({task:{id:'task-a',title:'任务 A',assigneeId:'sub',creatorId:'sup',status},writable:true});await loading;}};
}
test('history details only open the last chosen goal when responses return in reverse order',async()=>{
  const c=client();await c.history();const first=c.buttons[0].onclick(),second=c.buttons[1].onclick();
  c.requests[3].resolve({rootId:'goal-b'});await second;c.requests[2].resolve({rootId:'goal-a'});await first;
  assert.deepEqual(c.opened,['goal-b']);assert.equal(c.dialog.title,'goal-b');
});
test('a history detail cannot replace a dialog opened while its read was pending',async()=>{
  const c=client();await c.history();const loading=c.buttons[0].onclick();c.context.openModal('后来打开的表单','',()=>{});
  c.requests[2].resolve({rootId:'goal-a'});await loading;assert.equal(c.dialog.title,'后来打开的表单');
});
test('an obsolete history detail failure stays quiet and duplicate clicks make one read',async()=>{
  const c=client();await c.history();const loading=c.buttons[0].onclick(),duplicate=c.buttons[0].onclick(),readCount=c.requests.length;
  c.context.openModal('当前表单','',()=>{});c.requests.slice(2).forEach(request=>request.reject(Error('旧历史读取失败')));await Promise.all([loading,duplicate]);
  assert.equal(readCount,3);assert.deepEqual(c.messages,[]);assert.equal(c.dialog.title,'当前表单');
});
test('a late history list failure cannot replace another view in the same container',async()=>{
  const c=client(),loading=c.context.renderCooperationHistory(c.panel);c.context.st.view='tasks';c.panel.innerHTML='当前目标页面';
  c.requests[0].resolve({list:[]});c.requests[1].reject(Error('旧历史列表失败'));await loading;assert.equal(c.panel.innerHTML,'当前目标页面');
});
for(const action of ['checkin','uncheck','review'])test(`a delayed task ${action} success keeps a replacement form open`,async()=>{
  const c=client();await c.task({owner:action==='review',status:action==='checkin'?'pending':'submitted'});
  let saving;if(action==='checkin'){c.field('task-submit').onclick();c.field('task-note').value='原提交';saving=c.save();}
  else saving=c.field(action==='uncheck'?'task-withdraw':'task-approve').onclick();
  c.context.openModal('新的未提交表单','<textarea id="new-input"></textarea>',()=>{});c.field('new-input').value='新输入';
  c.requests.at(-1).resolve({ok:true});await saving;
  assert.equal(c.dialog.title,'新的未提交表单');assert.equal(c.field('new-input').value,'新输入');assert.equal(c.context.closed,0);assert.equal(c.context.rendered,0);
});
test('task checkin success reports a later list failure as a saved submission',async()=>{
  const c=client();await c.task();c.context.loadSection=async()=>{throw Error('列表读取失败');};c.field('task-submit').onclick();const saving=c.save();
  c.requests.at(-1).resolve({ok:true});await saving;
  assert.equal(c.context.closed,1);assert.match(c.messages.at(-1),/已提交.*无需重复提交/);
});
test('task review blocks repeated clicks and preserves the editor after a rejected write',async()=>{
  const c=client();await c.task({owner:true,status:'submitted'});const button=c.field('task-approve'),saving=button.onclick(),duplicate=button.onclick(),writes=c.requests.filter(r=>r.method==='POST');
  writes.forEach(request=>request.reject(Error('暂时无法审核')));await Promise.all([saving,duplicate]);assert.equal(writes.length,1);
  assert.equal(c.dialog.title,'任务 A');assert.equal(button.disabled,false);assert.match(c.messages.at(-1),/暂时无法审核/);
});
test('an old account task result cannot close the current account dialog',async()=>{
  const c=client();await c.task();c.field('task-submit').onclick();const saving=c.save();c.context.token='session-b';c.context.me={id:'other',role:'supervisee'};
  c.requests.at(-1).resolve({ok:true});await saving;assert.equal(c.context.closed,0);assert.deepEqual(c.messages,[]);
});
test('a profile editor read does not open after leaving the profile page',async()=>{
  const c=client();c.context.st.view='profile';const reading=c.context.editProfile();c.context.st.view='tasks';
  c.requests[0].resolve({profile:{displayName:'测试',gender:'unspecified',skills:[],publicVisible:false}});await reading;assert.deepEqual(c.opened,[]);
});
test('a current profile editor read opens normally and stale read errors stay quiet',async()=>{
  const c=client();c.context.st.view='profile';const reading=c.context.editProfile();c.requests[0].resolve({profile:{displayName:'测试',gender:'unspecified',skills:[],publicVisible:false}});await reading;
  assert.equal(c.dialog.title,'编辑个人主页');const stale=c.context.editProfile();c.context.openModal('新表单','',()=>{});c.requests[1].reject(Error('旧资料读取失败'));await stale;assert.deepEqual(c.messages,[]);
});
