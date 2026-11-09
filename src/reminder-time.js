'use strict';

// Reminders follow the deployment's local clock, including 23/25-hour days.
function dayReminderAt(now, hour) {
  const date = new Date(now);
  date.setHours(hour ?? 20, 0, 0, 0);
  return date.getTime();
}

module.exports = { dayReminderAt };
