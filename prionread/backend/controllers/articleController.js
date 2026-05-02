const { fetchArticleByDOI } = require('../services/crossref');
const { fetchArticleByPubMedID } = require('../services/pubmed');

// Maps service error codes to HTTP status codes
const HTTP_STATUS = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  UPSTREAM_ERROR: 503,
  PARSE_ERROR: 502,
};

function serviceError(res, err) {
  const status = HTTP_STATUS[err.code] || 500;
  return res.status(status).json({ error: err.message });
}

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

      // If DOI fetch succeeded but has no PMID, try enriching from PubMed when pubmed_id was also supplied
      if (pubmed_id && !metadata.pubmed_id) {
        try {
          const pmData = await fetchArticleByPubMedID(pubmed_id);
          // Merge: prefer CrossRef fields, fill in blanks with PubMed
          metadata = {
            ...metadata,
            abstract: metadata.abstract || pmData.abstract,
            pubmed_id: pmData.pubmed_id,
          };
        } catch {
          // PubMed enrichment is best-effort — don't fail the whole request
        }
      }
    } else {
      // pubmed_id only
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

module.exports = { fetchMetadata };
