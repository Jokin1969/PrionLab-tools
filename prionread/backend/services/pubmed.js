const axios = require('axios');
const { normalizeMetadata } = require('../utils/normalizeMetadata');

const ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const NCBI_PARAMS = {
  db: 'pubmed',
  retmode: 'json',
  tool: 'PrionRead',
  email: 'admin@prionread.app',
};

// ─── XML helpers (no external parser needed for simple extraction) ────────────

const XML_NAMED_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeXmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_NAMED_ENTITIES[m] || m);
}

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeXmlEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()) : null;
}

function xmlAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = decodeXmlEntities(m[1].replace(/<[^>]+>/g, '').trim());
    if (text) results.push(text);
  }
  return results;
}

// ─── Author formatting ────────────────────────────────────────────────────────

function parseAuthorsFromXml(xml) {
  const authorListMatch = xml.match(/<AuthorList[^>]*>([\s\S]*?)<\/AuthorList>/i);
  if (!authorListMatch) return null;

  const listXml = authorListMatch[1];
  const authorBlocks = listXml.match(/<Author[^>]*>[\s\S]*?<\/Author>/gi) || [];

  const names = authorBlocks.map((block) => {
    const collective = xmlText(block, 'CollectiveName');
    if (collective) return collective;
    const last = xmlText(block, 'LastName');
    const initials = xmlText(block, 'Initials');
    if (!last) return null;
    return initials ? `${last} ${initials}` : last;
  });

  return names.filter(Boolean).join(', ') || null;
}

function extractDoiFromXml(xml) {
  const m = xml.match(/<ArticleId\s+IdType="doi">([^<]+)<\/ArticleId>/i);
  return m ? m[1].trim().toLowerCase() : null;
}

// ─── DOI → PMID lookup ───────────────────────────────────────────────────────

/**
 * Returns the PMID for a given DOI by querying PubMed esearch, or null if not found.
 */
async function searchPubMedByDOI(doi) {
  if (!doi) return null;
  try {
    const { data } = await axios.get(ESEARCH_URL, {
      params: { ...NCBI_PARAMS, term: `${doi}[doi]`, retmax: 1 },
      timeout: 8000,
    });
    return data?.esearchresult?.idlist?.[0] || null;
  } catch {
    return null;
  }
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

async function fetchArticleByPubMedID(pmid) {
  if (!pmid || String(pmid).trim() === '') {
    throw Object.assign(new Error('PubMed ID must be a non-empty value'), { code: 'INVALID_INPUT' });
  }

  const id = String(pmid).trim();

  let summary;
  try {
    const { data } = await axios.get(ESUMMARY_URL, {
      params: { ...NCBI_PARAMS, id },
      timeout: 10000,
    });
    summary = data?.result?.[id];
  } catch (err) {
    throw Object.assign(
      new Error(`PubMed esummary request failed: ${err.message}`),
      { code: 'UPSTREAM_ERROR' }
    );
  }

  if (!summary || summary.error) {
    throw Object.assign(new Error(`PubMed ID not found: ${id}`), { code: 'NOT_FOUND' });
  }

  const journalFromSummary = summary.fulljournalname || summary.source || null;
  const yearFromSummary = summary.pubdate ? parseInt(summary.pubdate, 10) : null;

  let xml;
  try {
    const { data } = await axios.get(EFETCH_URL, {
      params: { ...NCBI_PARAMS, id, rettype: 'abstract', retmode: 'xml' },
      // efetch's abstract response is heavier than esummary; the
      // previous 10 s timeout occasionally cut off perfectly valid
      // responses on a slow round-trip, which silently dropped the
      // abstract.
      timeout: 20000,
    });
    xml = typeof data === 'string' ? data : String(data);
  } catch (err) {
    throw Object.assign(
      new Error(`PubMed efetch request failed: ${err.message}`),
      { code: 'UPSTREAM_ERROR' }
    );
  }

  if (!xml || !xml.includes('<PubmedArticle')) {
    throw Object.assign(new Error(`No article XML returned for PMID ${id}`), { code: 'NOT_FOUND' });
  }

  const title = xmlText(xml, 'ArticleTitle');
  const abstract = xmlAll(xml, 'AbstractText').join(' ') || null;
  const authors = parseAuthorsFromXml(xml);
  const doi = extractDoiFromXml(xml);

  const pubYear = (() => {
    const y = xmlText(xml, 'Year');
    const parsed = y ? parseInt(y, 10) : null;
    return parsed && parsed > 1000 ? parsed : yearFromSummary;
  })();

  return normalizeMetadata({
    title,
    authors,
    year: pubYear,
    journal: journalFromSummary,
    abstract,
    doi,
    pubmed_id: id,
  });
}

// ─── Title-based PMID lookup (used by AI-assisted identification) ────────────

/**
 * Builds a PubMed search term from a title fragment, optionally narrowed by
 * first-author surname and publication year. We deliberately take only the
 * first ~10 words of the title — long titles with punctuation often break
 * PubMed's parser, while the first 10 words are essentially unique.
 */
function buildTitleSearchTerm({ title, author, year }) {
  if (!title) return null;
  const words = title
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .join(' ');
  if (!words) return null;

  const parts = [`"${words}"[Title]`];
  if (author) {
    const a = author.replace(/[^\p{L}\s-]+/gu, '').trim();
    if (a) parts.push(`${a}[Author]`);
  }
  if (year && Number.isInteger(year)) parts.push(`${year}[PDAT]`);
  return parts.join(' AND ');
}

async function esearchTopPmid(term) {
  const { data } = await axios.get(ESEARCH_URL, {
    // Best-match ranking matches PubMed's web search box; without
    // it esearch returns most-recent first, which can bury the
    // actual paper.
    params: { ...NCBI_PARAMS, term, retmax: 1, sort: 'relevance' },
    timeout: 8000,
  });
  return data?.esearchresult?.idlist?.[0] || null;
}

/**
 * Builds a free-text PubMed term — no field qualifier, so the search
 * runs against PubMed's default index (Title + Abstract + MeSH). Used
 * as a final fallback for titles whose punctuation confuses the
 * strict [Title] phrase operator.
 */
function buildFreeTextTerm({ title, author, year }) {
  if (!title) return null;
  const words = title
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .join(' ');
  if (!words) return null;
  const parts = [words];
  if (author) {
    const a = author.replace(/[^\p{L}\s-]+/gu, '').trim();
    if (a) parts.push(`${a}[Author]`);
  }
  if (year && Number.isInteger(year)) parts.push(`${year}[PDAT]`);
  return parts.join(' AND ');
}

/**
 * Looks up a PMID from the article's bibliographic header. Tries the
 * narrowest query first and progressively relaxes — the final tiers
 * drop the [Title] field qualifier so titles with colons or
 * parentheses (which the strict phrase operator chokes on) still
 * resolve.
 *
 * Returns the PMID string, or null if no hit on any tier.
 */
async function searchPubMedByTitle({ title, author, year }) {
  if (!title) return null;

  const tiers = [
    buildTitleSearchTerm({ title, author, year }),
    buildTitleSearchTerm({ title, author }),
    buildTitleSearchTerm({ title, year }),
    buildTitleSearchTerm({ title }),
    buildFreeTextTerm({ title, author }),
    buildFreeTextTerm({ title }),
  ].filter(Boolean);

  for (const term of tiers) {
    try {
      const pmid = await esearchTopPmid(term);
      if (pmid) return pmid;
    } catch { /* try next tier */ }
  }
  return null;
}

module.exports = { fetchArticleByPubMedID, searchPubMedByDOI, searchPubMedByTitle };
