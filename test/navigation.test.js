'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function client(role = 'supervisee') {
  const storage = new Map(), events = {};
  const location = { pathname: '/', search: '?source=test', hash: '' };
  const context = vm.createContext({
    me: { id: 'u1', role }, st: { view: 'dashboard' }, location,
    sessionStorage: { setItem: (k,v)=>storage.set(k,v) },
    history: Object.fromEntries(['pushState','replaceState'].map(method=>[method, (_a,_b,url)=>{location.hash=url.slice(url.indexOf('#'));context.urls.push(url);} ])),
    urls: [], renders: 0, closed: 0, messages: [],
    closeModal: ()=>context.closed++, toast: m=>context.messages.push(m),
    window: { addEventListener: (name,fn)=>events[name]=fn, scrollTo() {} }
  });
  const source = fs.readFileSync('public/js/shell.js','utf8');
  vm.runInContext(source.slice(source.indexOf('function allowedViews()'),source.indexOf('async function refreshTasksInPlace')),context);
  context.renderApp = ()=>context.renders++;
  return { context, storage, events, run: code=>vm.runInContext(code,context) };
}
test('navigation replaces stale profile links and restores back/forward destinations', ()=>{
  const {context:c,events,run}=client();
  run("st.profileId='a/b';goView('profile')");assert.equal(c.location.hash,'#profile/a%2Fb');
  run("goView('tasks')");assert.equal(c.location.hash,'#tasks');assert.equal(c.urls.at(-1),'/?source=test#tasks');
  c.location.hash='#profile/a%2Fb';events.popstate();assert.equal(c.st.view,'profile');assert.equal(c.st.profileId,'a/b');
  c.location.hash='#tasks';events.popstate();assert.equal(c.st.view,'tasks');
});
test('routes reject wrong roles and malformed detail URLs, preserving account scoped state',()=>{
  const {context:c,storage,run}=client();run("goView('users')");assert.equal(c.st.view,'dashboard');
  c.location.hash='#request/%ZZ';run('routeProfileHash()');assert.equal(c.st.view,'dashboard');assert.equal(c.messages.length,1);
  c.location.hash='#request/r1';run('routeProfileHash()');assert.equal(c.st.requestId,'r1');assert.equal(c.st.view,'request');
  assert.equal(storage.get('sd_last_view:u1'),'request');
  const admin=client('admin');admin.run("goView('tasks')");assert.equal(admin.context.st.view,'overview');
});
test('hash navigation renders once when popstate and hashchange both fire',()=>{
  const {context:c,events}=client();c.location.hash='#notes';events.popstate();events.hashchange();assert.equal(c.renders,1);
});
test('malformed API path returns 400 without invoking a handler',()=>{
  const {createRouter}=require('../src/router');const router=createRouter({db:null,deps:{}});
  router.addPublic('GET','/api/items/:id',()=>assert.fail('must not dispatch'));
  let status,body;router.dispatch('GET','/api/items/%ZZ',{}, {writeHead: s=>status=s,end:b=>body=b},{},{});
  assert.equal(status,400);assert.match(JSON.parse(body).error,/编码/);
});
