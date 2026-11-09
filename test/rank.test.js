'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const dbPath = path.join(os.tmpdir(), `markly-rank-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
process.env.DB_PATH = dbPath;
const { getDb } = require('../src/db');
const db = getDb();
const users = require('../src/repo/user.repo');
const { createRouter } = require('../src/router');
let current;
const router = createRouter({ db, deps: { security: { authenticate: () => ({ user: current }) } } });
require('../src/controllers/rank.ctrl').register(router);

function add(id, role) {
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES(?,?,?,?,?,?,1,?)').run(id,id,role,'hash','salt',id,Date.now());
  return users.byId(db, id);
}
const supervisor = add('rank-supervisor', 'supervisor');
const members = Array.from({ length: 8 }, (_, i) => add(`rank-sub-${i}`, 'supervisee'));
for (const member of members) db.prepare("INSERT INTO supervision_relations(id,supervisor_id,supervisee_id,status,created_at) VALUES(?,?,?,?,?)").run(`rel-${member.id}`,supervisor.id,member.id,'active',Date.now());
for (let i = 0; i < members.length; i++) db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,status,done_at,created_at) VALUES(?,?,?,?,?,?,?)").run(`task-${i}`,'任务',supervisor.id,members[i].id,i < 7 ? 'done' : 'pending',Date.now(),Date.now());

function call(user, url) {
  current = users.byId(db, user.id);
  const parsed = new URL(url, 'http://local'); let result;
  router.dispatch('GET', parsed.pathname, { method:'GET', headers:{} }, { writeHead(status) { this.status=status; }, end(text) { result={ status:this.status, ...JSON.parse(text) }; } }, Object.fromEntries(parsed.searchParams), {});
  return result;
}

test('排行榜按集合统计，响应只包含前五名和必要时的本人', () => {
  const group = call(supervisor, '/api/rank?scope=group&dim=checkin');
  assert.equal(group.status, 200);
  assert.equal(group.list.length, 5);
  assert.deepEqual(group.list.map(row => row.rank), [1,2,3,4,5]);
  const mine = call(members[7], '/api/rank?scope=group&dim=checkin');
  assert.equal(mine.list.at(-1).id, members[7].id);
  assert.equal(mine.list.at(-1).rank, 8);
});
