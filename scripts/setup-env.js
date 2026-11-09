'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const destination = path.join(__dirname, '..', '.env');
const template = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
const contents = template.replace(/^SETUP_TOKEN=.*$/m, 'SETUP_TOKEN=' + crypto.randomBytes(32).toString('hex'))
  .replace(/^PLAN_AGENT_MASTER_KEY=.*$/m, 'PLAN_AGENT_MASTER_KEY=' + crypto.randomBytes(32).toString('hex'))
  .replace(/^ADMIN_AGENT_SECONDARY_PASSWORD=.*$/m, 'ADMIN_AGENT_SECONDARY_PASSWORD=' + crypto.randomBytes(32).toString('hex'));
try {
  fs.writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env。请在本机编辑器查看 SETUP_TOKEN 完成首次初始化，并将此文件安全备份。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('.env 已存在，未覆盖任何配置。请按 .env.example 手工补充缺失项。');
  process.exitCode = 1;
}
