'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function editorClient(){
  const storage=new Map(),fields={};let modal,complete,fail,onSave;
  const pending=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});
  for(const name of ['daily-items','daily-reason','daily-rest','daily-progress','modal-ok','daily-save-submit'])fields[name]={value:'',checked:false,disabled:false,textContent:'',setAttribute(){}};
  const original={isConnected:true,querySelector:selector=>fields[selector.slice(1)],setAttribute(){},removeAttribute(){}};modal=original;
  const context=vm.createContext({me:{id:'student'},token:'session',esc:v=>String(v??''),
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    $:selector=>fields[selector.slice(1)],$modal:{querySelector:()=>modal},
    openModal:(_title,_html,callback)=>{onSave=callback;},api:()=>pending,toast:()=>{},opened:0});
  vm.runInContext(fs.readFileSync('public/js/daily-planning.js','utf8'),context);
  context.openDailyPlanner=async()=>context.opened++;
  vm.runInContext("dailyEditor({id:'stage'},[],'2030-01-01')",context);
  fields['daily-items'].value='原草稿';fields['daily-items'].oninput();
  return {context,fields,storage,save:()=>onSave(),complete,fail,replace(){original.isConnected=false;modal={isConnected:true};}};
}
test('an older daily save cannot erase the reopened editor draft or reopen its planner',async()=>{
  const c=editorClient(),saving=c.save();
  assert.equal(c.fields['daily-items'].disabled,true);
  c.replace();const key='daily-editor:student:stage:2030-01-01';c.storage.set(key,'newer draft in another editor');
  c.complete({proposal:{id:'draft',version:1}});await saving;
  assert.equal(c.storage.get(key),'newer draft in another editor');assert.equal(c.context.opened,0);
});
test('a rejected daily save preserves content and re-enables retry with an explicit status',async()=>{
  const c=editorClient(),saving=c.save();c.fail(new Error('暂时无法保存'));await saving;
  assert.equal(c.fields['daily-items'].value,'原草稿');assert.equal(c.fields['daily-items'].disabled,false);
  assert.equal(c.fields['modal-ok'].disabled,false);assert.match(c.fields['daily-progress'].textContent,/未保存，请重试/);
  assert.equal(c.context.opened,0);
});
