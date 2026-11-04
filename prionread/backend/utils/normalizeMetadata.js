/**
 * Decodes numeric HTML entities (&#xF3; → ó, &#243; → ó) and common named
 * entities that can appear in CrossRef / PubMed metadata.
 */
function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g,            (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Ensures a consistent metadata shape regardless of source (CrossRef / PubMed).
 * All fields except title are optional; missing ones become null.
 */
function normalizeMetadata(raw) {
  const title = decodeEntities((raw.title || '').trim());
  if (!title) throw new Error('Article title is missing from metadata');

  const year = raw.year ? parseInt(raw.year, 10) : null;
  if (year && (Number.isNaN(year) || year < 1000 || year > 2100)) {
    throw new Error(`Invalid year: ${raw.year}`);
  }

  return {
    title,
    authors:   raw.authors  ? decodeEntities(raw.authors.trim())  : null,
    year:      year || null,
    journal:   raw.journal  ? decodeEntities(raw.journal.trim())  : null,
    abstract:  raw.abstract ? decodeEntities(raw.abstract.trim()) : null,
    doi:       raw.doi      ? raw.doi.trim().toLowerCase()        : null,
    pubmed_id: raw.pubmed_id ? String(raw.pubmed_id).trim()       : null,
  };
}

module.exports = { normalizeMetadata };
