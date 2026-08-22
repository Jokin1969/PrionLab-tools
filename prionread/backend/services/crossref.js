const axios = require('axios');
const { normalizeMetadata } = require('../utils/normalizeMetadata');

const BASE_URL = 'https://api.crossref.org/works';
// Polite pool: CrossRef asks for a mailto in User-Agent
const USER_AGENT = 'PrionRead/1.0 (mailto:admin@prionread.app)';

/**
 * Formats a CrossRef author list into "Smith J, Doe A, ..." style.
 * CrossRef gives: [{ given, family }] but family can be absent for org names.
 */
function formatAuthors(authorList = []) {
  return authorList
    .map((a) => {
      if (!a.family) return a.name || '';
      const initials = a.given
        ? a.given
            .split(/\s+/)
            .map((n) => n[0])
            .join('')
        : '';
      return initials ? `${a.family} ${initials}` : a.family;
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * CrossRef returns title as an array (can have HTML). Take first, strip tags.
 */
function extractTitle(titleArr = []) {
  const raw = Array.isArray(titleArr) ? titleArr[0] : titleArr;
  return typeof raw === 'string' ? raw.replace(/<[^>]+>/g, '').trim() : '';
}

function extractYear(message) {
  // Try published date fields in order of preference
  const sources = [
    message['published-print'],
    message['published-online'],
    message['issued'],
    message['created'],
  ];
  for (const src of sources) {
    const parts = src?.['date-parts']?.[0];
    if (parts?.[0]) return parts[0];
  }
  return null;
}

function extractJournal(message) {
  // container-title is an array; use first non-empty entry
  const titles = message['container-title'];
  if (Array.isArray(titles)) return titles.find((t) => t) || null;
  return null;
}

async function fetchArticleByDOI(doi) {
  if (!doi || typeof doi !== 'string') {
    throw Object.assign(new Error('DOI must be a non-empty string'), { code: 'INVALID_INPUT' });
  }

  const cleanDoi = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  const url = `${BASE_URL}/${encodeURIComponent(cleanDoi)}`;

  let response;
  try {
    response = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000,
    });
  } catch (err) {
    if (err.response?.status === 404) {
      throw Object.assign(new Error(`DOI not found: ${cleanDoi}`), { code: 'NOT_FOUND' });
    }
    throw Object.assign(
      new Error(`CrossRef request failed: ${err.message}`),
      { code: 'UPSTREAM_ERROR' }
    );
  }

  const msg = response.data?.message;
  if (!msg) {
    throw Object.assign(new Error('Unexpected CrossRef response shape'), { code: 'PARSE_ERROR' });
  }

  return normalizeMetadata({
    title: extractTitle(msg.title),
    authors: formatAuthors(msg.author),
    year: extractYear(msg),
    journal: extractJournal(msg),
    abstract: msg.abstract ? msg.abstract.replace(/<[^>]+>/g, '').trim() : null,
    doi: cleanDoi,
    pubmed_id: null,
  });
}

module.exports = { fetchArticleByDOI };
