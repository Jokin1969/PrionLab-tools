const { fetchArticleByDOI } = require('../services/crossref');
const { fetchArticleByPubMedID } = require('../services/pubmed');
const {
  uploadPDF,
  generateDownloadLink,
  deletePDF,
  listFiles,
} = require('../services/dropbox');
const { Article } = require('../models');

// Maps service error codes to HTTP status codes
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

// ─── Metadata ─────────────────────────────────────────────────────────────────

// POST /api/articles/fetch-metadata
async function fetchMetadata(req, res) {
  try {
    const { doi, pubmed_id } = req.body;

    if (!doi && !pubmed_id) {
      return res.status(400).json({ error: 'Provide at least one of: doi, pubmed_id' });
    }

    let metadata;

    if (doi) {
      try {
        metadata = await fetchArticleByDOI(doi);
      } catch (err) {
        return serviceError(res, err);
      }

      // Best-effort PubMed enrichment when both identifiers are supplied
      if (pubmed_id && !metadata.pubmed_id) {
        try {
          const pmData = await fetchArticleByPubMedID(pubmed_id);
          metadata = {
            ...metadata,
            abstract: metadata.abstract || pmData.abstract,
            pubmed_id: pmData.pubmed_id,
          };
        } catch {
          // Non-fatal — CrossRef data is already good enough
        }
      }
    } else {
      try {
        metadata = await fetchArticleByPubMedID(pubmed_id);
      } catch (err) {
        return serviceError(res, err);
      }
    }

    return res.json({ metadata });
  } catch (err) {
    console.error('[fetchMetadata]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Dropbox PDF management ───────────────────────────────────────────────────

// POST /api/articles/:id/pdf  (multipart/form-data, field: "pdf")
async function uploadArticlePDF(req, res) {
  try {
    const article = await Article.findByPk(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    if (!req.file) return res.status(400).json({ error: 'No PDF file received' });

    let dropbox_path;
    try {
      dropbox_path = await uploadPDF(req.file.buffer, article.id);
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
      link = await generateDownloadLink(article.dropbox_path);
    } catch (err) {
      return serviceError(res, err);
    }

    // Cache the link on the article row — it expires in ~4h so we don't persist aggressively
    await article.update({ dropbox_link: link });

    return res.json({ link, expires_in: '4h' });
  } catch (err) {
    console.error('[getDownloadLink]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// DELETE /api/articles/:id/pdf  (admin only)
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

// GET /api/articles/dropbox/files  (admin only)
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

module.exports = {
  fetchMetadata,
  uploadArticlePDF,
  getDownloadLink,
  deleteArticlePDF,
  listDropboxFiles,
};
