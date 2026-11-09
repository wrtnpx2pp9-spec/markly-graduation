'use strict';
const { textViolation } = require('./content-safety');
// A local deny-list is a defensive baseline. Administrators should still have
// an audit/review path for evasive spellings or newly emerging terms.
const CONTACT = /微信|微\s*信|手机|电话|联系方式|联系我|加我|扣扣|QQ|qq|邮箱|邮\s*箱/;
function validate(value) {
  if (typeof value !== 'string') return '昵称只能使用中文';
  const name = value.trim();
  if (!/^[\u3400-\u4DBF\u4E00-\u9FFF]{1,7}$/.test(name)) return '昵称只能使用 1—7 个汉字';
  if (CONTACT.test(name)) return '昵称不能包含联系方式';
  const violation = textViolation(name);
  if (violation?.includes('侮辱性')) return '昵称不能包含侮辱性词汇';
  if (violation?.includes('政治敏感')) return '昵称不能包含政治敏感词汇';
  return null;
}
module.exports = { validate };
