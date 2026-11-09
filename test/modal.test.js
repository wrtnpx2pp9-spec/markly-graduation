const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function client(){
  const events=new Map();let document;
  const element=()=>({isConnected:true,disabled:false,tabIndex:0,focus(){document.activeElement=this;},getClientRects(){return [1];},addEventListener(){},setAttribute(){}});
  const trigger=element(),input=element(),cancel=element(),ok=element(),dialog=element(),app=element(),overlay=element();
  const controls=[input,cancel,ok];dialog.querySelectorAll=()=>controls;
  let html='';const modal={get innerHTML(){return html;},set innerHTML(s){html=s;},querySelector(sel){if(!html)return null;return ({'.dialog':dialog,'.overlay':overlay,'form':null})[sel]||null;},querySelectorAll(){return [input];}};
  document={activeElement:trigger,getElementById:id=>id==='app'?app:modal,querySelector:sel=>({'#modal-ok':ok,'#modal-cancel':cancel})[sel],addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const context=vm.createContext({document,Intl,Date,localStorage:{removeItem(){}},console});
  vm.runInContext(fs.readFileSync('public/js/core.js','utf8'),context);
  return {run:code=>vm.runInContext(code,context),app,modal,input,cancel,ok,trigger,document,key(key,shiftKey=false){let prevented=false;events.get('keydown')?.({key,shiftKey,preventDefault(){prevented=true;}});return prevented;}};
}
test('通用弹窗隔离背景、循环键盘焦点，Escape 后回到触发按钮',()=>{
  const c=client();c.run("openModal('测试','<input>',()=>{})");
  assert.equal(c.app.inert,true);assert.equal(c.document.activeElement,c.input);
  assert.match(c.modal.innerHTML,/role="dialog" aria-modal="true" aria-labelledby="modal-title"/);
  assert.equal(c.key('Tab',true),true);assert.equal(c.document.activeElement,c.ok);
  assert.equal(c.key('Tab'),true);assert.equal(c.document.activeElement,c.input);
  c.ok.disabled=true;c.cancel.focus();c.key('Tab');assert.equal(c.document.activeElement,c.input);
  c.key('Escape');assert.equal(c.modal.innerHTML,'');assert.equal(c.app.inert,false);assert.equal(c.document.activeElement,c.trigger);
});
test('替换弹窗后仍恢复最初触发焦点',()=>{
  const c=client();c.run("openModal('第一步','',()=>{});openModal('第二步','',()=>{});closeModal()");
  assert.equal(c.document.activeElement,c.trigger);
});
