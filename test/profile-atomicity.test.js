'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
const profiles = require('../src/repo/profile.repo');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/market.ctrl').register(router, deps);
function call(user, body) {
  current = users.byId(db, user.id);
  let result;
  router.dispatch('PUT', '/api/profile/me', { method: 'PUT', headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
const original = { headline: '原简介', bio: '原内容', skills: ['阅读'], serviceStyle: '原方式', published: false, publicVisible: false, accepting: true };
const changed = { displayName: '新昵称', gender: 'female', headline: '新简介', bio: '新内容', skills: ['写作'], serviceStyle: '新方式', publicVisible: true };
for (const existing of [false, true]) {
  test(`profile save rolls back both tables on account update failure (${existing ? 'existing' : 'new'} profile), then can retry`, () => {
    const user = users.insert(db, { username: `profile-atomic-${++sequence}`, displayName: '原昵称', role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
    if (existing) profiles.save(db, user.id, original);
    const beforeProfile = db.prepare('SELECT * FROM user_profiles WHERE user_id=?').get(user.id);
    const beforeUser = users.byId(db, user.id);
    db.exec("CREATE TEMP TRIGGER reject_profile_account BEFORE UPDATE OF display_name,gender ON users BEGIN SELECT RAISE(ABORT, 'injected account failure'); END");
    try {
      assert.throws(() => call(user, changed), /injected account failure/);
      assert.deepEqual(db.prepare('SELECT * FROM user_profiles WHERE user_id=?').get(user.id), beforeProfile);
      assert.deepEqual(users.byId(db, user.id), beforeUser);
    } finally { db.exec('DROP TRIGGER reject_profile_account'); }
    assert.equal(call(user, changed).status, 200);
    assert.equal(profiles.own(db, user.id).headline, changed.headline);
    assert.equal(profiles.own(db, user.id).publicVisible, true);
    assert.equal(users.byId(db, user.id).display_name, changed.displayName);
    assert.equal(users.byId(db, user.id).gender, changed.gender);
    db.prepare('DELETE FROM user_profiles WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  });
}
test.after(() => database.closeDb());
