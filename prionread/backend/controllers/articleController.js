const { Op, fn, col, literal } = require('sequelize');
const { fetchArticleByDOI } = require('../services/crossref');
const { fetchArticleByPubMedID } = require('../services/pubmed');
const {
  uploadPDF,
  generateDownloadLink: dbxDownloadLink,
  deletePDF,
  listFiles,
} = require('../services/dropbox');
const { Article, ArticleRating, sequelize } = require('../models');
const { buildArticleQuery } = require('../utils/articleFilters');

const CURRENT_YEAR = new Date().getFullYear();

// ─── Error mapping ─────────────────────────────────────────────────────────────

const HTTP_STATUS = {
  INVALID_INPUT: 400,
  INVALID_FILE_TYPE: 415,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 503,
  PARSE_ERROR: 502,
};

function serviceError(res, err) {
  const status = HTTP_STATUS[err.code] || 500;
  return res.status(status).json({ error: err.message });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Multipart form fields arrive as strings. Coerce to correct JS types.
 * JSON body fields are already typed — coercion is a no-op for them.
 */
function coerceFields(body) {
  const out = { ...body };

  if (out.year !== undefined) out.year = parseInt(out.year, 10);
  if (out.priority !== undefined) out.priority = parseInt(out.priority, 10);

  if (out.is_milestone !== undefined) {
    out.is_milestone = out.is_milestone === true || out.is_milestone === 'true';
  }

  if (typeof out.tags === 'string') {
    try {
      out.tags = JSON.parse(out.tags);
    } catch {
      out.tags = out.tags.split(',').map((t) => t.trim()).filter(Boolean);
    }
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

  if (tags !== undefined && !Array.isArray(tags)) {
    errors.push('tags must be an array');
  }

  return errors;
}

/**
 * Fetches metadata from CrossRef or PubMed and returns a normalised object.
 * Throws with a .code property on failure.
 */
async function resolveExternalMetadata(doi, pubmed_id) {
  if (doi) {
    const meta = await fetchArticleByDOI(doi);
    if (pubmed_id && !meta.pubmed_id) {
      try {
        const pm = await fetchArticleByPubMedID(pubmed_id);
        meta.abstract = meta.abstract || pm.abstract;
        meta.pubmed_id = pm.pubmed_id;
      } catch { /* best-effort */ }
    }
    return meta;
  }
  return fetchArticleByPubMedID(pubmed_id);
}

// Inline avg_rating subquery — works correctly with pagination + no GROUP BY hassle
const AVG_RATING_LITERAL = literal(
  '(SELECT ROUND(AVG(rating)::numeric, 2) FROM article_ratings WHERE article_id = "Article".id)'
);
const RATING_COUNT_LITERAL = literal(
  '(SELECT COUNT(*) FROM article_ratings WHERE article_id = "Article".id)'
);

// ─── CRUD ───────────────────────────────────────────────────────────────────────

// POST /api/articles
async function createArticle(req, res) {
  try {
    let fields = coerceFields(req.body);

    // Auto-fetch metadata when manual fields are absent but an identifier is given
    const needsMetadata = (!fields.title || !fields.authors || !fields.year) &&
      (fields.doi || fields.pubmed_id);

    if (needsMetadata) {
      let fetched;
      try {
        fetched = await resolveExternalMetadata(fields.doi, fields.pubmed_id);
      } catch (err) {
        return serviceError(res, err);
      }
      // Provided fields take precedence over fetched ones
      fields = { ...fetched, ...fields };
      fields = coerceFields(fields);
    }

    const errs = validationErrors(fields);
    if (errs.length) return res.status(400).json({ errors: errs });

    // Uniqueness checks
    if (fields.doi) {
      const exists = await Article.findOne({ where: { doi: fields.doi.toLowerCase() } });
      if (exists) return res.status(409).json({ error: 'An article with this DOI already exists' });
    }
    if (fields.pubmed_id) {
      const exists = await Article.findOne({ where: { pubmed_id: String(fields.pubmed_id) } });
      if (exists) return res.status(409).json({ error: 'An article with this PubMed ID already exists' });
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

    // Optional PDF upload — pass full article so filename uses DOI/PMID
    if (req.file) {
      try {
        const dropbox_path = await uploadPDF(req.file.buffer, article);
        await article.update({ dropbox_path });
      } catch (err) {
        // Article is created — PDF failure is non-fatal; warn but continue
        console.error('[createArticle] PDF upload failed after article creation:', err.message);
      }
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

// GET /api/articles
async function getArticles(req, res) {
  try {
    const { where, order, limit, offset, page } = buildArticleQuery(req.query);

    const { count, rows } = await Article.findAndCountAll({
      where,
      order,
      limit,
      offset,
      attributes: {
        include: [
          [AVG_RATING_LITERAL, 'avg_rating'],
          [RATING_COUNT_LITERAL, 'rating_count'],
        ],
      },
      distinct: true,
    });

    return res.json({
      articles: rows,
      total: count,
      page,
      limit,
      total_pages: Math.ceil(count / limit),
    });
  } catch (err) {
    console.error('[getArticles]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/articles/:id
async function getArticleById(req, res) {
  try {
    const article = await Article.findByPk(req.params.id, {
      attributes: {
        include: [
          [AVG_RATING_LITERAL, 'avg_rating'],
          [RATING_COUNT_LITERAL, 'rating_count'],
        ],
      },
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

// PUT /api/articles/:id
async function updateArticle(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const fields = coerceFields(req.body);

    // Validate only the fields that are present
    const toCheck = {
      title: fields.title ?? article.title,
      authors: fields.authors ?? article.authors,
      year: fields.year ?? article.year,
      priority: fields.priority,
      tags: fields.tags,
    };
    const errs = validationErrors(toCheck);
    if (errs.length) return res.status(400).json({ errors: errs });

    // DOI / PubMed uniqueness (skip self)
    if (fields.doi !== undefined) {
      const conflict = await Article.findOne({
        where: { doi: fields.doi.toLowerCase(), id: { [Op.ne]: article.id } },
      });
      if (conflict) return res.status(409).json({ error: 'DOI already used by another article' });
    }
    if (fields.pubmed_id !== undefined) {
      const conflict = await Article.findOne({
        where: { pubmed_id: String(fields.pubmed_id), id: { [Op.ne]: article.id } },
      });
      if (conflict) return res.status(409).json({ error: 'PubMed ID already used by another article' });
    }

    // Apply only supplied fields
    const updatable = ['title', 'authors', 'year', 'journal', 'doi', 'pubmed_id',
                       'abstract', 'tags', 'is_milestone', 'priority'];
    for (const key of updatable) {
      if (fields[key] !== undefined) article[key] = fields[key];
    }

    // Replace PDF if a new file was uploaded — pass full article for DOI/PMID filename
    if (req.file) {
      if (article.dropbox_path) {
        try { await deletePDF(article.dropbox_path); } catch { /* old file gone — fine */ }
      }
      try {
        article.dropbox_path = await uploadPDF(req.file.buffer, article);
        article.dropbox_link = null;
      } catch (err) {
        return serviceError(res, err);
      }
    }

    await article.save();
    return res.json({ article });
  } catch (err) {
    console.error('[updateArticle]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/articles/:id
async function deleteArticle(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // Best-effort PDF deletion — don't block the DB delete if Dropbox fails
    if (article.dropbox_path) {
      try { await deletePDF(article.dropbox_path); } catch (e) {
        console.error('[deleteArticle] Dropbox delete failed:', e.message);
      }
    }

    await article.destroy();
    return res.json({ success: true });
  } catch (err) {
    console.error('[deleteArticle]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/articles/:id/download-link
async function generateDownloadLinkHandler(req, res) {
  try {
    const article = await Article.findByPk(req.params.id, {
      attributes: ['id', 'dropbox_path'],
    });
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.dropbox_path) {
      return res.status(404).json({ error: 'No PDF uploaded for this article' });
    }

    let url;
    try {
      url = await dbxDownloadLink(article.dropbox_path);
    } catch (err) {
      return serviceError(res, err);
    }

    await article.update({ dropbox_link: url });

    // Dropbox temporary links expire in ~4 hours (14400 seconds)
    return res.json({ url, expires_in: 14400 });
  } catch (err) {
    console.error('[generateDownloadLink]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Metadata + Dropbox helpers ───────────────────────────────────────────────────────────

// POST /api/articles/fetch-metadata
async function fetchMetadata(req, res) {
  try {
    const { doi, pubmed_id } = req.body;
    if (!doi && !pubmed_id) {
      return res.status(400).json({ error: 'Provide at least one of: doi, pubmed_id' });
    }
    let metadata;
    try {
      metadata = await resolveExternalMetadata(doi, pubmed_id);
    } catch (err) {
      return serviceError(res, err);
    }
    return res.json({ metadata });
  } catch (err) {
    console.error('[fetchMetadata]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/articles/:id/pdf
async function uploadArticlePDF(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
    let dropbox_path;
    try {
      // Pass full article so filename uses DOI/PMID
      dropbox_path = await uploadPDF(req.file.buffer, article);
    } catch (err) {
      return serviceError(res, err);
    }
    await article.update({ dropbox_path, dropbox_link: null });
    return res.json({ dropbox_path });
  } catch (err) {
    console.error('[uploadArticlePDF]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/articles/:id/pdf/link
async function getDownloadLink(req, res) {
  try {
    const article = await Article.findByPk(req.params.id, {
      attributes: ['id', 'title', 'dropbox_path'],
    });
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.dropbox_path) {
      return res.status(404).json({ error: 'No PDF uploaded for this article' });
    }
    let link;
    try {
      link = await dbxDownloadLink(article.dropbox_path);
    } catch (err) {
      return serviceError(res, err);
    }
    await article.update({ dropbox_link: link });
    return res.json({ link, expires_in: '4h' });
  } catch (err) {
    console.error('[getDownloadLink]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/articles/:id/pdf
async function deleteArticlePDF(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (!article.dropbox_path) {
      return res.status(404).json({ error: 'No PDF uploaded for this article' });
    }
    try {
      await deletePDF(article.dropbox_path);
    } catch (err) {
      return serviceError(res, err);
    }
    await article.update({ dropbox_path: null, dropbox_link: null });
    return res.json({ success: true });
  } catch (err) {
    console.error('[deleteArticlePDF]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/articles/dropbox/files
async function listDropboxFiles(req, res) {
  try {
    const folder = req.query.folder || undefined;
    let files;
    try {
      files = await listFiles(folder);
    } catch (err) {
      return serviceError(res, err);
    }
    return res.json({ files });
  } catch (err) {
    console.error('[listDropboxFiles]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/articles/sync-dropbox
 *
 * Scans the Dropbox folder and links any PDF whose filename matches an
 * article's DOI or PMID to that article in the database.
 *
 * Naming conventions expected in Dropbox:
 *   DOI  → 10.1016_j.cell.2020.01.001.pdf  (slashes replaced by underscores)
 *   PMID → PMID_22654800.pdf
 *
 * Only updates articles that currently have no dropbox_path.
 * Returns { matched, already_had_pdf, unmatched: [filenames] }
 */
async function syncDropboxPDFs(req, res) {
  try {
    let files;
    try {
      files = await listFiles();
    } catch (err) {
      return serviceError(res, err);
    }

    const results = { matched: 0, already_had_pdf: 0, unmatched: [] };

    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf')) continue;

      const baseName = file.name.replace(/\.pdf$/i, '');
      let article = null;

      if (baseName.startsWith('PMID_')) {
        const pmid = baseName.slice(5);
        article = await Article.findOne({ where: { pubmed_id: pmid } });
      } else {
        // Attempt DOI match: convert underscores back to slashes
        const doi = baseName.replace(/_/g, '/');
        article = await Article.findOne({ where: { doi: doi.toLowerCase() } });
      }

      if (!article) {
        results.unmatched.push(file.name);
        continue;
      }

      if (article.dropbox_path) {
        results.already_had_pdf++;
        continue;
      }

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
  createArticle,
  getArticles,
  getArticleById,
  updateArticle,
  deleteArticle,
  generateDownloadLinkHandler,
  fetchMetadata,
  uploadArticlePDF,
  getDownloadLink,
  deleteArticlePDF,
  listDropboxFiles,
  syncDropboxPDFs,
};
