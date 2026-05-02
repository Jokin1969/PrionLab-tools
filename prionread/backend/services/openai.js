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

module.exports = { generateSummary };
