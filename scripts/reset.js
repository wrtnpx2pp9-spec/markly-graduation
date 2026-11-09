'use strict';
/* 重置配置中的数据库及其 WAL/SHM 文件；仅用于明确要清空的本地测试环境。 */
const fs = require('fs');
const path = require('path');

function resetDatabase() {
  const configured = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  if (configured === ':memory:') {
    console.log('DB_PATH=:memory: 使用内存数据库，无需磁盘重置。');
    return;
  }
  const database = path.resolve(configured);
  console.log('重置数据库：', database);
  const files = [database, database + '-shm', database + '-wal'].filter(file => {
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('重置目标不是普通文件：' + file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });

  // 检查完全部目标再开始删除，避免可预先识别的类型或权限问题导致部分重置。
  for (const file of files) {
    fs.accessSync(file, fs.constants.W_OK);
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
  }
  for (const file of files) {
    try { fs.unlinkSync(file); }
    catch (error) { throw new Error('删除失败：' + file + '；' + error.message); }
    console.log('已删除', file);
  }
  if (!files.length) console.log('没有可删除的数据库文件（可能已是全新状态）。');
  console.log('完成。下次启动将引导创建管理员账号。');
}

try { resetDatabase(); }
catch (error) {
  console.error('重置失败：' + error.message);
  process.exitCode = 1;
}
