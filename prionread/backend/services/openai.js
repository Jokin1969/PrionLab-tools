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

module.exports = { generateSummary, generateEvaluation };
