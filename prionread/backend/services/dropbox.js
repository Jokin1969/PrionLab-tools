const dbx = require('../config/dropbox');

const ROOT_FOLDER = '/PrioLab tools/PrionRead';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitizes a string for use as a Dropbox filename.
 * Replaces slashes (common in DOIs) and other unsafe chars with underscores.
 */
function sanitizeForFilename(str) {
  return String(str)
    .replace(/\//g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Returns the Dropbox path for an article's PDF.
 * Priority: DOI → PMID → UUID fallback
 */
function dropboxPath(article) {
  let name;
  if (article.doi) {
    name = sanitizeForFilename(article.doi);
  } else if (article.pubmed_id) {
    name = `PMID_${sanitizeForFilename(String(article.pubmed_id))}`;
  } else {
    name = sanitizeForFilename(article.id);
  }
  return `${ROOT_FOLDER}/${name}.pdf`;
}

/**
 * Wraps Dropbox SDK errors with a code so callers can map to HTTP status.
 */
function wrapDropboxError(err, context) {
  const status = err?.status || err?.error?.error_summary;

  if (err?.status === 409 || String(status).includes('not_found')) {
    return Object.assign(new Error(`File not found in Dropbox`), { code: 'NOT_FOUND' });
  }
  if (err?.status === 429) {
    return Object.assign(new Error('Dropbox rate limit reached'), { code: 'RATE_LIMITED' });
  }
  console.error(`[dropbox:${context}]`, err);
  return Object.assign(new Error(`Dropbox error: ${err?.message || 'unknown'}`), {
    code: 'UPSTREAM_ERROR',
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Uploads a PDF buffer to /PrioLab tools/PrionRead/{doi|PMID_pmid|uuid}.pdf
 * @param {Buffer} fileBuffer  - raw PDF bytes (from multer memoryStorage)
 * @param {object} article     - must contain at least { id, doi?, pubmed_id? }
 * @returns {string} dropbox_path stored in the DB
 */
async function uploadPDF(fileBuffer, article) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw Object.assign(new Error('File buffer is empty or invalid'), { code: 'INVALID_INPUT' });
  }

  const path = dropboxPath(article);

  try {
    await dbx.filesUpload({
      path,
      contents: fileBuffer,
      mode: { '.tag': 'overwrite' },
      autorename: false,
      mute: true,
    });
    return path;
  } catch (err) {
    throw wrapDropboxError(err, 'uploadPDF');
  }
}

/**
 * Generates a temporary download link valid for ~4 hours.
 * @param {string} dropboxFilePath  - e.g. /PrioLab tools/PrionRead/10.1016_....pdf
 * @returns {string} HTTPS link
 */
async function generateDownloadLink(dropboxFilePath) {
  if (!dropboxFilePath) {
    throw Object.assign(new Error('dropbox_path is required'), { code: 'INVALID_INPUT' });
  }

  try {
    const result = await dbx.filesGetTemporaryLink({ path: dropboxFilePath });
    return result.result.link;
  } catch (err) {
    throw wrapDropboxError(err, 'generateDownloadLink');
  }
}

/**
 * Lists files inside a Dropbox folder.
 * @param {string} folder  - defaults to ROOT_FOLDER
 * @returns {Array<{ name, path, size, modified }>}
 */
async function listFiles(folder = ROOT_FOLDER) {
  try {
    const result = await dbx.filesListFolder({ path: folder, recursive: false });
    return result.result.entries
      .filter((e) => e['.tag'] === 'file')
      .map((e) => ({
        name: e.name,
        path: e.path_lower,
        size: e.size,
        modified: e.server_modified,
      }));
  } catch (err) {
    // An empty or non-existent folder returns a specific error; treat as empty list
    if (err?.status === 409) return [];
    throw wrapDropboxError(err, 'listFiles');
  }
}

/**
 * Permanently deletes a file from Dropbox.
 * @param {string} dropboxFilePath - e.g. /PrioLab tools/PrionRead/10.1016_....pdf
 */
async function deletePDF(dropboxFilePath) {
  if (!dropboxFilePath) {
    throw Object.assign(new Error('dropbox_path is required'), { code: 'INVALID_INPUT' });
  }

  try {
    await dbx.filesDeleteV2({ path: dropboxFilePath });
  } catch (err) {
    // If already gone, treat as success — idempotent delete
    if (err?.status === 409) return;
    throw wrapDropboxError(err, 'deletePDF');
  }
}

module.exports = { uploadPDF, generateDownloadLink, listFiles, deletePDF };
