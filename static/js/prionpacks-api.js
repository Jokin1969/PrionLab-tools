/* PrionPacks – Claude API integration */

class RefusalError extends Error {
  constructor(prompt) {
    super('El modelo se ha negado a responder. Se ha copiado el prompt al portapapeles para que lo pegues en otra IA.');
    this.name = 'RefusalError';
    this.prompt = prompt || '';
  }
}

const PPApi = (() => {
  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  // Latest Claude Sonnet model — stable alias accepted by the Anthropic API.
  const MODEL    = 'claude-sonnet-4-5';

  function _extractText(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Respuesta vacía o no-JSON de la API.');
    }
    // Note: stop_reason=='refusal' is now handled at the call-site so that
    // the caller can throw a RefusalError carrying the original prompt for
    // the user to copy into another AI tool.
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

    // Two-pass strategy. Sonnet 4.5 sometimes returns stop_reason=refusal on
    // bare translation requests; an assistant prefill ("<english>") strongly
    // anchors the model to continue the translation rather than refuse.
    async function _call(body) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${response.status}`);
      }
      return response.json();
    }

    const body1 = {
      model: MODEL,
      max_tokens: 400,
      system: 'You are a bilingual scientific copy-editor in a neurology / prion-disease research group at CIC bioGUNE. Your job is to render the user-supplied research finding into clear English suitable for a journal manuscript. If the input is already in English you return it unchanged.',
      messages: [
        { role: 'user',      content: `<source>${text}</source>\n\nReturn the English version inside <english>…</english>.` },
        { role: 'assistant', content: '<english>' },
      ],
      stop_sequences: ['</english>'],
    };

    let data;
    try {
      data = await _call(body1);
    } catch (e) {
      throw e;
    }

    if (data.stop_reason === 'refusal') {
      // Fallback: try again without the system prompt, simpler framing.
      const body2 = {
        model: MODEL,
        max_tokens: 400,
        messages: [
          { role: 'user',      content: `Translate to English (return only the translation):\n\n${text}` },
          { role: 'assistant', content: 'English: ' },
        ],
      };
      data = await _call(body2);
    }

    if (data.stop_reason === 'refusal') {
      // Both attempts refused — surface the prompt the user can copy elsewhere.
      const fallbackPrompt =
        'Traduce al inglés (solo devuelve la traducción, sin comentarios):\n\n' + text;
      throw new RefusalError(fallbackPrompt);
    }

    let out = _extractText(data).trim();
    // Strip any residual <english> tag the model may have echoed
    out = out.replace(/^<\/?english[^>]*>/gi, '').replace(/<\/english>\s*$/i, '').trim();
    out = out.replace(/^["']|["']$/g, '').replace(/^English:\s*/i, '').trim();
    return out;
  }

  async function askClaude(context, fieldLabel, fieldContent, imageDataUrl = null, documents = []) {
    const apiKey = PPStorage.getApiKey();
    if (!apiKey) throw new Error('No API key configured. Please set your Claude API key in the panel on the right.');

    const contextBlock = context.length > 0
      ? `Contexto del paquete de investigación:\n${context.map(c => `- ${c.label}: ${c.text}`).join('\n')}\n\n`
      : '';

    const systemPrompt = 'Eres un asistente científico del equipo PrionLab (CIC bioGUNE), especializado en enfermedades priónicas y neurociencia traslacional. Respondes en español por defecto, salvo que el usuario pida explícitamente otro idioma. Tu tono es preciso, claro y de nivel de manuscrito científico.';

    const promptText = `${contextBlock}Campo del paquete: ${fieldLabel}\n\nContenido / petición del usuario:\n${fieldContent}`;

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
        system: systemPrompt,
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

    if (data.stop_reason === 'refusal') {
      // Build a copy-friendly version of the prompt so the user can paste it
      // into a different AI assistant.
      const docList = (documents || []).map(d => `- ${d.name} (${d.mimeType})`).join('\n');
      const docsBlock = docList ? `\n\nAdjuntos (no se han podido enviar al portapapeles):\n${docList}` : '';
      const imgNote   = imageDataUrl ? '\n\n(Hay también una imagen adjunta a este prompt; pásala manualmente al asistente.)' : '';
      const fullPrompt =
        '— ROL —\n' + systemPrompt + '\n\n— PROMPT —\n' + promptText + docsBlock + imgNote;
      throw new RefusalError(fullPrompt);
    }

    return _extractText(data).trim();
  }

  return { translateTitle, askClaude };
})();
