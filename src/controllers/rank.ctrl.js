'use strict';
/**
 * 激励排行榜。统计必须是集合查询：原实现会为每一名成员再查询其监督关系，
 * 在组员/平台用户增加后会放大成 N+1 次数据库访问。
 */
const { sendJson } = require('../router');

function activeMembers(db, user, scope) {
  const columns = 'u.id,u.display_name,u.avatar';
  if (scope === 'all') return db.prepare(`SELECT ${columns} FROM users u WHERE u.role='supervisee' AND u.status=1 ORDER BY u.id`).all();
  if (user.role === 'supervisor') {
    return db.prepare(`SELECT ${columns} FROM users u JOIN supervision_relations r ON r.supervisee_id=u.id
      WHERE u.role='supervisee' AND u.status=1 AND r.supervisor_id=? AND r.status='active' ORDER BY u.id`).all(user.id);
  }
  if (user.role === 'supervisee') {
    return db.prepare(`SELECT DISTINCT ${columns} FROM users u
      JOIN supervision_relations member ON member.supervisee_id=u.id AND member.status='active'
      JOIN supervision_relations mine ON mine.supervisor_id=member.supervisor_id AND mine.supervisee_id=? AND mine.status='active'
      WHERE u.role='supervisee' AND u.status=1 ORDER BY u.id`).all(user.id);
  }
  return [];
}

function keyed(rows) { return new Map(rows.map(row => [row.assignee_id, row])); }
function number(value) { return Number(value) || 0; }

function register(router) {
  router.add('GET', '/api/rank', (c) => {
    const { db, user, query } = c;
    const scope = query.scope === 'all' ? 'all' : 'group';
    const dim = ['plan', 'today', 'checkin'].includes(query.dim) ? query.dim : 'plan';
    const members = activeMembers(db, user, scope);
    if (!members.length) return sendJson(c.res, 200, { list: [], date: todayLabel() });

    const ids = members.map(member => member.id), slots = ids.map(() => '?').join(',');
    const start = dayStart();
    const nextDay = new Date(start); nextDay.setDate(nextDay.getDate() + 1);
    const end = nextDay.getTime();
    const dateBuckets = Array.from({ length: 7 }, (_, index) => {
      const from = new Date(start); from.setDate(from.getDate() + index - 6);
      const to = new Date(from); to.setDate(to.getDate() + 1);
      return { key: dayKey(from.getTime()), start: from.getTime(), end: to.getTime() };
    });
    const recentStart = dateBuckets[0].start;
    const today = dayKey(start), recentDay = dayKey(recentStart);
    // Share JavaScript's local calendar boundaries; SQLite localtime may use a
    // different zone on Windows. Dates also let task/day activity be deduped.
    const taskDateCase = 'CASE ' + dateBuckets.map(() => 'WHEN done_at>=? AND done_at<? THEN ?').join(' ') + ' END';

    // One aggregate per source replaces loading all historical rows and then
    // filtering them repeatedly in JavaScript. Keep the prior scoring rules:
    // task plan progress is historical, daily-plan progress is recent active work.
    const taskStats = keyed(db.prepare(`SELECT assignee_id,
      SUM(CASE WHEN plan_id IS NOT NULL THEN 1 ELSE 0 END) AS plan_total,
      SUM(CASE WHEN plan_id IS NOT NULL AND status='done' THEN 1 ELSE 0 END) AS plan_done,
      SUM(CASE WHEN due_at>=? AND due_at<? THEN 1 ELSE 0 END) AS due_today,
      SUM(CASE WHEN due_at>=? AND due_at<? AND status='done' THEN 1 ELSE 0 END) AS due_today_done,
      SUM(CASE WHEN status='done' AND done_at>=? AND done_at<? THEN 1 ELSE 0 END) AS checkin_today,
      SUM(CASE WHEN COALESCE(done_at,due_at,created_at)>=? AND COALESCE(done_at,due_at,created_at)<? THEN 1 ELSE 0 END) AS recent_total,
      SUM(CASE WHEN status='done' AND COALESCE(done_at,due_at,created_at)>=? AND COALESCE(done_at,due_at,created_at)<? THEN 1 ELSE 0 END) AS recent_done,
      GROUP_CONCAT(DISTINCT CASE WHEN status='done' THEN ${taskDateCase} END) AS active_dates
      FROM tasks WHERE assignee_id IN (${slots}) AND status<>'cancelled' GROUP BY assignee_id`).all(
      start, end, start, end, start, end, recentStart, end, recentStart, end,
      ...dateBuckets.flatMap(bucket => [bucket.start, bucket.end, bucket.key]), ...ids));
    const dayStats = keyed(db.prepare(`SELECT p.assignee_id,
      COUNT(*) AS plan_total,
      SUM(CASE WHEN d.checkin_state='approved' THEN 1 ELSE 0 END) AS plan_done,
      SUM(CASE WHEN d.day_date=? THEN 1 ELSE 0 END) AS due_today,
      SUM(CASE WHEN d.day_date=? AND d.checkin_state='approved' THEN 1 ELSE 0 END) AS due_today_done,
      SUM(CASE WHEN d.checkin_state='approved' AND d.checkin_reviewed_at>=? AND d.checkin_reviewed_at<? THEN 1 ELSE 0 END) AS checkin_today,
      COUNT(*) AS recent_total,
      SUM(CASE WHEN d.checkin_state='approved' THEN 1 ELSE 0 END) AS recent_done,
      GROUP_CONCAT(DISTINCT CASE WHEN d.checkin_state='approved' THEN d.day_date END) AS active_dates
      FROM plan_days d JOIN plans p ON p.id=d.plan_id
      WHERE p.assignee_id IN (${slots}) AND p.status='active' AND d.status<>'rest' AND d.checkin_state<>'cancelled'
        AND d.day_date>=? AND d.day_date<=? GROUP BY p.assignee_id`).all(today, today, start, end, ...ids, recentDay, today));

    const list = members.map(member => {
      const task = taskStats.get(member.id) || {}, day = dayStats.get(member.id) || {};
      return {
        id: member.id, displayName: member.display_name, avatar: member.avatar || '',
        planTotal: number(task.plan_total) + number(day.plan_total),
        planDone: number(task.plan_done) + number(day.plan_done),
        dueToday: number(task.due_today) + number(day.due_today),
        dueTodayDone: number(task.due_today_done) + number(day.due_today_done),
        checkinToday: number(task.checkin_today) + number(day.checkin_today),
        recentTotal: number(task.recent_total) + number(day.recent_total),
        recentDone: number(task.recent_done) + number(day.recent_done),
        recentActiveDays: new Set([...(task.active_dates || '').split(','), ...(day.active_dates || '').split(',')].filter(Boolean)).size,
      };
    });
    if (dim === 'plan') list.sort((a, b) => pct(b) - pct(a) || b.planDone - a.planDone);
    else if (dim === 'today') list.sort((a, b) => b.dueTodayDone - a.dueTodayDone || b.dueToday - a.dueToday);
    else list.sort((a, b) => b.checkinToday - a.checkinToday);

    // The interface displays the top five and, if necessary, the current user.
    // Returning only those rows avoids sending a full platform-wide roster.
    list.forEach((row, index) => { row.rank = index + 1; });
    const top = list.slice(0, 5);
    const mine = list.find(row => row.id === user.id);
    if (mine && !top.some(row => row.id === mine.id)) top.push(mine);
    sendJson(c.res, 200, { date: todayLabel(), list: top.map(row => ({
      id: row.id, displayName: row.displayName, avatar: row.avatar, rank: row.rank,
      scope, dim, recentDone: row.recentDone, recentTotal: row.recentTotal,
      recentCompletionRate: row.recentTotal ? Math.round((row.recentDone / row.recentTotal) * 100) : 0,
      recentActiveDays: row.recentActiveDays,
      ...(dim === 'plan'
        ? { value: pct(row), label: pct(row) + '%', sub: row.planDone + '/' + row.planTotal + ' 完成' }
        : dim === 'today'
          ? { value: row.dueTodayDone, label: String(row.dueTodayDone), sub: '今日到期 ' + row.dueToday + ' · 完成 ' + row.dueTodayDone }
          : { value: row.checkinToday, label: String(row.checkinToday), sub: '今日打卡 ' + row.checkinToday + ' 次' }),
    })) });
  });
}

function pct(row) { return row.planTotal ? Math.round((row.planDone / row.planTotal) * 100) : 0; }
function dayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayKey(timestamp) { const d = new Date(timestamp), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function todayLabel() { const d = new Date(), p = n => String(n).padStart(2, '0'); return p(d.getMonth() + 1) + '-' + p(d.getDate()); }

module.exports = { register, activeMembers };
