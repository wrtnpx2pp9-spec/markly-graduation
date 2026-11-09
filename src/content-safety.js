'use strict';

// This is a server-side baseline, applied before every API handler. It is
// deliberately independent of the nickname policy: ordinary form text is not
// required to be Chinese, but it must not contain prohibited content.
const RULES = [
  {
    pattern: /傻逼|傻B|煞笔|脑残|废物|垃圾人|狗东西|婊子|贱人|滚蛋|去死/iu,
    message: '输入内容包含侮辱性词汇，请修改后再提交',
  },
  {
    pattern: /共产党|中共|习近平|法轮功|六四|天安门|台独|港独|藏独|新疆独立/iu,
    message: '输入内容包含政治敏感词汇，请修改后再提交',
  },
];

// Credentials and binary payloads are not user-facing prose. Do not inspect
// them: scanning a password/secret is both unnecessary and can create false
// positives, while scanning a Base64 avatar wastes work.
const EXCLUDED_FIELD = /(?:password|token|secret|key|credential|authorization|avatar|base64|file)$/i;

function textViolation(value) {
  if (typeof value !== 'string') return null;
  for (const rule of RULES) {
    if (rule.pattern.test(value)) return rule.message;
  }
  return null;
}

function inputViolation(value, fieldName = '', depth = 0) {
  if (EXCLUDED_FIELD.test(fieldName) || depth > 12 || value == null) return null;
  if (typeof value === 'string') return textViolation(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = inputViolation(item, fieldName, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const error = inputViolation(item, key, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

module.exports = { inputViolation, textViolation };
