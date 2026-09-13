const OpenAI = require('openai');

const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 600; // ~200 words in Spanish with some margin

let _client = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(
      new Error('OpenAI API key is not configured (OPENAI_API_KEY missing)'),
      { code: 'NOT_CONFIGURED' }
    );
  }
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

/**
 * Builds the prompt context from available article data.
 * Uses abstract if present; otherwise title + authors + journal as fallback.
 */
function buildPromptContent(article) {
  const parts = [];

  parts.push(`Título: ${article.title}`);
  if (article.authors) parts.push(`Autores: ${article.authors}`);
  if (article.year) parts.push(`Año: ${article.year}`);
  if (article.journal) parts.push(`Revista: ${article.journal}`);
  if (article.abstract) {
    parts.push(`\nAbstract:\n${article.abstract}`);
  } else {
    parts.push('\n(Abstract no disponible — basarse en título, autores y contexto de la revista)');
  }

  return parts.join('\n');
}

/**
 * Generates a structured Spanish summary of a scientific article.
 * @param {object} article - { title, authors, year, journal, abstract }
 * @returns {string} Generated summary text
 */
async function generateSummary(article) {
  const client = getClient(); // throws NOT_CONFIGURED if key absent

  const systemPrompt = `Eres un asistente especializado en literatura científica biomédica.
Tu tarea es generar resúmenes estructurados de artículos científicos para estudiantes de doctorado.
Responde SIEMPRE en español. Sé preciso, conciso y usa terminología científica adecuada.`;

  const userPrompt = `Resume el siguiente artículo científico en aproximadamente 200 palabras.
Estructura el resumen en cuatro secciones claramente diferenciadas:
1. **Objetivos**: ¿Qué pregunta o hipótesis aborda el estudio?
2. **Métodos**: ¿Qué técnicas o enfoques experimentales se utilizaron?
3. **Resultados**: ¿Cuáles son los hallazgos principales?
4. **Conclusiones**: ¿Qué implicaciones tienen estos resultados?

Datos del artículo:
${buildPromptContent(article)}`;

  let response;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: MAX_TOKENS,
      temperature: 0.4, // Low temperature for factual, consistent summaries
    });
  } catch (err) {
    if (err?.status === 401) {
      throw Object.assign(new Error('Invalid OpenAI API key'), { code: 'INVALID_KEY' });
    }
    if (err?.status === 429) {
      throw Object.assign(new Error('OpenAI rate limit or quota exceeded'), { code: 'RATE_LIMITED' });
    }
    throw Object.assign(
      new Error(`OpenAI request failed: ${err?.message || 'unknown error'}`),
      { code: 'UPSTREAM_ERROR' }
    );
  }

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw Object.assign(new Error('OpenAI returned an empty response'), { code: 'EMPTY_RESPONSE' });
  }

  return text;
}

/**
 * Generates multiple-choice comprehension questions for a scientific article.
 * Returns array of { question, options, correct } — caller must strip `correct` before sending to client.
 * @param {object} article - { title, authors, year, journal, abstract }
 * @returns {Array<{question: string, options: string[], correct: number}>}
 */
async function generateEvaluation(article) {
  const client = getClient();

  const systemPrompt = `Eres un experto en evaluación de comprensión lectora de artículos científicos biomédicos.
Genera preguntas de opción múltiple en español para evaluar la comprensión de un artículo.
Responde ÚNICAMENTE con JSON válido y sin texto adicional.`;

  const userPrompt = `Genera exactamente 5 preguntas de opción múltiple sobre el siguiente artículo científico.
Cada pregunta debe evaluar la comprensión real del contenido (objetivos, métodos, resultados o conclusiones).

Responde ÚNICAMENTE con este JSON (sin markdown, sin texto extra):
{
  "questions": [
    {
      "question": "Texto de la pregunta",
      "options": ["Opción A", "Opción B", "Opción C", "Opción D"],
      "correct": 0
    }
  ]
}

donde "correct" es el índice (0-3) de la opción correcta.

Datos del artículo:
${buildPromptContent(article)}`;

  let response;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1200,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });
  } catch (err) {
    if (err?.status === 401) {
      throw Object.assign(new Error('Invalid OpenAI API key'), { code: 'INVALID_KEY' });
    }
    if (err?.status === 429) {
      throw Object.assign(new Error('OpenAI rate limit or quota exceeded'), { code: 'RATE_LIMITED' });
    }
    throw Object.assign(
      new Error(`OpenAI request failed: ${err?.message || 'unknown error'}`),
      { code: 'UPSTREAM_ERROR' }
    );
  }

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw Object.assign(new Error('OpenAI returned an empty response'), { code: 'EMPTY_RESPONSE' });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('OpenAI returned invalid JSON'), { code: 'UPSTREAM_ERROR' });
  }

  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw Object.assign(new Error('OpenAI returned no questions'), { code: 'UPSTREAM_ERROR' });
  }

  return parsed.questions;
}

/**
 * Asks the model to extract the bibliographic header (title, first-author
 * surname, publication year) from the raw text of a scientific PDF.
 *
 * Pre-trimmed to the first ~12k characters because:
 *  - Title / authors / year always appear on page 1.
 *  - gpt-4o-mini's context is huge but we don't need to pay for the whole
 *    paper just to read the masthead.
 *
 * Returns { title, first_author_lastname, year } — any field may be null
 * if the model can't determine it confidently.
 */
async function identifyArticleFromPdfText(pdfText) {
  const client = getClient();

  const excerpt = (pdfText || '').slice(0, 12000);
  if (!excerpt.trim()) {
    throw Object.assign(new Error('PDF text is empty'), { code: 'INVALID_INPUT' });
  }

  const systemPrompt = `You extract bibliographic metadata from scientific PDFs.
Reply ONLY with valid JSON, no markdown, no prose.`;

  const userPrompt = `Below is text extracted from the first pages of a scientific paper.
Identify the article and reply with this exact JSON shape:

{
  "title": "the full article title, single line, no trailing period",
  "first_author_lastname": "Surname only of the first listed author",
  "year": 1234
}

Rules:
- "title" must be the article's own title, not the journal name or running header.
- Strip line breaks and hyphenation that came from PDF layout (e.g. "glyco-\\nforms" -> "glycoforms").
- "first_author_lastname" is just the family name (e.g. "Stack", "García-López"), no initials.
- "year" is the integer publication year (e.g. 2002). Use the article's own year, not "Received" or "Accepted" dates if both are present.
- If a field cannot be determined confidently, set it to null.

PDF text:
"""
${excerpt}
"""`;

  let response;
  try {
    response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  } catch (err) {
    if (err?.status === 401) throw Object.assign(new Error('Invalid OpenAI API key'), { code: 'INVALID_KEY' });
    if (err?.status === 429) throw Object.assign(new Error('OpenAI rate limit or quota exceeded'), { code: 'RATE_LIMITED' });
    throw Object.assign(new Error(`OpenAI request failed: ${err?.message || 'unknown error'}`), { code: 'UPSTREAM_ERROR' });
  }

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw Object.assign(new Error('OpenAI returned an empty response'), { code: 'EMPTY_RESPONSE' });

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw Object.assign(new Error('OpenAI returned invalid JSON'), { code: 'UPSTREAM_ERROR' }); }

  return {
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null,
    first_author_lastname:
      typeof parsed.first_author_lastname === 'string' && parsed.first_author_lastname.trim()
        ? parsed.first_author_lastname.trim()
        : null,
    year: Number.isInteger(parsed.year) && parsed.year > 1800 && parsed.year < 2100 ? parsed.year : null,
  };
}

module.exports = { generateSummary, generateEvaluation, identifyArticleFromPdfText };
