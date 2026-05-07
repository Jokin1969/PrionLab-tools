const { Router } = require('express');
const { Op } = require('sequelize');
const crypto = require('crypto');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getGlobalDashboard } = require('../controllers/adminDashboardController');
const { getUserDetailedStats, exportUsersCSV, resetUserPassword, sendReminderToUser } = require('../controllers/adminUserController');
const { getArticlesAnalytics, getAssignmentsMatrix, getArticleEngagement, assignArticleToAll, findDuplicateArticles, getSyncStatus } = require('../controllers/adminArticleController');
const { verifyArticlePDFs, syncDropboxPDFs } = require('../controllers/articleController');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const { User, NotificationRule, NotificationLog } = require('../models');

const router = Router();
router.use(authenticate, requireAdmin);

// Dashboard
router.get('/dashboard', getGlobalDashboard);

// User management
router.get('/users/export',                    exportUsersCSV);
router.get('/users/:userId/detailed-stats',    getUserDetailedStats);
router.post('/users/:userId/reset-password',   resetUserPassword);
router.post('/users/:userId/send-reminder',    sendReminderToUser);

// Welcome email preview (no send, no password change)
router.get('/users/:userId/welcome-preview', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const html = emailService.buildOnboardingHtml(user, 'ejemplo-contraseña');
    res.json({ html });
  } catch (err) {
    console.error('[GET /admin/users/:userId/welcome-preview]', err);
    res.status(500).json({ error: 'Error generando vista previa' });
  }
});

// Send welcome / onboarding email (generates new temp password)
router.post('/users/:userId/send-welcome', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tempPassword = crypto.randomBytes(5).toString('hex');
    user.password = tempPassword;
    user.admin_set_password = tempPassword;
    user.welcome_email_sent_at = new Date();
    await user.save();

    // DB is updated regardless of email outcome — always return 200 so the
    // UI can reflect the new welcome_email_sent_at state.
    let emailSent = false;
    let emailError = null;
    try {
      await emailService.sendOnboardingEmail(user, tempPassword);
      emailSent = true;
    } catch (emailErr) {
      emailError = emailErr.message;
      console.error('[POST /admin/users/:userId/send-welcome] email failed:', emailErr);
    }

    res.json({
      ok: true,
      welcome_email_sent_at: user.welcome_email_sent_at,
      tempPassword,
      email_sent: emailSent,
      ...(emailError ? { email_error: emailError } : {}),
    });
  } catch (err) {
    console.error('[POST /admin/users/:userId/send-welcome]', err);
    res.status(500).json({ error: 'Error guardando usuario' });
  }
});

// Article analytics — static routes BEFORE /:articleId
router.get('/articles/analytics',           getArticlesAnalytics);
router.get('/articles/assignments-matrix',  getAssignmentsMatrix);

// PDF health check
router.post('/articles/verify-pdfs',  verifyArticlePDFs);
router.post('/articles/sync-dropbox', syncDropboxPDFs);

// Duplicate detection
router.get('/articles/find-duplicates', findDuplicateArticles);

// PrionVault ↔ PrionRead sync status
router.get('/sync/status', getSyncStatus);

// Mark "only in PrionRead" articles as pending in PrionVault pipeline,
// auto-linking Dropbox PDFs that already exist at the expected path.
router.post('/sync/mark-pending', async (_req, res) => {
  const { sequelize: sq } = require('../models');
  const { dropboxPath, listFiles } = require('../services/dropbox');

  // Verify PrionVault columns exist
  try {
    await sq.query("SELECT extraction_status, source FROM articles LIMIT 0");
  } catch {
    return res.status(409).json({ error: 'PrionVault columns not yet migrated. Run the migration first.' });
  }

  try {
    // Find qualifying articles: assigned to students, no PDF processed yet
    const rows = await sq.query(
      `SELECT id, doi, pubmed_id, dropbox_path, source FROM articles
       WHERE id IN (SELECT DISTINCT article_id FROM user_articles)
         AND (pdf_md5 IS NULL)
         AND (extraction_status IS NULL OR extraction_status = 'pending')`,
      { type: sq.QueryTypes.SELECT }
    );

    if (!rows.length) return res.json({ ok: true, updated: 0, pdfs_linked: 0, needs_pdf: 0 });

    // Scan Dropbox once — build a lowercase-path → real-path map
    let fileMap = new Map();
    try {
      const files = await listFiles();
      for (const f of files) fileMap.set(f.path.toLowerCase(), f.path);
    } catch {
      // Dropbox unavailable — continue without PDF auto-linking
    }

    let pdfsLinked = 0;
    let needsPdf = 0;

    for (const row of rows) {
      let newDropboxPath = null;

      if (!row.dropbox_path) {
        const expected = dropboxPath(row);
        if (fileMap.has(expected.toLowerCase())) {
          newDropboxPath = expected;
          pdfsLinked++;
        } else {
          needsPdf++;
        }
      }

      await sq.query(
        `UPDATE articles
         SET extraction_status = 'pending',
             source = COALESCE(NULLIF(source, ''), 'prionread')
             ${newDropboxPath ? ", dropbox_path = :dp, dropbox_link = NULL" : ""}
         WHERE id = :id`,
        {
          replacements: { id: row.id, ...(newDropboxPath ? { dp: newDropboxPath } : {}) },
          type: sq.QueryTypes.UPDATE,
        }
      );
    }

    res.json({ ok: true, updated: rows.length, pdfs_linked: pdfsLinked, needs_pdf: needsPdf });
  } catch (err) {
    console.error('[POST /admin/sync/mark-pending]', err);
    res.status(500).json({ error: 'Error marking articles as pending' });
  }
});

// Apply PrionVault columns to the shared articles table (idempotent)
router.post('/sync/run-migration', async (_req, res) => {
  const { sequelize: sq } = require('../models');
  const statements = [
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS pdf_md5           CHAR(32)",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS pdf_size_bytes    BIGINT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS pdf_pages         INTEGER",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS extraction_status VARCHAR(20) DEFAULT 'pending'",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS extraction_error  TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_ai        TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS summary_human     TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS indexed_at        TIMESTAMPTZ",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS source            VARCHAR(40) DEFAULT 'manual'",
  ];
  const results = { ok: [], failed: [] };
  for (const stmt of statements) {
    try {
      await sq.query(stmt);
      results.ok.push(stmt.split('ADD COLUMN IF NOT EXISTS')[1]?.trim().split(' ')[0]);
    } catch (err) {
      results.failed.push({ column: stmt.split('ADD COLUMN IF NOT EXISTS')[1]?.trim().split(' ')[0], error: err.message });
    }
  }
  res.json({ applied: results.ok.length, errors: results.failed.length, results });
});

router.get('/articles/:articleId/engagement',       getArticleEngagement);
router.post('/articles/:articleId/assign-to-all',   assignArticleToAll);

// ─── PDF page backfill ────────────────────────────────────────────────────────
// Downloads each PDF from Dropbox and counts pages via pdf-parse.
// Processes articles that have dropbox_path but no pdf_pages yet.
router.post('/sync/backfill-pdf-pages', async (req, res) => {
  const { sequelize: sq } = require('../models');
  const dbx = require('../config/dropbox');
  const pdfParse = require('pdf-parse');

  const limit = Math.min(500, Math.max(1, parseInt(req.body?.limit ?? 50, 10) || 50));

  try {
    const rows = await sq.query(
      `SELECT id::text, dropbox_path FROM articles
       WHERE dropbox_path IS NOT NULL AND pdf_pages IS NULL
       ORDER BY created_at DESC LIMIT :limit`,
      { replacements: { limit }, type: sq.QueryTypes.SELECT }
    );

    if (!rows.length) return res.json({ processed: 0, updated: 0, failed: 0, errors: [] });

    let updated = 0;
    const errors = [];

    for (const { id, dropbox_path } of rows) {
      try {
        const dl = await dbx.filesDownload({ path: dropbox_path });
        const buf = Buffer.from(dl.result.fileBinary);
        const { numpages } = await pdfParse(buf, { max: 0 });
        await sq.query(
          'UPDATE articles SET pdf_pages = :p WHERE id = :id',
          { replacements: { p: numpages, id }, type: sq.QueryTypes.UPDATE }
        );
        updated++;
      } catch (err) {
        errors.push({ id, error: err.message?.slice(0, 200) ?? 'unknown' });
      }
    }

    res.json({ processed: rows.length, updated, failed: errors.length, errors: errors.slice(0, 20) });
  } catch (err) {
    console.error('[POST /admin/sync/backfill-pdf-pages]', err);
    res.status(500).json({ error: 'Error during PDF page backfill' });
  }
});

// ─── Word export: article selection checklist ─────────────────────────────────
router.post('/articles/export-word', async (req, res) => {
  const {
    Document, Paragraph, TextRun, Table, TableRow, TableCell,
    CheckBox, WidthType, BorderStyle, AlignmentType, VerticalAlign,
    HeightRule, Packer, convertInchesToTwip,
  } = require('docx');

  const articles = Array.isArray(req.body?.articles) ? req.body.articles : [];
  if (!articles.length) return res.status(400).json({ error: 'No articles provided' });

  // ── Colour palette (blue-friendly) ──────────────────────────────────────
  const C_TITLE   = '0F3460';   // deep navy
  const C_META    = '2563EB';   // medium blue
  const C_JOURNAL = '64748B';   // slate
  const C_ABST    = '374151';   // dark grey
  const C_BORDER  = 'E2E8F0';   // very light grey for separators

  // ── Helper: truncate abstract to ~4 lines ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  const truncate = (text, words = 60) => {
    if (!text) return null;
    const parts = text.trim().split(/\s+/);
    return parts.length <= words ? text.trim() : parts.slice(0, words).join(' ') + '…';
  };

  // ── Build one table row per article ─────────────────────────────────────
  const noBorder = {
    top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideVertical:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };
  const separatorBorder = {
    ...noBorder,
    bottom: { style: BorderStyle.SINGLE, size: 1, color: C_BORDER },
  };

  const rows = articles.map((a, idx) => {
    const isLast = idx === articles.length - 1;
    const authors = Array.isArray(a.authors) ? a.authors.join(', ') : (a.authors || '');
    const journal = [a.journal, a.year].filter(Boolean).join(' · ');
    const abst    = truncate(a.abstract);

    const contentParas = [
      // Title
      new Paragraph({
        children: [new TextRun({
          text: a.title || '(Sin título)',
          bold: true, size: 24, color: C_TITLE,
        })],
        spacing: { after: 40 },
      }),
    ];

    if (authors) contentParas.push(new Paragraph({
      children: [new TextRun({ text: authors, size: 19, color: C_META })],
      spacing: { after: 30 },
    }));

    if (journal) contentParas.push(new Paragraph({
      children: [new TextRun({ text: journal, size: 18, italics: true, color: C_JOURNAL })],
      spacing: { after: abst ? 50 : 0 },
    }));

    if (abst) contentParas.push(new Paragraph({
      children: [new TextRun({ text: abst, size: 17, color: C_ABST })],
      spacing: { after: 0 },
    }));

    return new TableRow({
      children: [
        // Checkbox cell
        new TableCell({
          children: [new Paragraph({
            children: [new CheckBox({ checked: false })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 40 },
          })],
          width:  { size: 420, type: WidthType.DXA },
          verticalAlign: VerticalAlign.TOP,
          borders: isLast ? noBorder : separatorBorder,
          margins: { top: convertInchesToTwip(0.05), bottom: convertInchesToTwip(0.1),
                     left: convertInchesToTwip(0.05), right: convertInchesToTwip(0.05) },
        }),
        // Content cell
        new TableCell({
          children: contentParas,
          width: { size: 9060, type: WidthType.DXA },
          borders: isLast ? noBorder : separatorBorder,
          margins: { top: convertInchesToTwip(0.08), bottom: convertInchesToTwip(0.12),
                     left: convertInchesToTwip(0.1),  right: convertInchesToTwip(0.1) },
        }),
      ],
    });
  });

  const doc = new Document({
    numbering: { config: [] },
    sections: [{
      properties: {
        page: {
          margin: {
            top:    convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left:   convertInchesToTwip(1.1),
            right:  convertInchesToTwip(1.1),
          },
        },
      },
      children: [
        // Document title
        new Paragraph({
          children: [new TextRun({
            text: 'Selección de artículos',
            bold: true, size: 36, color: C_TITLE,
          })],
          spacing: { after: 80 },
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 4, color: C_META, space: 6 },
          },
        }),
        // Subtitle / instructions
        new Paragraph({
          children: [new TextRun({
            text: `${articles.length} artículo${articles.length !== 1 ? 's' : ''} — marca los que seleccionas y devuelve el documento`,
            size: 18, color: C_JOURNAL, italics: true,
          })],
          spacing: { after: 240 },
        }),
        // Article table
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: noBorder,
          rows,
        }),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  const ts  = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="seleccion_articulos_${ts}.docx"`);
  res.end(buf);
});

// ─── Notification Rules CRUD ──────────────────────────────────────────────────

router.get('/notification-rules', async (_req, res) => {
  try {
    const rules = await NotificationRule.findAll({
      include: [
        { model: User, as: 'targetUser', attributes: ['id', 'name', 'email'], required: false },
      ],
      order: [['created_at', 'DESC']],
    });

    // Enrich each rule with last_sent and trigger_count (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const enriched = await Promise.all(rules.map(async (rule) => {
      const [lastLog, triggerCount] = await Promise.all([
        NotificationLog.findOne({
          where: { rule_id: rule.id },
          order: [['sent_date', 'DESC']],
          attributes: ['sent_date', 'user_id'],
          include: [{ model: User, as: 'user', attributes: ['name'] }],
        }),
        NotificationLog.count({ where: { rule_id: rule.id, sent_date: { [Op.gte]: thirtyDaysAgo } } }),
      ]);
      return {
        ...rule.toJSON(),
        last_sent: lastLog?.sent_date ?? null,
        last_sent_student: lastLog?.user?.name ?? null,
        trigger_count_30d: triggerCount,
      };
    }));

    res.json({ rules: enriched });
  } catch (err) {
    console.error('[GET /admin/notification-rules]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/notification-rules', async (req, res) => {
  try {
    const { type, threshold, target_user_id, label } = req.body;
    if (!['articles_remaining', 'articles_percentage'].includes(type)) {
      return res.status(400).json({ error: 'type must be articles_remaining or articles_percentage' });
    }
    const n = parseInt(threshold, 10);
    if (isNaN(n) || n < 1) return res.status(400).json({ error: 'threshold must be a positive integer' });
    if (type === 'articles_percentage' && n > 100) {
      return res.status(400).json({ error: 'percentage threshold cannot exceed 100' });
    }
    const rule = await NotificationRule.create({
      type,
      threshold: n,
      target_user_id: target_user_id || null,
      label: label?.trim() || null,
    });
    res.status(201).json({ rule });
  } catch (err) {
    console.error('[POST /admin/notification-rules]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/notification-rules/:id', async (req, res) => {
  try {
    const rule = await NotificationRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    const allowed = ['is_active', 'threshold', 'label'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) rule[key] = req.body[key];
    }
    await rule.save();
    res.json({ rule });
  } catch (err) {
    console.error('[PATCH /admin/notification-rules/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/notification-rules/:id', async (req, res) => {
  try {
    const rule = await NotificationRule.findByPk(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    await NotificationLog.destroy({ where: { rule_id: rule.id } });
    await rule.destroy();
    res.json({ deleted: true });
  } catch (err) {
    console.error('[DELETE /admin/notification-rules/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/notification-rules/run', async (_req, res) => {
  try {
    const result = await notificationService.checkThresholdRules();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[POST /admin/notification-rules/run]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Legacy scheduled notifications ─────────────────────────────────────────

// Notifications
router.post('/notifications/weekly-reminders', async (_req, res) => {
  try { const r = await notificationService.sendWeeklyRemindersToAll(); res.json({ ok: true, ...r }); }
  catch (err) { console.error('[POST /notifications/weekly-reminders]', err); res.status(500).json({ error: 'Failed to send weekly reminders' }); }
});
router.post('/notifications/inactivity-reminders', async (_req, res) => {
  try { const r = await notificationService.sendInactivityReminders(); res.json({ ok: true, ...r }); }
  catch (err) { console.error('[POST /notifications/inactivity-reminders]', err); res.status(500).json({ error: 'Failed to send inactivity reminders' }); }
});

// Reports
router.use('/reports', require('./reports'));

// PrionBonus
const { getAdminBonusOverview, getStudentBonusDetail, addAllocation, deleteAllocation } = require('../controllers/bonusController');
router.get('/bonus',                    getAdminBonusOverview);
router.get('/bonus/:userId',            getStudentBonusDetail);
router.post('/bonus/allocations',       addAllocation);
router.delete('/bonus/allocations/:id', deleteAllocation);

module.exports = router;
