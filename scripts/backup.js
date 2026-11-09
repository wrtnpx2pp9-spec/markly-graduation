'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Backup must not run migrations on the source database before copying it.
function backupDatabase(source, outputDir) {
  source = path.resolve(source);
  if (!fs.existsSync(source)) throw new Error('数据库不存在：' + source);
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(path.resolve(outputDir), `app-${stamp}-${process.pid}.db`);
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(output); }
  finally { db.close(); }
  const copy = new DatabaseSync(output, { readOnly: true });
  try {
    if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
      throw new Error('备份完整性检查失败：' + output);
    }
  } finally { copy.close(); }
  return output;
}

if (require.main === module) {
  const source = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  const output = backupDatabase(source, process.env.BACKUP_DIR || path.join(path.dirname(source), 'backups'));
  console.log(`Backup created: ${output}`);
  console.log(`Source: ${path.resolve(source)}`);
}
module.exports = { backupDatabase };
