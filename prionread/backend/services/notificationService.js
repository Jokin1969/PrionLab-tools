const cron = require('node-cron');
const { Op } = require('sequelize');
const emailService = require('./emailService');
const recommendationEngine = require('../utils/recommendationEngine');
const { User, UserArticle, Article, NotificationRule, NotificationLog, BonusCredit, BonusAllocation, Evaluation } = require('../models');

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

// ─── Monthly report ──────────────────────────────────────────────────────────

const MONTH_NAMES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

async function getMonthlyReportData(userId, forYear, forMonth) {
  // Default: previous calendar month
  const now = new Date();
  const year  = forYear  ?? (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
  const month = forMonth ?? (now.getMonth() === 0 ? 12 : now.getMonth()); // 1-indexed

  const startOfMonth = new Date(year, month - 1, 1);
  const endOfMonth   = new Date(year, month, 1);

  const [
    articlesRaw,
    totalReadCumulative,
    totalAssigned,
    bonusCreditsThisMonth,
    allCredits,
    allocationsThisMonth,
    allAllocations,
    pendingRaw,
  ] = await Promise.all([
    // Articles updated to read/summarized/evaluated status this month
    UserArticle.findAll({
      where: {
        user_id: userId,
        status: { [Op.in]: ['read', 'summarized', 'evaluated'] },
        updated_at: { [Op.gte]: startOfMonth, [Op.lt]: endOfMonth },
      },
      include: [
        { model: Article, as: 'article', attributes: ['id','title','authors','year','journal','is_milestone','pdf_pages'] },
        { model: Evaluation, as: 'evaluations', attributes: ['score','created_at'] },
      ],
    }),
    // Total cumulative read
    UserArticle.count({ where: { user_id: userId, status: { [Op.in]: ['read','summarized','evaluated'] } } }),
    // Total assigned
    UserArticle.count({ where: { user_id: userId } }),
    // Bonus credits earned this month (from reading, not welcome gifts)
    BonusCredit.findAll({
      where: {
        user_id: userId,
        article_id: { [Op.ne]: null },
        created_at: { [Op.gte]: startOfMonth, [Op.lt]: endOfMonth },
      },
      include: [{ model: Article, as: 'article', attributes: ['id','title'] }],
    }),
    // All credits for global balance
    BonusCredit.findAll({ where: { user_id: userId }, attributes: ['minutes_earned'] }),
    // Allocations this month
    BonusAllocation.findAll({
      where: { user_id: userId, created_at: { [Op.gte]: startOfMonth, [Op.lt]: endOfMonth } },
    }),
    // All allocations for global balance
    BonusAllocation.findAll({ where: { user_id: userId }, attributes: ['minutes'] }),
    // Pending articles for motivation
    UserArticle.findAll({
      where: { user_id: userId, status: 'pending' },
      include: [{ model: Article, as: 'article', attributes: ['id','title','authors','year','is_milestone','priority'] }],
      order: [
        [{ model: Article, as: 'article' }, 'is_milestone', 'DESC'],
        [{ model: Article, as: 'article' }, 'priority', 'DESC'],
      ],
      limit: 3,
    }),
  ]);

  // Attach the latest evaluation score to each user article
  const articlesThisMonth = articlesRaw.map((ua) => {
    const sorted = (ua.evaluations || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { ...ua.toJSON(), latestScore: sorted[0]?.score ?? null };
  });

  // Compute averages
  const scores = articlesThisMonth.map((ua) => ua.latestScore).filter((s) => s != null);
  const avgScoreThisMonth = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;

  const minutesEarnedThisMonth   = bonusCreditsThisMonth.reduce((s, c) => s + c.minutes_earned, 0);
  const minutesConsumedThisMonth = allocationsThisMonth.reduce((s, a) => s + a.minutes, 0);
  const totalBalanceMinutes =
    allCredits.reduce((s, c) => s + c.minutes_earned, 0) -
    allAllocations.reduce((s, a) => s + a.minutes, 0);

  const completionPct = totalAssigned > 0
    ? Math.round((totalReadCumulative / totalAssigned) * 100)
    : 0;

  return {
    periodYear: year,
    periodMonth: month,
    monthName: MONTH_NAMES_ES[month - 1],
    articlesThisMonth,
    totalReadCumulative,
    totalAssigned,
    completionPct,
    avgScoreThisMonth,
    bonusCreditsThisMonth,
    minutesEarnedThisMonth,
    allocationsThisMonth,
    minutesConsumedThisMonth,
    totalBalanceMinutes,
    pendingArticles: pendingRaw.map((r) => r.article).filter(Boolean),
  };
}

async function sendMonthlyReport(user, adminEmails) {
  const data = await getMonthlyReportData(user.id);
  await emailService.sendMonthlyReportEmail(user, data, adminEmails);
  return { sent: true };
}

async function sendMonthlyReportsToAll() {
  const [students, admins] = await Promise.all([
    User.findAll({ where: { role: 'student' } }),
    User.findAll({ where: { role: 'admin' } }),
  ]);
  const adminEmails = admins.map((a) => a.email);
  const results = { sent: 0, errors: 0 };

  for (const student of students) {
    try {
      await sendMonthlyReport(student, adminEmails);
      results.sent++;
    } catch (err) {
      console.error(`[notificationService] monthly report failed for user ${student.id}:`, err.message);
      results.errors++;
    }
  }

  console.log(`[notificationService] monthly reports: sent=${results.sent} errors=${results.errors}`);
  return results;
}

// ─── Threshold alert check ────────────────────────────────────────────────────

async function checkThresholdRules() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const rules = await NotificationRule.findAll({ where: { is_active: true } });
  if (!rules.length) return { checked: 0, sent: 0 };

  const admins = await User.findAll({ where: { role: 'admin' } });
  if (!admins.length) {
    console.warn('[notificationService] no admin users found for threshold alerts');
    return { checked: rules.length, sent: 0 };
  }

  let sent = 0;
  let errors = 0;

  for (const rule of rules) {
    const whereUser = { role: 'student' };
    if (rule.target_user_id) whereUser.id = rule.target_user_id;
    const students = await User.findAll({ where: whereUser });

    for (const student of students) {
      try {
        const rows = await UserArticle.findAll({ where: { user_id: student.id }, attributes: ['status'] });
        const total = rows.length;
        if (total === 0) continue;

        const pending = rows.filter((r) => r.status === 'pending').length;

        const conditionMet =
          rule.type === 'articles_remaining'
            ? pending <= rule.threshold
            : (pending / total) * 100 <= rule.threshold;

        if (!conditionMet) continue;

        const alreadySent = await NotificationLog.findOne({
          where: { rule_id: rule.id, user_id: student.id, sent_date: today },
        });
        if (alreadySent) continue;

        for (const admin of admins) {
          await emailService.sendThresholdAlertEmail(admin, student, rule, { total, pending });
        }

        await NotificationLog.create({ rule_id: rule.id, user_id: student.id, sent_date: today });
        sent++;
      } catch (err) {
        console.error(`[notificationService] threshold rule ${rule.id} student ${student.id}:`, err.message);
        errors++;
      }
    }
  }

  console.log(`[notificationService] threshold alerts: sent=${sent} errors=${errors}`);
  return { checked: rules.length, sent, errors };
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

  // Daily threshold alerts — every day at 08:00 Europe/Madrid
  cron.schedule('0 8 * * *', () => {
    console.log('[notificationService] running threshold alerts');
    checkThresholdRules().catch((err) =>
      console.error('[notificationService] threshold cron error:', err)
    );
  }, { timezone: 'Europe/Madrid' });

  // Monthly report — first Monday of each month at 09:00 Europe/Madrid
  // Pattern "0 9 1-7 * 1": at 09:00, days 1-7 of any month, only on Mondays
  // -> exactly the first Monday of the month
  cron.schedule('0 9 1-7 * 1', () => {
    console.log('[notificationService] running monthly reports');
    sendMonthlyReportsToAll().catch((err) =>
      console.error('[notificationService] monthly report cron error:', err)
    );
  }, { timezone: 'Europe/Madrid' });

  console.log('[notificationService] scheduled tasks initialized');
}

module.exports = {
  sendWeeklyReminder,
  sendWeeklyRemindersToAll,
  sendInactivityReminders,
  checkThresholdRules,
  getMonthlyReportData,
  sendMonthlyReport,
  sendMonthlyReportsToAll,
  initializeScheduledTasks,
};
