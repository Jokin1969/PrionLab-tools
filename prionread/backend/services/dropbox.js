const dbx = require('../config/dropbox');

const ROOT_FOLDER = '/PrionLab tools/PrionVault';
const DUPLICATES_FOLDER = `${ROOT_FOLDER}/_Duplicados`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeForFilename(str) {
  return String(str)
    .replace(/\//g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Returns the expected Dropbox path for an article's PDF.
 * Layout: /PrionLab tools/PrionVault/<year>/<doi|pmid|uuid>.pdf
 */
function dropboxPath(article) {
  const year = article.year || 'unknown';
  let name;
  if (article.doi) {
    name = sanitizeForFilename(article.doi);
  } else if (article.pubmed_id) {
    name = `PMID_${sanitizeForFilename(String(article.pubmed_id))}`;
  } else {
    name = sanitizeForFilename(article.id);
  }
  return `${ROOT_FOLDER}/${year}/${name}.pdf`;
}

function wrapDropboxError(err, context) {
  const status = err?.status || err?.error?.error_summary;
  if (err?.status === 409 || String(status).includes('not_found')) {
    return Object.assign(new Error('File not found in Dropbox'), { code: 'NOT_FOUND' });
  }
  if (err?.status === 429) {
    return Object.assign(new Error('Dropbox rate limit reached'), { code: 'RATE_LIMITED' });
  }
  console.error(`[dropbox:${context}]`, err);
  return Object.assign(new Error(`Dropbox error: ${err?.message || 'unknown'}`), { code: 'UPSTREAM_ERROR' });
}

// ─── Public API ───────────────────────────────────────────────────────────────

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

async function checkFileExists(dropboxFilePath) {
  if (!dropboxFilePath) return false;
  try {
    await dbx.filesGetMetadata({ path: dropboxFilePath });
    return true;
  } catch (err) {
    if (err?.status === 409 || String(err?.error?.error_summary || '').includes('not_found')) {
      return false;
    }
    throw wrapDropboxError(err, 'checkFileExists');
  }
}

async function listFiles(folder = ROOT_FOLDER) {
  try {
    const entries = [];
    let result = await dbx.filesListFolder({ path: folder, recursive: true });
    entries.push(...result.result.entries);
    while (result.result.has_more) {
      result = await dbx.filesListFolderContinue({ cursor: result.result.cursor });
      entries.push(...result.result.entries);
    }
    return entries
      .filter((e) => e['.tag'] === 'file')
      .map((e) => ({ name: e.name, path: e.path_lower, size: e.size, modified: e.server_modified }));
  } catch (err) {
    if (err?.status === 409) return [];
    throw wrapDropboxError(err, 'listFiles');
  }
}

/**
 * Relocates a PDF to /PrionLab tools/PrionVault/_Duplicados/ when an
 * article is recognised as a duplicate (e.g. via the AI PMID lookup).
 * Mirrors the behaviour of the PrionVault ingest worker, which also
 * stages duplicate sources aside instead of deleting them outright.
 * Returns the new path, or null if there was nothing to move.
 */
async function moveToDuplicatesFolder(dropboxFilePath) {
  if (!dropboxFilePath) return null;
  const filename = dropboxFilePath.split('/').pop();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const targetPath = `${DUPLICATES_FOLDER}/${stamp}_${filename}`;
  try {
    const result = await dbx.filesMoveV2({
      from_path: dropboxFilePath,
      to_path: targetPath,
      autorename: true,
      allow_ownership_transfer: false,
    });
    return result?.result?.metadata?.path_display || targetPath;
  } catch (err) {
    throw wrapDropboxError(err, 'moveToDuplicatesFolder');
  }
}

async function deletePDF(dropboxFilePath) {
  if (!dropboxFilePath) {
    throw Object.assign(new Error('dropbox_path is required'), { code: 'INVALID_INPUT' });
  }
  try {
    await dbx.filesDeleteV2({ path: dropboxFilePath });
  } catch (err) {
    if (err?.status === 409) return;
    throw wrapDropboxError(err, 'deletePDF');
  }
}

module.exports = {
  uploadPDF, generateDownloadLink, checkFileExists, listFiles,
  deletePDF, moveToDuplicatesFolder, dropboxPath,
  ROOT_FOLDER, DUPLICATES_FOLDER,
};
