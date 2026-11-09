'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('a slow earlier workspace refresh cannot overwrite a newer completed refresh',async()=>{
  const pending=[];
  const request=()=>{const d=deferred();pending.push(d);return d.promise;};
  const context=vm.createContext({token:'session',me:{id:'user'},st:{},apiAll:request,api:request});
  vm.runInContext(fs.readFileSync('public/js/auth.js','utf8'),context);
  const first=vm.runInContext('loadSection()',context),second=vm.runInContext('loadSection()',context);
  pending[3].resolve([{id:'new-task'}]);pending[4].resolve([{id:'new-plan'}]);pending[5].resolve({days:[{id:'new-day'}]});await second;
  pending[0].resolve([{id:'old-task'}]);pending[1].resolve([{id:'old-plan'}]);pending[2].resolve({days:[{id:'old-day'}]});await first;
  assert.equal(context.st.tasks[0].id,'new-task');assert.equal(context.st.plans[0].id,'new-plan');assert.equal(context.st.workDays[0].id,'new-day');
});
test('a notification read mutation prevents an older list response from restoring unread state',async()=>{
  const request=deferred();
  const context=vm.createContext({token:'session',me:{id:'user'},st:{notes:[{id:'n',isRead:true}]},notesReadRevision:1,api:()=>request.promise});
  vm.runInContext(fs.readFileSync('public/js/auth.js','utf8'),context);
  const load=vm.runInContext('loadNotes()',context);context.notesReadRevision++;
  request.resolve({notifications:[{id:'n',isRead:false}],unread:1,nextOffset:null});await load;
  assert.equal(context.st.notes[0].isRead,true);
});
test('loading an older notifications page does not rewind desktop notification history or notify',async()=>{
  const sent=[];
  const context=vm.createContext({token:'session',me:{id:'user'},st:{notes:[{id:'latest',createdAt:1000}],lastSeenNoteAt:1000},notesReadRevision:0,
    api:async()=>({notifications:[{id:'old',createdAt:1}],nextOffset:null,unread:1}),
    mergeNotes:(a,b)=>a.concat(b),maybeDesktopNotify:rows=>sent.push(...rows),updateBadge:()=>{},unread:0});
  vm.runInContext(fs.readFileSync('public/js/auth.js','utf8'),context);
  await vm.runInContext('loadNotes(100)',context);
  assert.equal(context.st.lastSeenNoteAt,1000);assert.equal(context.st.notes.length,2);assert.deepEqual(sent,[]);
});
