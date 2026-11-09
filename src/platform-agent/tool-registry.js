'use strict';
function text(value) { return [{ type: 'text', text: JSON.stringify(value) }]; }

function createTools(Type, { overview, findUsers, getProfile, readRecords, projectTree, projectFile, schema, saveReport, send, audit }) {
  const sent = new Set();
  return [
    { name: 'get_platform_operations_overview', label: '读取平台运营概览', description: '读取仅含计数和状态的运营概览。', parameters: Type.Object({}), executionMode: 'sequential', execute: async () => { audit('overview'); return { content: text(overview()), details: { ok: true } }; } },
    { name: 'find_platform_users', label: '查找平台用户', description: '按显示名、平台账号或角色查询最多 20 名用户。', parameters: Type.Object({ query: Type.String(), role: Type.Optional(Type.String()) }), executionMode: 'sequential', execute: async (_id, params) => { audit('find_users'); return { content: text(findUsers(params.query, params.role)), details: { ok: true } }; } },
    { name: 'get_user_operations_profile', label: '读取用户运营资料', description: '读取一名用户的管理资料与运营汇总，不含密码、令牌或通道凭据。', parameters: Type.Object({ userId: Type.String() }), executionMode: 'sequential', execute: async (_id, params) => { audit('user_profile'); return { content: text(getProfile(params.userId)), details: { ok: true } }; } },
    { name: 'read_platform_records', label: '读取平台业务记录', description: 'kind 可选 tasks、plans、lifeLogs、notifications、activity；使用 operationsQueue 读取注册、认证与协商待办（最多各50条，不含联系信息或核验材料）；仅只读，不提供修改或删除能力。', parameters: Type.Object({ kind: Type.String(), userId: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }), executionMode: 'sequential', execute: async (_id, params) => { audit('records:' + params.kind); return { content: text(readRecords(params.kind, params.userId, params.limit)), details: { ok: true } }; } },
    { name: 'read_project_tree', label: '读取项目目录', description: '只读列出受允许的项目源码、前端和文档文件；不含环境变量、密钥、数据文件或项目外文件。', parameters: Type.Object({}), executionMode: 'sequential', execute: async () => { audit('project_tree'); return { content: text(projectTree()), details: { ok: true } }; } },
    { name: 'read_project_file', label: '读取项目文件', description: '只读读取受允许项目文件的限定行数；不含 .env、密钥、数据库或项目外文件。', parameters: Type.Object({ path: Type.String(), startLine: Type.Optional(Type.Number()), endLine: Type.Optional(Type.Number()) }), executionMode: 'sequential', execute: async (_id, params) => { audit('project_file'); return { content: text(projectFile(params.path, params.startLine, params.endLine)), details: { ok: true } }; } },
    { name: 'read_database_schema', label: '读取数据库结构', description: '只读读取平台数据库表和索引定义。', parameters: Type.Object({}), executionMode: 'sequential', execute: async () => { audit('database_schema'); return { content: text(schema()), details: { ok: true } }; } },
    { name: 'save_operations_report', label: '保存运营分析报告', description: '保存本次运营报告供管理员在后台查看。', parameters: Type.Object({ title: Type.String(), summary: Type.String(), sections: Type.Any(), chartSpecs: Type.Any() }), executionMode: 'sequential', execute: async (_id, params) => { audit('save_report'); const result=saveReport(params); return { content: text(result), details: result }; } },
    { name: 'send_platform_notification', label: '发送平台站内通知', description: '向一名启用的普通平台用户发送一条站内通知。每名用户最多一次。', parameters: Type.Object({ userId: Type.String(), title: Type.String(), content: Type.String() }), executionMode: 'sequential', execute: async (_id, params) => {
        if (sent.has(params.userId)) return { content: text({ ok: false, error: '本次任务已向该用户发送过通知' }), details: { ok: false } };
      audit('notify'); const result = send(params.userId, params.title, params.content);
      if (result.ok) sent.add(params.userId);
      return { content: text(result), details: result };
    } },
  ];
}
module.exports = { createTools };
