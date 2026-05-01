/* PrionPacks – Claude API integration */

const PPApi = (() => {
  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const MODEL    = 'claude-sonnet-4-20250514';

  async function translateTitle(text) {
    const apiKey = PPStorage.getApiKey();
    if (!apiKey) throw new Error('No API key configured. Please set your Claude API key in the panel on the right.');

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Translate this scientific finding title from Spanish to English, maintaining scientific accuracy and terminology. Return ONLY the English translation with no extra text:\n\n"${text}"`,
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const data = await response.json();
    return data.content[0].text.trim().replace(/^["']|["']$/g, '');
  }

  async function askClaude(context, fieldLabel, fieldContent) {
    const apiKey = PPStorage.getApiKey();
    if (!apiKey) throw new Error('No API key configured. Please set your Claude API key in the panel on the right.');

    const contextBlock = context.length > 0
      ? `CONTEXTO DEL PAQUETE DE INVESTIGACIÓN:\n${context.map(c => `• ${c.label}: ${c.text}`).join('\n')}\n\n`
      : '';

    const prompt = `Eres un asistente científico del equipo PrionLab, especializado en enfermedades priónicas y neurociencia traslacional.
${contextBlock}SOLICITUD DEL USUARIO (campo: "${fieldLabel}"):
---
${fieldContent}
---
Responde a lo que el usuario ha escrito. Si incluye una petición de traducción al inglés, proporciona únicamente la traducción. Si es una pregunta, análisis u opinión, responde en español de forma detallada y científica. Si el texto termina con comentarios o instrucciones dirigidas a ti, tenlos en cuenta al elaborar tu respuesta.`;

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: prompt,
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const data = await response.json();
    return data.content[0].text.trim();
  }

  return { translateTitle, askClaude };
})();
