'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../src/router');

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test('所有接口在进入处理器前拦截侮辱性和政治敏感文本', () => {
  const router = createRouter({ db: null, deps: {} });
  let calls = 0;
  router.addPublic('POST', '/api/input', () => { calls += 1; });

  const political = response();
  router.dispatch('POST', '/api/input', { method: 'POST' }, political, {}, { note: '请讨论天安门' });
  assert.equal(political.status, 400);
  assert.match(political.body.error, /政治敏感/);
  assert.equal(calls, 0);

  const insulting = response();
  router.dispatch('POST', '/api/input', { method: 'POST' }, insulting, {}, { nested: { text: '你是傻逼' } });
  assert.equal(insulting.status, 400);
  assert.match(insulting.body.error, /侮辱性/);
  assert.equal(calls, 0);
});

test('密码、密钥、令牌和头像等非文本字段不参与内容检测', () => {
  const router = createRouter({ db: null, deps: {} });
  let calls = 0;
  router.addPublic('POST', '/api/input', () => { calls += 1; });
  const res = response();
  router.dispatch('POST', '/api/input', { method: 'POST' }, res, { accessToken: '天安门' }, {
    password: '傻逼', modelKey: '天安门', avatar: 'data:image/jpeg;base64,傻逼', text: '正常提交',
  });
  assert.equal(calls, 1);
  assert.equal(res.status, undefined);
});
