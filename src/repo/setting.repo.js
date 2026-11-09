'use strict';
/** 键值设置（如外部通知配置）数据访问。 */
function get(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}
function set(db, key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value);
}

module.exports = { get, set };
