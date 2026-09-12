// Journal Club presentations — read-only side of the PrionVault
// feature, exposed to PrionRead students so they can browse the slides
// the lab presented for an article before / during the assigned read.
//
// Tables `prionvault_jc_presentation` and `prionvault_jc_file` are
// owned by PrionVault and shared via the same Postgres instance.
// We read them through raw Sequelize queries (lower coupling than
// declaring full ORM models for tables we never mutate from here).
const { sequelize } = require('../models');
const { generateDownloadLink } = require('../services/dropbox');

async function _columnExists(table, column) {
  const rows = await sequelize.query(
    'SELECT 1 FROM information_schema.columns ' +
    'WHERE table_schema = :schema AND table_name = :table ' +
    '  AND column_name = :column LIMIT 1',
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: { schema: 'public', table, column },
    }
  );
  return rows.length > 0;
}

// Cached column-existence check. PrionRead may deploy against a
// Postgres where the PrionVault migrations have not yet landed (rare
// but the user has hit this class of issue in the past). Memo it.
let _tablesReady = null;
async function _ensureTables() {
  if (_tablesReady !== null) return _tablesReady;
  try {
    _tablesReady = await _columnExists('prionvault_jc_presentation', 'id');
  } catch {
    _tablesReady = false;
  }
  return _tablesReady;
}

async function getJcForArticle(req, res) {
  try {
    const ready = await _ensureTables();
    if (!ready) {
      // Table missing — return an empty list rather than 500 so the
      // frontend can render "no presentations" gracefully on a fresh
      // PrionRead-only deployment.
      return res.json({ items: [] });
    }
    const articleId = req.params.id;

    const pres = await sequelize.query(
      'SELECT id, article_id, presented_at, presenter_name, presenter_id, created_at ' +
      'FROM prionvault_jc_presentation ' +
      'WHERE article_id = :aid ' +
      'ORDER BY presented_at DESC, created_at DESC',
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { aid: articleId },
      }
    );
    if (!pres.length) return res.json({ items: [] });

    const presIds = pres.map((p) => p.id);
    const files = await sequelize.query(
      'SELECT id, presentation_id, filename, dropbox_path, size_bytes, kind, uploaded_at ' +
      'FROM prionvault_jc_file ' +
      'WHERE presentation_id IN (:pids) ' +
      'ORDER BY uploaded_at ASC',
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { pids: presIds },
      }
    );

    const filesByPres = {};
    for (const f of files) {
      if (!filesByPres[f.presentation_id]) filesByPres[f.presentation_id] = [];
      filesByPres[f.presentation_id].push({
        id:           f.id,
        filename:     f.filename,
        size_bytes:   f.size_bytes ? Number(f.size_bytes) : null,
        kind:         f.kind,
        uploaded_at:  f.uploaded_at,
      });
    }

    const items = pres.map((p) => ({
      id:             p.id,
      presented_at:   p.presented_at,
      presenter_name: p.presenter_name,
      created_at:     p.created_at,
      files:          filesByPres[p.id] || [],
    }));
    return res.json({ items });
  } catch (err) {
    console.error('[jc:getJcForArticle]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getJcFileUrl(req, res) {
  try {
    const ready = await _ensureTables();
    if (!ready) return res.status(404).json({ error: 'JC not available' });

    const fileId = req.params.fileId;
    const rows = await sequelize.query(
      'SELECT dropbox_path FROM prionvault_jc_file WHERE id = :fid',
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { fid: fileId },
      }
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });

    try {
      const link = await generateDownloadLink(rows[0].dropbox_path);
      return res.json({ url: link });
    } catch (dropboxErr) {
      console.error('[jc:getJcFileUrl] Dropbox link failed:',
                    dropboxErr.message || dropboxErr);
      return res.status(502).json({ error: 'Dropbox unavailable' });
    }
  } catch (err) {
    console.error('[jc:getJcFileUrl]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getJcForArticle, getJcFileUrl };
