'use strict';
// These are deliberately the only capabilities visible to the model. In
// particular, it gets no shell, filesystem, HTTP, account, notification, or
// plan-publishing capability.
function text(value) { return [{ type: 'text', text: JSON.stringify(value) }]; }
function createTools(Type, { context, saveCandidate }) {
  return [
    { name: 'read_plan_context', label: '读取计划上下文', description: '读取本次任务的约束、可编辑模板和要求。必须先调用。', parameters: Type.Object({}), executionMode: 'sequential', execute: async () => ({ content: text(context), details: { read: true } }) },
    { name: 'save_plan_candidate', label: '提交候选计划', description: '提交完整 workspace JSON。服务端会严格校验；校验失败时根据错误修改后再次提交。', parameters: Type.Object({ workspace: Type.Any() }), executionMode: 'sequential', execute: async (_id, params) => { const result = saveCandidate(params.workspace); return { content: text(result), details: result }; } }
  ];
}
module.exports = { createTools };
