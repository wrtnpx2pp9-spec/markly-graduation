'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function intakeClient({role='supervisee',deferReads=false}={}){
  const storage=new Map(),writes=[],reads=[],messages=[],navigations=[];let panel;
  const makePanel=()=>{
    let markup='',fields=new Map(),form;
    const container={isConnected:true,querySelector:selector=>fields.get(selector.slice(1))??null,
      querySelectorAll:()=>[...fields.values()].filter(field=>['input','textarea','select'].includes(field.tagName))};
    Object.defineProperty(container,'innerHTML',{get:()=>markup,set(html){
      fields.forEach(field=>field.isConnected=false);markup=html;fields=new Map();
      const decode=value=>String(value??'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
      for(const match of html.matchAll(/<(input|textarea|select|button|span|p)\b([^>]*)>/g)){
        const [,tag,attributes]=match,body=tag==='input'?'':html.slice(match.index+match[0].length).split('</'+tag+'>')[0];
        const id=/\bid="([^"]+)"/.exec(attributes)?.[1];if(!id)continue;
        const field={id,tagName:tag,isConnected:true,disabled:false,textContent:'',value:decode(/\bvalue="([^"]*)"/.exec(attributes)?.[1]??(tag==='textarea'?body:'')),
          emit(name){form?.listeners.get(name)?.();this['on'+name]?.();}};
        if(tag==='select')field.value=/value="([^"]+)"[^>]*selected/.exec(body)?.[1]??/value="([^"]+)"/.exec(body)?.[1]??'';
        fields.set(id,field);
      }
      if(html.includes('id="intake-form"')){
        const formFields=fields;
        form={isConnected:true,listeners:new Map(),addEventListener:(name,listener)=>form.listeners.set(name,listener),
          querySelector:selector=>selector==='[type="submit"]'?formFields.get('intake-submit'):formFields.get(selector.slice(1))};
        fields.set('intake-form',form);
      }
    }});
    return container;
  };
  panel=makePanel();
  const context=vm.createContext({token:'session-a',me:{id:'account-a',role,identity:role==='supervisor'?'mentor':'mentee'},st:{view:'intake'},
    $:selector=>panel.querySelector(selector),esc:String,todayStr:()=> '2030-01-01',toLocalInput:()=> '2030-01-01T00:00',fromLocalInput:()=>100,
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    api:(method,path,body)=>{const request=deferred();(method==='GET'?reads:writes).push({...request,method,path,body});if(method==='GET'&&!deferReads)request.resolve({assessment:null});return request.promise;},
    toast:message=>messages.push(message),goView:view=>{navigations.push(view);context.st.view=view;panel.isConnected=false;panel.querySelector('#intake-form').isConnected=false;}});
  vm.runInContext(fs.readFileSync('public/js/intake.js','utf8'),context);
  const key='markly:intake:account-a:'+role;
  return {context,storage,writes,reads,messages,navigations,key,get panel(){return panel;},field:id=>panel.querySelector('#'+id),
    open:()=>context.renderIntake(panel),save:()=>{const form=panel.querySelector('#intake-form');return form.onsubmit({preventDefault(){},currentTarget:form});},
    replace(){panel.isConnected=false;panel.querySelector('#intake-form').isConnected=false;panel=makePanel();context.st.view='intake';}};
}

for(const role of ['supervisee','supervisor']){
  const field=role==='supervisor'?'cert-strengths':'assessment-current';
  test(`a delayed ${role} intake save preserves newer input and stays in its editor`,async()=>{
    const c=intakeClient({role});await c.open();c.field(field).value='提交的内容';c.field(field).emit('input');const saving=c.save();
    c.field(field).value='等待期间新填写，尚未保存';c.field(field).emit('input');c.writes[0].resolve({ok:true});await saving;
    assert.match(c.storage.get(c.key),/等待期间新填写/);assert.equal(c.field(field).value,'等待期间新填写，尚未保存');
    assert.deepEqual(c.navigations,[]);assert.equal(c.field('intake-submit').disabled,false);assert.match(c.messages.at(-1),/已.*保存|已.*提交/);assert.match(c.messages.at(-1),/尚未.*保存|未.*提交/);
    assert.equal(c.field('intake-status').hidden,false);assert.equal(c.field('intake-status').textContent,c.messages.at(-1));
  });
  test(`an unchanged ${role} intake save clears only its submitted draft and leaves the form`,async()=>{
    const c=intakeClient({role});await c.open();c.field(field).value='已提交的填写';c.field(field).emit('input');const saving=c.save();
    await c.save();assert.equal(c.writes.length,1);c.writes[0].resolve({ok:true});await saving;
    assert.equal(c.storage.has(c.key),false);assert.deepEqual(c.navigations,['my']);
  });
}
test('a delayed intake save cannot delete a reopened editor draft or navigate away',async()=>{
  const c=intakeClient();await c.open();c.field('assessment-current').value='旧表单';c.field('assessment-current').emit('input');const saving=c.save();
  c.replace();await c.open();c.field('assessment-current').value='重开后的新草稿';c.field('assessment-current').emit('input');const current=c.panel;
  c.writes[0].resolve({ok:true});await saving;
  assert.match(c.storage.get(c.key),/重开后的新草稿/);assert.equal(c.panel,current);assert.deepEqual(c.navigations,[]);assert.deepEqual(c.messages,[]);
});
for(const outcome of ['success','failure'])test(`an old account intake ${outcome} cannot clear drafts or update the current page`,async()=>{
  const c=intakeClient();await c.open();c.field('assessment-current').value='原账号未确认草稿';c.field('assessment-current').emit('input');const saving=c.save();
  c.context.token='session-b';c.context.me={id:'account-b',role:'supervisee'};
  if(outcome==='success')c.writes[0].resolve({ok:true});else c.writes[0].reject(Error('原账号请求失败'));await saving;
  assert.equal(c.storage.has(c.key),true);assert.deepEqual(c.navigations,[]);assert.deepEqual(c.messages,[]);assert.equal(c.field('intake-error').textContent,'');
});
test('a rejected intake write preserves its inputs and permits one explicit retry',async()=>{
  const c=intakeClient();await c.open();c.field('assessment-current').value='失败后保留';c.field('assessment-current').emit('input');const saving=c.save();
  c.writes[0].reject(Error('暂时无法保存'));await saving;
  assert.equal(c.field('assessment-current').value,'失败后保留');assert.match(c.storage.get(c.key),/失败后保留/);assert.equal(c.field('intake-submit').disabled,false);assert.match(c.field('intake-error').textContent,/暂时无法保存/);
  const retry=c.save();assert.equal(c.writes.length,2);assert.equal(c.field('intake-error').textContent,'');c.writes[1].resolve({ok:true});await retry;assert.deepEqual(c.navigations,['my']);
});
test('newer intake input stays in the form when browser draft storage is unavailable',async()=>{
  const c=intakeClient();c.context.sessionStorage={getItem(){throw Error('浏览器拒绝存储');},setItem(){throw Error('浏览器拒绝存储');},removeItem(){throw Error('浏览器拒绝存储');}};
  await c.open();c.field('assessment-current').value='提交时内容';const saving=c.save();c.field('assessment-current').value='存储不可用时的新输入';c.field('assessment-current').emit('input');
  c.writes[0].resolve({ok:true});await saving;
  assert.equal(c.field('assessment-current').value,'存储不可用时的新输入');assert.deepEqual(c.navigations,[]);assert.match(c.field('intake-status').textContent,/尚未保存/);
});
test('a late earlier assessment read cannot replace a newer completed form',async()=>{
  const c=intakeClient({deferReads:true}),first=c.open(),second=c.open();
  c.reads[1].resolve({assessment:{currentSituation:'最新服务器内容'}});await second;
  c.reads[0].resolve({assessment:{currentSituation:'旧服务器内容'}});await first;
  assert.equal(c.field('assessment-current').value,'最新服务器内容');
});
test('a late assessment read failure cannot replace a different view in the same container',async()=>{
  const c=intakeClient({deferReads:true}),loading=c.open();c.context.st.view='my';c.panel.innerHTML='已经打开的个人主页';
  c.reads[0].reject(Error('旧读取失败'));await loading;assert.equal(c.panel.innerHTML,'已经打开的个人主页');
});
