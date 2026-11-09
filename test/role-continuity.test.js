'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-role-continuity-'));
process.env.DB_PATH = path.join(temp, 'app.db');
process.env.ILINK_STATE_DIR = path.join(temp, 'ilink');
const database = require('../src/db'), users = require('../src/repo/user.repo');
let db = database.getDb(), router, current, sequence = 0;
function routes() {
  const deps = { db, notify: { deliver() {} }, security: { authenticate: () => ({ user: users.byId(db, current.id) }) } };
  router = require('../src/router').createRouter({ db, deps });
  for (const name of ['auth', 'market']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
}
routes();
function add(role, identity = '') {
  const user = users.insert(db, { username: `continuity-${++sequence}`, displayName: `身份测试${sequence}`, role, passwordHash: 'isolated-hash', salt: 'isolated-salt', createdAt: Date.now() });
  db.prepare('UPDATE users SET identity=? WHERE id=?').run(identity, user.id);
  return user;
}
function pair() {
  const supervisor = add('supervisor', 'mentor'), supervisee = add('supervisee', 'mentee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated',capacity_override=10 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  return { supervisor, supervisee };
}
function get(actor, url) {
  current = actor;
  let result;
  router.dispatch('GET', url, { method: 'GET', headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, {});
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}
test.after(() => { database.closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });

test('真实合作成员接口保留导师和学员身份，权限仍使用基础角色', () => {
  const { supervisor, supervisee } = pair();
  const mentor = get(supervisee, '/api/people').people.find(person => person.id === supervisor.id);
  assert.equal(mentor.identity, 'mentor'); assert.equal(mentor.role, 'supervisor');
  const mentee = get(supervisor, '/api/people').people.find(person => person.id === supervisee.id);
  assert.equal(mentee.identity, 'mentee'); assert.equal(mentee.role, 'supervisee');
  assert.doesNotMatch(JSON.stringify([mentor, mentee]), /password|salt|agreement_ref|isolated-hash/);
});

test('可选择对象只增加展示身份，仍不公开账号及私人资料', () => {
  const { supervisor } = pair(), available = add('supervisee', 'mentee');
  const person = get(supervisor, '/api/people').people.find(person => person.id === available.id);
  assert.equal(person.identity, 'mentee');
  assert.deepEqual(Object.keys(person).sort(), ['displayName', 'id', 'identity', 'relationship', 'role']);
  assert.equal(person.relationship, 'available');
});

test('自己和已授权对方的主页保留展示身份，旧身份不匹配时按当前角色回退', () => {
  const { supervisor, supervisee } = pair();
  assert.equal(get(supervisor, '/api/profile/me').profile.identity, 'mentor');
  assert.equal(get(supervisee, `/api/profiles/${supervisor.id}`).profile.identity, 'mentor');
  assert.equal(get(supervisor, `/api/profiles/${supervisee.id}`).profile.identity, 'mentee');
  const profiles = require('../src/repo/profile.repo');
  profiles.save(db, supervisor.id, { headline: '导师', bio: '', skills: [], serviceStyle: '', published: true, publicVisible: false, accepting: true });
  assert.equal(profiles.marketProfiles(db).find(row => row.id === supervisor.id).identity, 'mentor');
  assert.equal(get(supervisee, '/api/market').list.find(row => row.id === supervisor.id).identity, 'mentor');
  const legacy = add('supervisee', 'mentor');
  assert.equal(get(legacy, '/api/profile/me').profile.identity, 'supervisee');
  assert.equal(get(legacy, '/api/auth/me').user.identity, 'supervisee');
  assert.equal(users.byId(db, legacy.id).identity, 'mentor', '读取不批量重写历史身份');
});

test('数据库重开及迁移后合作关系、身份与当前账号返回仍一致', () => {
  const { supervisor, supervisee } = pair();
  const period = db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(supervisor.id, supervisee.id).id;
  database.closeDb(); db = database.getDb(); routes();
  assert.equal(get(supervisor, '/api/auth/me').user.identity, 'mentor');
  assert.equal(get(supervisee, '/api/auth/me').user.identity, 'mentee');
  assert.equal(get(supervisee, '/api/people').people.find(person => person.id === supervisor.id).identity, 'mentor');
  assert.equal(db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(supervisor.id, supervisee.id).id, period);
});

test('管理员最近用户与账号接口展示同一身份，异常旧值按基础角色回退', () => {
  const { supervisor, supervisee } = pair(), legacy = add('supervisee', 'mentor');
  const recent = require('../src/controllers/admin.ctrl').readOverview(db).recentUsers;
  for (const [user, identity] of [[supervisor, 'mentor'], [supervisee, 'mentee'], [legacy, 'supervisee']]) {
    assert.equal(recent.find(row => row.id === user.id).identity, identity);
  }
  assert.doesNotMatch(JSON.stringify(recent), /password|salt|agreement_ref|isolated-hash/);
});
