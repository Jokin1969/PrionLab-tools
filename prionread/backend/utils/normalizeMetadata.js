/**
 * Ensures a consistent metadata shape regardless of source (CrossRef / PubMed).
 * All fields except title are optional; missing ones become null.
 */
function normalizeMetadata(raw) {
  const title = (raw.title || '').trim();
  if (!title) throw new Error('Article title is missing from metadata');

  const year = raw.year ? parseInt(raw.year, 10) : null;
  if (year && (Number.isNaN(year) || year < 1000 || year > 2100)) {
    throw new Error(`Invalid year: ${raw.year}`);
  }

  return {
    title,
    authors: raw.authors ? raw.authors.trim() : null,
    year: year || null,
    journal: raw.journal ? raw.journal.trim() : null,
    abstract: raw.abstract ? raw.abstract.trim() : null,
    doi: raw.doi ? raw.doi.trim().toLowerCase() : null,
    pubmed_id: raw.pubmed_id ? String(raw.pubmed_id).trim() : null,
  };
}

module.exports = { normalizeMetadata };
