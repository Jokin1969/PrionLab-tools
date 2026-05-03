const cron = require('node-cron');
const emailService = require('./emailService');
const recommendationEngine = require('../utils/recommendationEngine');
const { User, UserArticle, Article } = require('../models');

const INACTIVITY_DAYS = 14;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getUserStats(userId) {
  const rows = await UserArticle.findAll({ where: { user_id: userId } });
  const total = rows.length;
  const evaluated = rows.filter((r) => r.status === 'evaluated').length;
  const completionPct = total > 0 ? Math.round((evaluated / total) * 100) : 0;
  return { total, evaluated, completionPct };
}

async function getPendingArticles(userId, limit = 5) {
  const rows = await UserArticle.findAll({
    where: { user_id: userId, status: 'pending' },
    include: [{ model: Article, as: 'article', attributes: ['id', 'title', 'authors', 'year', 'priority', 'is_milestone', 'tags'] }],
    order: [
      [{ model: Article, as: 'article' }, 'is_milestone', 'DESC'],
      [{ model: Article, as: 'article' }, 'priority', 'DESC'],
      [{ model: Article, as: 'article' }, 'year', 'DESC'],
    ],
    limit,
  });
  return rows.map((r) => r.article).filter(Boolean);
}

function daysSince(date) {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
}

// ─── Core send functions ──────────────────────────────────────────────────────

async function sendWeeklyReminder(user) {
  const [stats, pendingArticles] = await Promise.all([
    getUserStats(user.id),
    getPendingArticles(user.id, 5),
  ]);

  if (pendingArticles.length === 0) return { skipped: true, reason: 'no pending articles' };

  await emailService.sendReminderEmail(user, pendingArticles, stats.completionPct);
  return { sent: true };
}

async function sendWeeklyRemindersToAll() {
  const students = await User.findAll({ where: { role: 'student' } });
  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const student of students) {
    try {
      const outcome = await sendWeeklyReminder(student);
      if (outcome.sent) results.sent++;
      else results.skipped++;
    } catch (err) {
      console.error(`[notificationService] weekly reminder failed for user ${student.id}:`, err.message);
      results.errors++;
    }
  }

  console.log(`[notificationService] weekly reminders: sent=${results.sent} skipped=${results.skipped} errors=${results.errors}`);
  return results;
}

async function sendInactivityReminders() {
  const students = await User.findAll({ where: { role: 'student' } });
  const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 86_400_000);
  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const student of students) {
    try {
      // Find most recent activity
      const latest = await UserArticle.findOne({
        where: { user_id: student.id },
        order: [['updated_at', 'DESC']],
        attributes: ['updated_at', 'status'],
      });

      const inactive = !latest || new Date(latest.updated_at) < cutoff;
      if (!inactive) { results.skipped++; continue; }

      const [stats, pendingArticles] = await Promise.all([
        getUserStats(student.id),
        getPendingArticles(student.id, 5),
      ]);

      if (pendingArticles.length === 0) { results.skipped++; continue; }

      const days = daysSince(latest?.updated_at);
      const message = `Llevamos ${days === Infinity ? 'un tiempo' : `${days} días`} sin verte por aquí. ¡Recuerda que tienes artículos pendientes que te esperan!`;

      await emailService.sendCustomEmail(
        student,
        'Te echamos de menos en PrionRead',
        message,
        pendingArticles,
      );

      results.sent++;
    } catch (err) {
      console.error(`[notificationService] inactivity reminder failed for user ${student.id}:`, err.message);
      results.errors++;
    }
  }

  console.log(`[notificationService] inactivity reminders: sent=${results.sent} skipped=${results.skipped} errors=${results.errors}`);
  return results;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function initializeScheduledTasks() {
  // Weekly reminders — every Monday at 09:00 Europe/Madrid
  cron.schedule('0 9 * * 1', () => {
    console.log('[notificationService] running weekly reminders');
    sendWeeklyRemindersToAll().catch((err) =>
      console.error('[notificationService] weekly cron error:', err)
    );
  }, { timezone: 'Europe/Madrid' });

  // Inactivity reminders — every other Wednesday at 10:00 Europe/Madrid
  // node-cron doesn't support biweekly natively; use weekly and filter by ISO week number
  cron.schedule('0 10 * * 3', () => {
    const weekNumber = Math.ceil(new Date().getDate() / 7);
    if (weekNumber % 2 !== 0) return; // run only on even weeks
    console.log('[notificationService] running inactivity reminders');
    sendInactivityReminders().catch((err) =>
      console.error('[notificationService] inactivity cron error:', err)
    );
  }, { timezone: 'Europe/Madrid' });

  console.log('[notificationService] scheduled tasks initialized');
}

module.exports = {
  sendWeeklyReminder,
  sendWeeklyRemindersToAll,
  sendInactivityReminders,
  initializeScheduledTasks,
};
