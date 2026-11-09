'use strict';
const { textViolation } = require('../content-safety');

// A plan source is untrusted data, even when supplied by the job owner. These
// patterns are not legitimate planning facts: they try to change the agent's
// authority or make it disclose/deliver data outside the reviewed draft.
const CONTROL_INSTRUCTION = /忽略[\s\S]{0,24}(?:指令|规则|要求)|(?:系统提示词|开发者消息|越狱|提示词注入|prompt\s*injection)|(?:调用|启用|使用)[\s\S]{0,20}(?:工具|浏览器|终端|接口|API)|(?:读取|导出|复制|上传|泄露)[\s\S]{0,24}(?:数据|文件|对话|密钥|令牌|隐私|个人信息)/iu;
const OUTBOUND_INSTRUCTION = /(?:发送|转发|分享|投递|上传)[\s\S]{0,32}(?:给|至|到|微信|邮箱|邮件|手机|电话|群|联系人|外部|网址|链接)|(?:收件人|抄送|联系人|微信号|手机号|邮箱地址)/iu;
const CONTACT_DATA = /(?:1[3-9]\d{9}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;

function unsafeText(value) {
  const moderation = textViolation(value);
  if (moderation) return moderation;
  if (CONTROL_INSTRUCTION.test(value)) return '资料含有试图改变智能体权限或读取数据的指令，不能交给 Pi 处理';
  if (OUTBOUND_INSTRUCTION.test(value)) return '资料含有外发或指定接收人的指令；Pi 不处理发送、转发或数据交付';
  if (CONTACT_DATA.test(value)) return '资料含有联系方式或个人联系数据，不能交给 Pi 处理';
  return null;
}

function validateInput({ instruction, sourceText }) {
  for (const [label, value] of [['编排说明', instruction], ['导入资料', sourceText]]) {
    if (typeof value !== 'string' || !value) continue;
    const error = unsafeText(value);
    if (error) return `${label}${error}`;
  }
  return null;
}

// The model must never introduce sources, links, recipients or contact data
// into a draft. The structured candidate is scanned independently of prompts.
function candidateViolation(value, field = '', depth = 0) {
  if (depth > 16 || value == null) return null;
  if (field === 'personId') return null; // server-owned structural identifier
  if (field === 'resourceRefs') {
    return Array.isArray(value) && value.length ? '候选计划不能添加外部资料、链接或资源引用' : null;
  }
  if (typeof value === 'string') return unsafeText(value) ? '候选计划包含不允许的外发、隐私或不安全内容' : null;
  if (Array.isArray(value)) {
    for (const item of value) { const error = candidateViolation(item, field, depth + 1); if (error) return error; }
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { const error = candidateViolation(item, key, depth + 1); if (error) return error; }
  }
  return null;
}

function provenance() {
  return { sourceKind: 'supervisor-provided', trust: 'untrusted-data', screened: true, usableAs: 'planning-facts-only', forbiddenAs: 'instructions, permissions, recipients, delivery requests, external links' };
}

module.exports = { validateInput, candidateViolation, provenance };
