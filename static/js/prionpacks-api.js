/* PrionPacks – Claude API integration */

const PPApi = (() => {
  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  // Latest Claude Sonnet model — stable alias accepted by the Anthropic API.
  const MODEL    = 'claude-sonnet-4-5';

  function _extractText(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Respuesta vacía o no-JSON de la API.');
    }
    if (!Array.isArray(data.content)) {
      console.error('Unexpected Claude response shape:', data);
      const snap = JSON.stringify(data).slice(0, 400);
      throw new Error('Respuesta sin campo "content". Snapshot: ' + snap);
    }
    // Strict: a proper text block.
    let block = data.content.find(c => c && c.type === 'text' && typeof c.text === 'string');
    // Fallback: any block exposing a string text/value/output.
    if (!block) {
      block = data.content.find(c => c && (typeof c.text === 'string' || typeof c.value === 'string' || typeof c.output === 'string'));
    }
    if (!block) {
      console.error('No text block in response:', data);
      const types = data.content.map(c => c?.type ?? typeof c).join(', ') || '(vacío)';
      const snap  = JSON.stringify(data).slice(0, 400);
      throw new Error(`Sin bloque de texto. Tipos recibidos: [${types}]. Respuesta: ${snap}`);
    }
    return block.text || block.value || block.output || '';
  }

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
    return _extractText(data).trim().replace(/^["']|["']$/g, '');
  }

  async function askClaude(context, fieldLabel, fieldContent, imageDataUrl = null, documents = []) {
    const apiKey = PPStorage.getApiKey();
    if (!apiKey) throw new Error('No API key configured. Please set your Claude API key in the panel on the right.');

    const contextBlock = context.length > 0
      ? `CONTEXTO DEL PAQUETE DE INVESTIGACIÓN:\n${context.map(c => `• ${c.label}: ${c.text}`).join('\n')}\n\n`
      : '';

    const promptText = `Eres un asistente científico del equipo PrionLab, especializado en enfermedades priónicas y neurociencia traslacional.
${contextBlock}SOLICITUD DEL USUARIO (campo: "${fieldLabel}"):
---
${fieldContent}
---
Responde a lo que el usuario ha escrito. Si incluye una petición de traducción al inglés, proporciona únicamente la traducción. Si es una pregunta, análisis u opinión, responde en español de forma detallada y científica. Si el texto termina con comentarios o instrucciones dirigidas a ti, tenlos en cuenta al elaborar tu respuesta.`;

    const contentParts = [];

    // PDF documents (Claude document blocks)
    for (const doc of documents) {
      if (doc.mimeType === 'application/pdf') {
        const base64 = doc.dataUrl.split(',')[1];
        contentParts.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          title: doc.name,
        });
      }
    }

    // Image (for figure captions)
    if (imageDataUrl) {
      const match = imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        contentParts.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
      }
    }

    contentParts.push({ type: 'text', text: promptText });

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
          content: contentParts.length === 1 ? contentParts[0].text : contentParts,
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const data = await response.json();
    return _extractText(data).trim();
  }

  return { translateTitle, askClaude };
})();
