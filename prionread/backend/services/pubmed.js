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

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
}

function xmlAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
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

  // 1. esummary — fast check that the record exists + grab journal/year
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

  // 2. efetch — full XML for title, authors, abstract, DOI
  let xml;
  try {
    const { data } = await axios.get(EFETCH_URL, {
      params: { ...NCBI_PARAMS, id, rettype: 'abstract', retmode: 'xml' },
      timeout: 10000,
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

module.exports = { fetchArticleByPubMedID, searchPubMedByDOI };
