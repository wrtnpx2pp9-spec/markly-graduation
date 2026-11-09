'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fieldsFrom(html){
  const fields=new Map(),decode=value=>String(value??'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  for(const match of html.matchAll(/<(input|textarea|select|button|span)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/g)){
    const [,tag,attributes,body='']=match,id=/\bid="([^"]+)"/.exec(attributes)?.[1];
    if(!id)continue;
    const listeners=new Map(),element={isConnected:true,disabled:/\bdisabled\b/.test(attributes),value:decode(/\bvalue="([^"]*)"/.exec(attributes)?.[1]??(tag==='textarea'?body:'')),checked:false,textContent:'',dataset:{},
      addEventListener:(name,callback)=>listeners.set(name,callback),setAttribute(){},removeAttribute(){},emit(name){listeners.get(name)?.();this['on'+name]?.();}};
    if(tag==='select'){
      Object.defineProperty(element,'innerHTML',{set(markup){this.options=[...markup.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map(row=>({value:decode(row[1])}));this.value=this.options[0]?.value??'';}});
      element.innerHTML=body;
      element.querySelector=selector=>element.options.find(option=>selector===`option[value="${option.value}"]`)??null;
    }
    fields.set(id,element);
  }
  const stars=[...html.matchAll(/data-service-rating="(\d+)"/g)].map(match=>({isConnected:true,disabled:false,dataset:{serviceRating:match[1]},classList:{toggle(){}},setAttribute(){}}));
  return {fields,stars};
}
function modalClient({role='supervisee',plans=[]}={}){
  const storage=new Map(),requests=[],messages=[];let current=null,callback;
  const context=vm.createContext({token:'session',me:{id:'sub',role,displayName:'执行人'},st:{view:'tasks',plans,tasks:[]},people:[{id:'sub',relationship:'managed',displayName:'执行人',username:'sub'}],
    esc:value=>String(value??''),toLocalInput:()=>'',fromLocalInput:()=>0,window:{scrollY:40,scrollTo(){}},document:{addEventListener(){}},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    $:selector=>current?.fields.get(selector.slice(1))??null,$modal:{querySelector:selector=>selector==='.dialog'?current:null,querySelectorAll:selector=>current?.querySelectorAll(selector)??[]},
    openModal:(_title,html,onSave)=>{if(current){current.isConnected=false;current.fields.forEach(field=>{field.isConnected=false;});}const parsed=fieldsFrom(html);current={...parsed,isConnected:true,querySelector:selector=>parsed.fields.get(selector.slice(1))??null,querySelectorAll:selector=>selector==='[data-service-rating]'?parsed.stars:[...parsed.fields.values(),...parsed.stars].filter(field=>'value' in field||field.dataset?.serviceRating),setAttribute(){},removeAttribute(){}};current.fields.set('modal-ok',{disabled:false,isConnected:true});callback=onSave;},
    closeModal:()=>{context.closed++;if(current)current.isConnected=false;current=null;},closed:0,renderView:()=>{context.rendered++;},rendered:0,
    loadSection:async()=>{},toast:message=>messages.push(message),api:(method,path,body)=>{const request=deferred();requests.push({...request,method,path,body});return request.promise;}});
  vm.runInContext(fs.readFileSync('public/js/tasks.js','utf8'),context);
  return {context,storage,requests,messages,run:code=>vm.runInContext(code,context),get editor(){return current;},save:()=>callback()};
}
function lifeClient(){
  const storage=new Map(),request=deferred(),messages=[];let currentFields=new Map();
  const container={isConnected:true,querySelector:selector=>currentFields.get(selector.slice(1))??null,querySelectorAll:()=>[]};
  Object.defineProperty(container,'innerHTML',{set(html){currentFields.forEach(field=>{field.isConnected=false;});currentFields=fieldsFrom(html).fields;}});
  const context=vm.createContext({token:'session',me:{id:'sub'},st:{view:'life',logs:[]},esc:value=>String(value??''),todayStr:()=> '2030-01-01',
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    $:selector=>container.querySelector(selector),document:{getElementById:id=>currentFields.get(id)},toast:message=>messages.push(message),goView(){},
    api:()=>request.promise,loadLife:async()=>{},renderView:()=>context.renderLife(container)});
  vm.runInContext(fs.readFileSync('public/js/life.js','utf8'),context);context.renderLife(container);
  return {context,storage,request,messages,field:id=>currentFields.get(id)};
}
function settingsClient(){
  const requests=[],messages=[];let box;
  const makeBox=()=>{
    let html='',fields=new Map();const panel={isConnected:true,querySelector:selector=>fields.get(selector.slice(1))??null,querySelectorAll:()=>[...fields.values()]};
    Object.defineProperty(panel,'innerHTML',{get:()=>html,set(markup){fields.forEach(field=>{field.isConnected=false;});html=markup;fields=fieldsFrom(markup).fields;}});return panel;
  };
  box=makeBox();
  const context=vm.createContext({token:'session',esc:value=>String(value??''),fmtTime:()=>'',confirm:()=>true,$:selector=>selector==='#wx-bind-card'?box:box.querySelector(selector),
    api:(method,path,body)=>{const request=deferred();requests.push({...request,method,path,body});return request.promise;},toast:message=>messages.push(message)});
  vm.runInContext(fs.readFileSync('public/js/settings.js','utf8'),context);
  return {context,requests,messages,load:()=>context.loadWxBindCard(),get box(){return box;},replace(){box.isConnected=false;box=makeBox();}};
}

test('a life save preserves a newer date and mood even when its text is unchanged',async()=>{
  const c=lifeClient();c.field('lf-content').value='今天的记录';c.field('lf-content').emit('input');
  const saving=c.field('lf-add').onclick();c.field('lf-date').value='2030-01-02';c.field('lf-mood').value='新心情';c.field('lf-mood').emit('input');
  c.request.resolve({log:{id:'saved',date:'2030-01-01',content:'今天的记录',mood:'😊'}});await saving;
  assert.equal(c.field('lf-date').value,'2030-01-02');assert.equal(c.field('lf-mood').value,'新心情');assert.equal(c.field('lf-content').value,'今天的记录');
  assert.equal(c.context.st.logs.length,1);
});
test('a life save clears the unchanged submitted draft after a successful save',async()=>{
  const c=lifeClient();c.field('lf-content').value='保存后清空';c.field('lf-content').emit('input');const saving=c.field('lf-add').onclick();
  c.request.resolve({log:{id:'saved',date:'2030-01-01',content:'保存后清空'}});await saving;
  assert.equal(c.field('lf-content').value,'');assert.equal(c.storage.has('life-draft:sub'),false);
});
test('a delayed service review cannot close a reopened editor or remove its newer draft',async()=>{
  const c=modalClient({plans:[{id:'goal',title:'目标'}]});c.run("serviceReviewModal('goal')");
  c.editor.fields.get('sr-content').value='原评价';c.editor.fields.get('sr-content').emit('input');const saving=c.save();
  c.run("serviceReviewModal('goal')");c.editor.fields.get('sr-content').value='新评价草稿';c.editor.fields.get('sr-content').emit('input');const next=c.editor;
  c.requests[0].resolve({});await saving;
  assert.equal(c.editor,next);assert.equal(c.context.closed,0);assert.equal(c.context.rendered,0);assert.match(c.storage.get('markly:review:sub:goal'),/新评价草稿/);
});
test('a saved service review reports refresh failure as a successful write',async()=>{
  const c=modalClient({plans:[{id:'goal',title:'目标'}]});c.context.loadSection=async()=>{throw Error('列表不可用');};c.run("serviceReviewModal('goal')");
  const saving=c.save();c.requests[0].resolve({});await saving;
  assert.equal(c.context.closed,1);assert.match(c.messages.at(-1),/感谢你的评价.*无需重复提交/);
});
test('a delayed task creation cannot close or redraw the next editor',async()=>{
  const c=modalClient();await c.run('taskModal()');c.editor.fields.get('tm-title').value='原任务';const saving=c.save();
  await c.run('taskModal()');c.editor.fields.get('tm-title').value='新任务';const next=c.editor;
  c.requests[0].resolve({});await saving;
  assert.equal(c.editor,next);assert.equal(c.editor.fields.get('tm-title').value,'新任务');assert.equal(c.context.closed,0);assert.equal(c.context.rendered,0);
});
test('a rejected task creation preserves fields and allows one explicit retry',async()=>{
  const c=modalClient();await c.run('taskModal()');const editor=c.editor;editor.fields.get('tm-title').value='重试任务';const saving=c.save();
  await c.save();assert.equal(c.requests.length,1);assert.equal(editor.fields.get('tm-title').disabled,true);
  c.requests[0].reject(Error('暂时无法创建'));await saving;
  assert.equal(editor.fields.get('tm-title').disabled,false);assert.equal(editor.fields.get('tm-assignee').disabled,true);assert.equal(editor.fields.get('tm-title').value,'重试任务');
  const retry=c.save();assert.equal(c.requests.length,2);c.requests[1].resolve({});await retry;assert.equal(c.context.closed,1);
});
test('preset task assignee immediately exposes only their active task plans',async()=>{
  const c=modalClient({role:'supervisor',plans:[{id:'matching',title:'本对象计划',assigneeId:'sub',creatorId:'sub',status:'active',kind:'task'},{id:'other',title:'其他对象计划',assigneeId:'other',creatorId:'sub',status:'active',kind:'task'}]});
  await c.run("taskModal('sub')");assert.equal(c.editor.fields.get('tm-assignee').value,'sub');
  assert.deepEqual(c.editor.fields.get('tm-plan').options.map(option=>option.value),['','matching']);
});
test('a slower WeChat status response cannot replace a newer completed status',async()=>{
  const c=settingsClient(),first=c.load(),second=c.load();c.requests[1].resolve({bound:true,binding:{wxidMasked:'最新绑定'},instance:{connectionState:'authenticated'}});await second;
  c.requests[0].resolve({bound:false,instance:{}});await first;
  assert.match(c.box.innerHTML,/最新绑定/);assert.equal(c.box.querySelector('#wx-start'),null);
});
test('an earlier WeChat status load cannot render into a reopened settings page',async()=>{
  const c=settingsClient(),old=c.box,loading=c.load();c.replace();c.requests[0].resolve({bound:false,instance:{}});await loading;
  assert.equal(old.innerHTML,'');assert.equal(c.box.innerHTML,'');
});
test('a failed WeChat status read provides a retry that only reads status',async()=>{
  const c=settingsClient(),loading=c.load();c.requests[0].reject(Error('网络不可用'));await loading;
  const retry=c.box.querySelector('#wx-retry');assert.ok(retry);const retried=retry.onclick();assert.equal(c.requests[1].method,'GET');
  c.requests[1].resolve({bound:false,instance:{}});await retried;assert.ok(c.box.querySelector('#wx-start'));
});
test('WeChat binding actions block duplicates and conflicting operations until completion',async()=>{
  const c=settingsClient(),loading=c.load();c.requests[0].resolve({bound:false,instance:{}});await loading;
  const start=c.box.querySelector('#wx-start'),refresh=c.box.querySelector('#wx-refresh'),operation=start.onclick();
  await start.onclick();await refresh.onclick();assert.equal(c.requests.length,2);assert.equal(refresh.disabled,true);
  c.requests[1].reject(Error('暂时不可用'));await operation;assert.equal(start.disabled,false);assert.equal(refresh.disabled,false);
  const retry=start.onclick();assert.equal(c.requests.length,3);c.requests[2].resolve({});await new Promise(resolve=>setImmediate(resolve));
  c.requests[3].resolve({bound:false,instance:{hasQrcode:true}});await retry;assert.ok(c.box.querySelector('#wx-start'));
});
test('a completed WeChat unbind explicitly separates a later status-read failure',async()=>{
  const c=settingsClient(),loading=c.load();c.requests[0].resolve({bound:true,binding:{},instance:{connectionState:'authenticated'}});await loading;
  const operation=c.box.querySelector('#wx-unbind').onclick();c.requests[1].resolve({});await new Promise(resolve=>setImmediate(resolve));c.requests[2].reject(Error('状态不可用'));await operation;
  assert.match(c.messages.at(-1),/已解除绑定.*重试读取状态/);assert.ok(c.box.querySelector('#wx-retry'));
});
