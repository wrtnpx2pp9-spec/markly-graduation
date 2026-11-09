'use strict';

function fmt(ts) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function taskMessages(task, phase) {
  const title = task.title;
  if (phase === 'remind') return {
    assigneeKind: 'task_remind', assigneeTitle: '该做这件事了：' + title,
    assigneeContent: '别忘了完成「' + title + '」' + (task.due_at ? '，截止 ' + fmt(task.due_at) : '') + '。完成后来打卡。',
    creatorKind: 'supervise_remind', creatorTitle: '该去监督完成了：' + title,
    creatorContent: '他有一项任务到点还未完成，记得去督促：「' + title + '」。',
  };
  if (phase === 'overdue') return {
    assigneeKind: 'task_overdue', assigneeTitle: '任务已超时：' + title,
    assigneeContent: '「' + title + '」已超过截止时间（' + fmt(task.due_at) + '），尽快完成或说明情况。',
    creatorKind: 'supervise_overdue', creatorTitle: '任务已超时，需要跟进：' + title,
    creatorContent: '「' + title + '」已超时未完成，建议尽快跟进。',
  };
  if (phase === 'followup') return {
    assigneeKind: 'task_overdue_followup', assigneeTitle: '任务仍未完成，请优先处理：' + title,
    assigneeContent: '「' + title + '」仍处于超时状态。请尽快提交完成，或联系监督者调整安排。',
    creatorKind: 'supervise_overdue_followup', creatorTitle: '任务持续超时，请跟进：' + title,
    creatorContent: '「' + title + '」超时后仍未完成，请确认原因并协助调整。',
  };
  throw new Error('unknown task reminder phase');
}

function dayMessages(day, phase) {
  if (phase === 'remind') return {
    assigneeKind: 'plan_remind', assigneeTitle: '该做今天的打卡了：' + day.plan_title + ' 第' + day.seq + '天',
    assigneeContent: '今天要：' + (day.content || '按时打卡') + '。完成后去打个卡吧。',
    creatorKind: 'plan_supervise', creatorTitle: '今天该打卡了：' + day.plan_title + ' 第' + day.seq + '天',
    creatorContent: 'TA 今天还没打卡，记得去看看完成情况。',
  };
  if (phase === 'miss') return {
    assigneeKind: 'plan_miss', assigneeTitle: '昨天的打卡漏了：' + day.plan_title + ' 第' + day.seq + '天',
    assigneeContent: '「' + (day.content || '当日打卡') + '」昨天没打卡，今天补上或说明一下。',
    creatorKind: 'plan_miss_sup', creatorTitle: 'TA 漏了一天打卡：' + day.plan_title + ' 第' + day.seq + '天',
    creatorContent: '昨天的打卡还没做，去问问他原因、安排补上。',
  };
  throw new Error('unknown daily reminder phase');
}

module.exports = { taskMessages, dayMessages };
