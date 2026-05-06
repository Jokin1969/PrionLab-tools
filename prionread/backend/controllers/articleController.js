const { Op, literal } = require('sequelize');
const { fetchArticleByDOI } = require('../services/crossref');
const { fetchArticleByPubMedID, searchPubMedByDOI } = require('../services/pubmed');
const {
  uploadPDF,
  generateDownloadLink: dbxDownloadLink,
  checkFileExists,
  deletePDF,
  listFiles,
  dropboxPath,
} = require('../services/dropbox');
const { Article, ArticleRating, sequelize } = require('../models');
const { buildArticleQuery } = require('../utils/articleFilters');

const CURRENT_YEAR = new Date().getFullYear();

const HTTP_STATUS = {
  INVALID_INPUT: 400, INVALID_FILE_TYPE: 415, NOT_FOUND: 404,
  RATE_LIMITED: 429, UPSTREAM_ERROR: 503, PARSE_ERROR: 502,
};

function serviceError(res, err) {
  return res.status(HTTP_STATUS[err.code] || 500).json({ error: err.message });
}

function coerceFields(body) {
  const out = { ...body };
  if (out.year !== undefined) out.year = parseInt(out.year, 10);
  if (out.priority !== undefined) out.priority = parseInt(out.priority, 10);
  if (out.is_milestone !== undefined) {
    out.is_milestone = out.is_milestone === true || out.is_milestone === 'true';
  }
  if (typeof out.tags === 'string') {
    try { out.tags = JSON.parse(out.tags); }
    catch { out.tags = out.tags.split(',').map((t) => t.trim()).filter(Boolean); }
  }
  return out;
}

function validationErrors(fields) {
  const errors = [];
  const { title, authors, year, priority, tags } = fields;
  if (!title || !String(title).trim()) errors.push('title is required');
  if (!authors || !String(authors).trim()) errors.push('authors is required');
  const y = parseInt(year, 10);
  if (!year && year !== 0) {
    errors.push('year is required');
  } else if (Number.isNaN(y) || y < 1900 || y > CURRENT_YEAR) {
    errors.push(`year must be between 1900 and ${CURRENT_YEAR}`);
  }
  if (priority !== undefined) {
    const p = parseInt(priority, 10);
    if (Number.isNaN(p) || p < 1 || p > 5) errors.push('priority must be between 1 and 5');
  }
  if (tags !== undefined && !Array.isArray(tags)) errors.push('tags must be an array');
  return errors;
}

/**
 * Resolves metadata from CrossRef (DOI) and/or PubMed (PMID).
 * Falls back to PubMed via DOI lookup when CrossRef has no abstract.
 */
async function resolveExternalMetadata(doi, pubmed_id) {
  if (doi) {
    const meta = await fetchArticleByDOI(doi);
    if (!meta.abstract) {
      const pmid = pubmed_id || await searchPubMedByDOI(doi);
      if (pmid) {
        try {
          const pm = await fetchArticleByPubMedID(pmid);
          meta.abstract = pm.abstract;
          if (!meta.pubmed_id && pm.pubmed_id) meta.pubmed_id = pm.pubmed_id;
        } catch { /* best-effort */ }
      }
    } else if (pubmed_id && !meta.pubmed_id) {
      meta.pubmed_id = pubmed_id;
    }
    return meta;
  }
  return fetchArticleByPubMedID(pubmed_id);
}

const AVG_RATING_LITERAL = literal(
  '(SELECT ROUND(AVG(rating)::numeric, 2) FROM article_ratings WHERE article_id = "Article".id)'
);
const RATING_COUNT_LITERAL = literal(
  '(SELECT COUNT(*) FROM article_ratings WHERE article_id = "Article".id)'
);

async function _articleConflictPayload(article) {
  try {
    const [pvRow] = await sequelize.query(
      `SELECT
         (pdf_md5 IS NOT NULL) AS has_pdf_md5,
         (extraction_status IS NOT NULL AND extraction_status != 'pending') AS has_extraction
       FROM articles WHERE id = :id`,
      { replacements: { id: article.id }, type: sequelize.QueryTypes.SELECT }
    );
    const in_prionvault = !!(pvRow?.has_pdf_md5 || pvRow?.has_extraction);
    const [{ cnt }] = await sequelize.query(
      'SELECT COUNT(*)::int AS cnt FROM user_articles WHERE article_id = :id',
      { replacements: { id: article.id }, type: sequelize.QueryTypes.SELECT }
    );
    return {
      existing_article: { id: article.id, title: article.title, doi: article.doi, pubmed_id: article.pubmed_id },
      in_prionvault,
      in_prionread: cnt > 0,
      student_count: cnt,
    };
  } catch {
    return { existing_article: { id: article.id, title: article.title } };
  }
}

async function createArticle(req, res) {
  try {
    let fields = coerceFields(req.body);
    const needsMetadata = (!fields.title || !fields.authors || !fields.year) &&
      (fields.doi || fields.pubmed_id);
    if (needsMetadata) {
      let fetched;
      try { fetched = await resolveExternalMetadata(fields.doi, fields.pubmed_id); }
      catch (err) { return serviceError(res, err); }
      fields = coerceFields({ ...fetched, ...fields });
    }
    const errs = validationErrors(fields);
    if (errs.length) return res.status(400).json({ errors: errs });
    if (fields.doi) {
      const exists = await Article.findOne({ where: { doi: fields.doi.toLowerCase() } });
      if (exists) return res.status(409).json({ ...(await _articleConflictPayload(exists)), error: 'An article with this DOI already exists' });
    }
    if (fields.pubmed_id) {
      const exists = await Article.findOne({ where: { pubmed_id: String(fields.pubmed_id) } });
      if (exists) return res.status(409).json({ ...(await _articleConflictPayload(exists)), error: 'An article with this PubMed ID already exists' });
    }
    const article = await Article.create({
      title: String(fields.title).trim(),
      authors: String(fields.authors).trim(),
      year: fields.year,
      journal: fields.journal || null,
      doi: fields.doi ? String(fields.doi).toLowerCase() : null,
      pubmed_id: fields.pubmed_id ? String(fields.pubmed_id) : null,
      abstract: fields.abstract || null,
      tags: Array.isArray(fields.tags) ? fields.tags : [],
      is_milestone: fields.is_milestone || false,
      priority: fields.priority || 3,
    });
    if (req.file) {
      try {
        const dp = await uploadPDF(req.file.buffer, article);
        await article.update({ dropbox_path: dp });
      } catch (err) {
        console.error('[createArticle] PDF upload failed:', err.message);
      }
    } else if (article.doi || article.pubmed_id) {
      // No file uploaded — check if the expected PDF already exists in Dropbox
      try {
        const expectedPath = dropboxPath(article);
        const exists = await checkFileExists(expectedPath);
        if (exists) await article.update({ dropbox_path: expectedPath });
      } catch { /* best-effort */ }
    }
    return res.status(201).json({ article });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'DOI or PubMed ID already exists' });
    }
    console.error('[createArticle]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getArticles(req, res) {
  try {
    const { where, order, limit, offset, page } = buildArticleQuery(req.query);
    const { count, rows } = await Article.findAndCountAll({
      where, order, limit, offset,
      attributes: { include: [[AVG_RATING_LITERAL, 'avg_rating'], [RATING_COUNT_LITERAL, 'rating_count']] },
      distinct: true,
    });
    return res.json({ articles: rows, total: count, page, limit, total_pages: Math.ceil(count / limit) });
  } catch (err) {
    console.error('[getArticles]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getArticleById(req, res) {
  try {
    const article = await Article.findByPk(req.params.id, {
      attributes: { include: [[AVG_RATING_LITERAL, 'avg_rating'], [RATING_COUNT_LITERAL, 'rating_count']] },
    });
    if (!article) return res.status(404).json({ error: 'Article not found' });
    const ratings = await ArticleRating.findAll({
      where: { article_id: article.id },
      attributes: ['id', 'user_id', 'rating', 'comment', 'created_at'],
      order: [['created_at', 'DESC']],
    });
    return res.json({ article, ratings });
  } catch (err) {
    console.error('[getArticleById]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function updateArticle(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    const fields = coerceFields(req.body);
    const toCheck = {
      title: fields.title ?? article.title,
      authors: fields.authors ?? article.authors,
      year: fields.year ?? article.year,
      priority: fields.priority, tags: fields.tags,
    };
    const errs = validationErrors(toCheck);
    if (errs.length) return res.status(400).json({ errors: errs });
    if (fields.doi !== undefined) {
      const conflict = await Article.findOne({ where: { doi: fields.doi.toLowerCase(), id: { [Op.ne]: article.id } } });
      if (conflict) return res.status(409).json({ error: 'DOI already used by another article' });
    }
    if (fields.pubmed_id !== undefined) {
      const conflict = await Article.findOne({ where: { pubmed_id: String(fields.pubmed_id), id: { [Op.ne]: article.id } } });
      if (conflict) return res.status(409).json({ error: 'PubMed ID already used by another article' });
    }
    const updatable = ['title', 'authors', 'year', 'journal', 'doi', 'pubmed_id', 'abstract', 'tags', 'is_milestone', 'priority'];
    for (const key of updatable) {
      if (fields[key] !== undefined) article[key] = fields[key];
    }
    if (req.file) {
      if (article.dropbox_path) {
        try { await deletePDF(article.dropbox_path); } catch { /* gone */ }
      }
      try {
        article.dropbox_path = await uploadPDF(req.file.buffer, article);
        article.dropbox_link = null;
      } catch (err) { return serviceError(res, err); }
    }
    await article.save();
    return res.json({ article });
  } catch (err) {
    console.error('[updateArticle]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function deleteArticle(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (article.dropbox_path) {
      try { await deletePDF(article.dropbox_path); }
      catch (e) { console.error('[deleteArticle] Dropbox delete failed:', e.message); }
    }
    await article.destroy();
    return res.json({ success: true });
  } catch (err) {
    console.error('[deleteArticle]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function generateDownloadLinkHandler(req, res) {
  try {
    const article = await Article.findByPk(req.params.id, { attributes: ['id', 'dropbox_path'] });
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.dropbox_path) return res.status(404).json({ error: 'No PDF uploaded for this article' });
    let url;
    try { url = await dbxDownloadLink(article.dropbox_path); }
    catch (err) { return serviceError(res, err); }
    await article.update({ dropbox_link: url });
    return res.json({ url, expires_in: 14400 });
  } catch (err) {
    console.error('[generateDownloadLink]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function fetchMetadata(req, res) {
  try {
    const { doi, pubmed_id } = req.body;
    if (!doi && !pubmed_id) return res.status(400).json({ error: 'Provide at least one of: doi, pubmed_id' });
    let metadata;
    try { metadata = await resolveExternalMetadata(doi, pubmed_id); }
    catch (err) { return serviceError(res, err); }
    return res.json({ metadata });
  } catch (err) {
    console.error('[fetchMetadata]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function uploadArticlePDF(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
    let dp;
    try { dp = await uploadPDF(req.file.buffer, article); }
    catch (err) { return serviceError(res, err); }
    await article.update({ dropbox_path: dp, dropbox_link: null });
    return res.json({ dropbox_path: dp });
  } catch (err) {
    console.error('[uploadArticlePDF]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getDownloadLink(req, res) {
  try {
    const article = await Article.findByPk(req.params.id, { attributes: ['id', 'title', 'dropbox_path'] });
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.dropbox_path) return res.status(404).json({ error: 'No PDF uploaded for this article' });
    let link;
    try { link = await dbxDownloadLink(article.dropbox_path); }
    catch (err) { return serviceError(res, err); }
    await article.update({ dropbox_link: link });
    return res.json({ link, expires_in: '4h' });
  } catch (err) {
    console.error('[getDownloadLink]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function deleteArticlePDF(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.dropbox_path) return res.status(404).json({ error: 'No PDF uploaded for this article' });
    try { await deletePDF(article.dropbox_path); }
    catch (err) { return serviceError(res, err); }
    await article.update({ dropbox_path: null, dropbox_link: null });
    return res.json({ success: true });
  } catch (err) {
    console.error('[deleteArticlePDF]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function listDropboxFiles(req, res) {
  try {
    const folder = req.query.folder || undefined;
    let files;
    try { files = await listFiles(folder); }
    catch (err) { return serviceError(res, err); }
    return res.json({ files });
  } catch (err) {
    console.error('[listDropboxFiles]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/articles/verify-pdfs
 * Full scan of ALL articles:
 * - With dropbox_path: verify file still exists (ok | missing)
 * - Without dropbox_path + has doi/pmid: check expected path, auto-link if found (linked | no_pdf)
 */
async function verifyArticlePDFs(req, res) {
  try {
    const articles = await Article.findAll({
      attributes: ['id', 'title', 'doi', 'pubmed_id', 'dropbox_path'],
      order: [['title', 'ASC']],
    });
    const results = await Promise.all(
      articles.map(async (a) => {
        const base = { id: a.id, title: a.title, doi: a.doi, pubmed_id: a.pubmed_id };
        if (a.dropbox_path) {
          const exists = await checkFileExists(a.dropbox_path).catch(() => false);
          return { ...base, status: exists ? 'ok' : 'missing', dropbox_path: a.dropbox_path };
        }
        if (a.doi || a.pubmed_id) {
          const expectedPath = dropboxPath(a);
          const exists = await checkFileExists(expectedPath).catch(() => false);
          if (exists) {
            await a.update({ dropbox_path: expectedPath });
            return { ...base, status: 'linked', dropbox_path: expectedPath };
          }
          return { ...base, status: 'no_pdf', dropbox_path: null };
        }
        return { ...base, status: 'no_identifier', dropbox_path: null };
      })
    );
    const count = (s) => results.filter((r) => r.status === s).length;
    return res.json({
      results,
      summary: { ok: count('ok'), missing: count('missing'), linked: count('linked'), no_pdf: count('no_pdf'), total: results.length },
    });
  } catch (err) {
    console.error('[verifyArticlePDFs]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function clearPdfLink(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    await article.update({ dropbox_path: null, dropbox_link: null });
    return res.json({ success: true });
  } catch (err) {
    console.error('[clearPdfLink]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function syncDropboxPDFs(req, res) {
  try {
    let files;
    try { files = await listFiles(); }
    catch (err) { return serviceError(res, err); }
    const results = { matched: 0, already_had_pdf: 0, unmatched: [] };
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf')) continue;
      const baseName = file.name.replace(/\.pdf$/i, '');
      let article = null;
      if (baseName.startsWith('PMID_')) {
        article = await Article.findOne({ where: { pubmed_id: baseName.slice(5) } });
      } else {
        article = await Article.findOne({ where: { doi: baseName.replace(/_/g, '/').toLowerCase() } });
      }
      if (!article) { results.unmatched.push(file.name); continue; }
      if (article.dropbox_path) { results.already_had_pdf++; continue; }
      await article.update({ dropbox_path: file.path, dropbox_link: null });
      results.matched++;
    }
    return res.json(results);
  } catch (err) {
    console.error('[syncDropboxPDFs]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  createArticle, getArticles, getArticleById, updateArticle, deleteArticle,
  generateDownloadLinkHandler, fetchMetadata, uploadArticlePDF, getDownloadLink,
  deleteArticlePDF, listDropboxFiles, verifyArticlePDFs, clearPdfLink, syncDropboxPDFs,
};
