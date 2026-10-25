  // ── Help modal ────────────────────────────────────────────────────────────
  // Ordered (key, label) list matching #pv-help-tabs — used both to wire
  // the tab buttons and to walk every tab in order when building the PDF.
  const _HELP_TABS = [
    { key: 'roles',          label: '👤 Roles' },
    { key: 'busqueda',       label: '🔍 Búsqueda' },
    { key: 'carrito',        label: '🛒 Carrito' },
    { key: 'ia',             label: '🤖 IA: chats y notas' },
    { key: 'notificaciones', label: '🔔 Notificaciones' },
    { key: 'salud',          label: '❤️ Salud biblioteca' },
    { key: 'jc',             label: '📖 Journal Club' },
    { key: 'administracion', label: '⚙️ Administración' },
  ];

  window.openPrionVaultHelp = function openPrionVaultHelp() {
    const modal = document.getElementById('pv-help-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    _helpRenderTab('roles');

    // Wire tabs (only once)
    if (!modal.dataset.wired) {
      modal.dataset.wired = '1';
      modal.querySelectorAll('.pv-help-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          modal.querySelectorAll('.pv-help-tab').forEach(b => b.classList.remove('pv-help-tab-active'));
          btn.classList.add('pv-help-tab-active');
          _helpRenderTab(btn.dataset.tab);
        });
      });
      document.getElementById('pv-help-pdf-btn')?.addEventListener('click', _downloadAyudaPdf);
      document.getElementById('pv-help-pptx-btn')?.addEventListener('click', _downloadAyudaPptx);
    }
  };

  // Downloads the whole Ayuda content (every tab, in order) as one PDF.
  // The content itself only exists client-side (see _helpTabsHtml below),
  // so we POST the rendered HTML per tab and the backend converts it.
  async function _downloadAyudaPdf() {
    const btn = document.getElementById('pv-help-pdf-btn');
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando…'; }
    try {
      const tabsHtml = _helpTabsHtml();
      const sections = _HELP_TABS.map(t => ({ tab: t.key, label: t.label, html: tabsHtml[t.key] || '' }));
      const res = await fetch('/prionvault/api/help/report', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'ayuda-prionvault.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('No se pudo generar el PDF: ' + (e.message || e));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  // Same idea as _downloadAyudaPdf but for the PPTX export — same tabs
  // payload, different backend renderer (services/help_pptx.py), so both
  // downloads always reflect whatever the Ayuda content currently says.
  async function _downloadAyudaPptx() {
    const btn = document.getElementById('pv-help-pptx-btn');
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando…'; }
    try {
      const tabsHtml = _helpTabsHtml();
      const sections = _HELP_TABS.map(t => ({ tab: t.key, label: t.label, html: tabsHtml[t.key] || '' }));
      const res = await fetch('/prionvault/api/help/pptx', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'guia-prionvault.pptx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('No se pudo generar el PPTX: ' + (e.message || e));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  // Builds the { tabKey: renderedHtml } map for every Ayuda tab. Split out
  // of _helpRenderTab so the PDF export can read every tab's content
  // without having to paint each one into the DOM first.
  function _helpTabsHtml() {
    const YES = '<span class="pv-help-yes">✓</span>';
    const NO  = '<span class="pv-help-no">—</span>';
    const PART= '<span class="pv-help-partial">parcial</span>';

    const html = {

      // ── Carrito ───────────────────────────────────────────────────────
      carrito: `
        <div class="pv-help-section">
          <h3>Carrito</h3>
          <p>El carrito (icono 🛒) sirve para reunir un grupo de artículos y operar sobre todos ellos a la vez: aislarlos en el listado, mandarlos por email, hablar con la IA sobre el conjunto, o guardarlos como una selección con nombre para recuperarla más adelante. Es compartido con PrionPacks: lo que añades desde PrionVault también aparece en PrionPacks, y viceversa.</p>
          <p>Cada usuario tiene <strong>su propio carrito</strong>, y está disponible para <strong>todos los usuarios</strong>, no solo para administradores.</p>

          <h4>Botones de la parte superior del carrito</h4>
          <p>Son iconos discretos, todos del mismo tamaño — pasa el ratón por encima para ver qué hace cada uno:</p>
          <ul>
            <li><strong>🤖 Chat IA:</strong> abre una única conversación de IA que tiene en cuenta <strong>todos</strong> los artículos del carrito a la vez, útil para comparar o relacionar varios trabajos entre sí. Cada artículo del carrito queda igualmente registrado como si tuviera su propio chat, a efectos de las estadísticas de uso (ver la pestaña <em>"IA: chats y notas"</em>).</li>
            <li><strong>✉️ Enviar:</strong> envía todos los artículos del carrito en un único email, con los PDFs disponibles adjuntos — a diferencia de la opción "Acciones → Enviar por email", que solo manda un listado con enlaces sin adjuntar nada.</li>
            <li><strong>📦 Guardar</strong> y <strong>📂 Repositorio:</strong> ver "Repositorio de carritos" más abajo.</li>
            <li><strong>↗ Enviar carrito a…:</strong> copia los artículos de tu carrito al carrito de uno o varios usuarios que elijas en un modal. <strong>Tu carrito no cambia</strong>, y en el carrito de quien lo recibe solo se <strong>añaden</strong> artículos: nunca se borra nada de lo que ya tuviera.</li>
            <li><strong>Ver en listado:</strong> aísla el listado principal a exactamente los artículos que tienes en el carrito.</li>
            <li><strong>Ocultar:</strong> cierra el panel del carrito sin perder los artículos que ya habías añadido (igual que la ×).</li>
            <li><strong>Vaciar carrito:</strong> quita todos los artículos del carrito.</li>
          </ul>

          <h4>Cada artículo, dentro del carrito</h4>
          <p>Cada fila tiene, junto a sus datos, un botón <strong>📋</strong> que copia al portapapeles el título, los autores, la revista/año y el DOI/PMID en varias líneas separadas — pégalo directamente en un Word y queda ya formateado en párrafos, sin arreglar saltos de línea a mano — y un botón <strong>✉️</strong> para enviarlo por email individualmente (con PDF adjunto).</p>

          <h4>Selección y acciones en lote</h4>
          <p>Marca las casillas de los artículos que quieras y usa <strong>"Quitar no seleccionados"</strong> (el inverso de "Vaciar carrito") o el botón <strong>"Acciones"</strong>, que ofrece enviar por email (un artículo incluye su PDF; varios, un listado con enlaces) o mandarlos a PrionPacks para añadirlos a un paquete.</p>

          <h4>📦 Repositorio de carritos</h4>
          <p>Permite guardar el contenido actual del carrito como una selección con nombre y recuperarla más adelante:</p>
          <ul>
            <li><strong>📦 Guardar:</strong> archiva el contenido actual del carrito con el nombre que le pongas, junto con la fecha, en un repositorio propio.</li>
            <li><strong>📂 Repositorio:</strong> muestra la lista de carritos guardados (nombre, fecha y número de artículos), con un botón <strong>Recuperar</strong> por cada uno y una papelera para eliminarlo.</li>
            <li>Al recuperar un carrito guardado, su contenido <strong>sustituye por completo</strong> el del carrito actual — si el carrito actual no está vacío, se avisa antes de continuar.</li>
          </ul>
        </div>
      `,

      // ── IA: chats y notas ─────────────────────────────────────────────
      ia: `
        <div class="pv-help-section">
          <h3>Inteligencia artificial: chats y notas</h3>
          <p>PrionVault usa una cadena de proveedores de IA con reserva automática — <strong>Claude → GPT → Gemini</strong>: si el proveedor elegido no responde (corte de conexión, límite de uso…), se reintenta hasta 3 veces y, si sigue sin responder, se prueba con los otros dos configurados en orden, sin dar el proceso por fallido. Se guarda de cualquiera de los tres que responda, y queda registrado qué proveedor lo generó realmente. Esta cadena es la que usan los resúmenes, los chats de artículo, el chat general y las notas generadas por IA.</p>

          <h4>Chat de un artículo concreto</h4>
          <p>Desde la ficha de un artículo, "Preguntar a la IA sobre este artículo" abre un chat que recibe el artículo vectorizado y su resumen como contexto.</p>
          <ul>
            <li><strong>🧠 Recordar:</strong> pide a la IA que destile la conversación en una nota (3-5 párrafos breves, con las cifras/métodos/hallazgos concretos del chat, no una frase vaga de "me interesó X") pensada para reconocer y localizar ese artículo más adelante — un recordatorio técnico de <em>por qué</em> te interesó y qué aprendiste, terminando con una "Idea clave para futuras consultas". Se guarda automáticamente en <strong>Notas del artículo</strong>; si ya tienes las 5 notas ocupadas, se ofrece copiar el texto generado.</li>
            <li><strong>📄 Informe:</strong> abre un modal para elegir PDF o Word y, si quieres, enviarlo por email en vez de descargarlo. El documento se encabeza con los datos del artículo, cada pregunta como epígrafe seguida de su respuesta, y si el chat menciona otros artículos por DOI o PMID, termina con un apartado de <strong>Referencias</strong> enlazando a PrionVault (si está en la biblioteca), a su DOI y a su PMID.</li>
            <li><strong>"Chats anteriores"</strong> se pone en verde en cuanto abres el modal si el artículo ya tiene conversaciones previas.</li>
            <li>Tus preguntas y respuestas se indexan automáticamente para que el <strong>chat general</strong> también pueda encontrarlas — es <strong>privado</strong>: solo tú ves lo que preguntaste al buscar en el chat general. El botón <strong>"📊 Ver todos"</strong> (y un panel en <em>Salud biblioteca</em>) muestra en qué artículos se ha usado el chat y cuántos en total.</li>
          </ul>

          <h4>Chat de IA sobre todo el carrito a la vez</h4>
          <p>El botón <strong>🤖</strong> en la parte superior del carrito abre una única conversación de IA que tiene en cuenta <strong>todos</strong> los artículos del carrito a la vez — útil para comparar o relacionar varios trabajos. Cada artículo del carrito queda igualmente registrado como si tuviera su propio chat, a efectos de las estadísticas de uso.</p>

          <h4>Chat general</h4>
          <p>Busca por significado sobre el contenido vectorizado de toda la biblioteca y responde citando las referencias usadas — cada artículo tiene siempre un único número de cita, sin importar cuántos fragmentos aporte (abstract, extracto del PDF…). Da prioridad a las <strong>notas del investigador</strong> (Post-it) y a las <strong>conversaciones de chat de artículo</strong> sobre extractos de PDF más largos, y cada fragmento va etiquetado según su origen (Extracto del PDF, Resumen IA, Nota del investigador, Conversación previa).</p>
          <ul>
            <li>Cada pregunta tiene un botón 📄 (junto a 📌/🚀/🗑) que genera un <strong>informe de toda la conversación hasta ese punto</strong>, descargable en PDF (maquetado) o Word (texto seleccionable).</li>
            <li>Cada conversación se puede eliminar por completo (🗑, en la lista de chats de la barra lateral del propio chat).</li>
          </ul>

          <h4>🤖 Nota generada por IA a partir de un texto libre</h4>
          <p>Dentro del editor de <strong>Notas</strong> de un artículo, el botón <strong>"🤖 IA"</strong> abre un pequeño modal donde escribes lo que quieras apuntar — una idea, una cita, una pregunta, algo largo o cortísimo. La IA redacta con ello una nota corta centrada en <em>tu texto</em>, usando el artículo solo como apoyo secundario, pensada para servir de recordatorio: si luego preguntas "¿qué artículo hablaba de ###?", la nota debe ser fácil de encontrar por esas palabras clave. Se guarda automáticamente como una más de las 5 notas del artículo; si ya las tienes todas ocupadas, se ofrece copiar el texto generado.</p>

          <h4>Notas, chat con IA y compartir por email</h4>
          <p>Cada artículo admite <strong>notas de colores</strong> (hasta 5, manuales o generadas por IA) y un botón para <strong>enviarlo por email</strong> con previsualización, comentario de introducción, resumen opcional y el PDF adjunto.</p>

          <h4>Diagnóstico de un resumen IA</h4>
          <p>Cada vez que se genera un resumen queda guardado un pequeño diagnóstico técnico: qué proveedor respondió, si hubo reserva a otro proveedor, y el error exacto de cada intento fallido. En la ficha del artículo, junto a la línea "Modelo:", aparece un icono <strong>🛈</strong> cuando hay diagnóstico disponible — al pulsarlo se abre un modal con el detalle completo y un botón para copiarlo.</p>
        </div>
      `,

      // ── Sugerir referencias ───────────────────────────────────────────
      referencias: `
        <div class="pv-help-section">
          <h3>Sugerir referencias para un texto</h3>
          <p>El botón con unas <strong>comillas</strong>, junto al del chat general (🤖) en la barra de búsqueda, abre un modal en el que pegas un texto que estás escribiendo (una introducción, una discusión…) y PrionVault te propone, para cada frase que necesita una cita, qué artículos de la biblioteca la respaldan mejor y por qué.</p>

          <h4>Dos modos</h4>
          <ul>
            <li><strong>Con marcas "(Ref.)":</strong> tú indicas dónde va cada cita escribiendo una marca al final de la frase. Se reconocen muchas variantes: <code>(Ref.)</code>, <code>(Ref)</code>, <code>Ref.</code>, <code>REF</code>, <code>(Refs)</code>, <code>[ref]</code>…, con o sin paréntesis o corchetes. Cada marca es un punto numerado, y la búsqueda usa la frase justo anterior a la marca.</li>
            <li><strong>Automático (decide la IA):</strong> sin marcas. El texto se divide en frases (sin cortar en abreviaturas como "et al." o "Fig. 3") y la IA decide cuáles contienen una afirmación concreta que necesita cita (hasta 15).</li>
          </ul>

          <h4>Cómo elige las referencias</h4>
          <ul>
            <li>Para cada punto busca por significado y por términos en toda la biblioteca, igual que el chat general, y le pasa a la IA hasta 3 fragmentos de cada artículo candidato (abstract, extracto del PDF, tus notas y chats previos) y su resumen IA. Si una nota tuya indica que un artículo es la referencia original de algo, la IA lo tiene en cuenta.</li>
            <li>La IA puntúa cada candidato de <strong>0 a 100</strong> según cuánto respalda esa afirmación concreta y descarta los que no llegan a 40, sin forzar citas.</li>
            <li>Entre candidatos con puntuación parecida (dentro de bandas de 15 puntos) se prioriza la <strong>revista de mejor cuartil SCImago</strong> (Q1 antes que Q2…) y, después, el artículo <strong>más reciente</strong>.</li>
            <li>Usa los modelos grandes del chat (Claude, con GPT y Gemini de reserva) y respeta el glosario.</li>
          </ul>

          <h4>Los resultados</h4>
          <ul>
            <li>Cada punto muestra su frase (pasa el ratón por encima para ver el párrafo completo alrededor) y cuántos candidatos se analizaron de cuántos relacionados hay en PrionVault.</li>
            <li>Cada sugerencia es una tarjeta con título, autores, revista y año, su <strong>puntuación</strong> y su <strong>cuartil</strong>, enlaces a PDF, DOI y PMID, y la <strong>explicación</strong> de por qué encaja. Se muestran 5 por defecto; si hay más, aparece "Ver N más".</li>
            <li><strong>✓ Insertar aquí:</strong> puedes elegir <strong>una o varias</strong> referencias por punto. Encima del punto aparece la cita tal como quedará en el texto (siempre entre paréntesis, separadas por "; ", con el DOI o el PMID si no hay DOI) y un botón <strong>"Copiar cita"</strong> para pegarla sobre tu "Ref" en Word.</li>
            <li>La <strong>vista previa</strong> de arriba muestra el texto completo con las citas ya colocadas y se actualiza al instante (el botón de abajo a la derecha la amplía).</li>
            <li>El panel de <strong>estilo</strong> marca las citas insertadas en color, negrita, cursiva o subrayado (por defecto, rojo y texto normal). <strong>"Copiar texto con referencias"</strong> copia todo el texto con ese formato, listo para pegar en Word.</li>
          </ul>

          <h4>Si no encuentra nada</h4>
          <p>Te explica el motivo: si no se reconoció ninguna marca, si la IA no vio ninguna afirmación que necesite cita, si la búsqueda no encontró artículos relacionados con esa frase, o si los encontró pero ninguno la respalda de verdad (indicando cuáles se descartaron).</p>
        </div>
      `,

      // ── Roles ─────────────────────────────────────────────────────────
      roles: `
        <div class="pv-help-section">
          <h3>Roles de usuario</h3>
          <p>PrionVault distingue dos roles. El rol se asigna al crear el usuario y determina qué funciones están disponibles en la interfaz.</p>
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
            <div style="flex:1;min-width:220px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 16px;">
              <div style="font-weight:700;font-size:14px;color:#0F3460;margin-bottom:6px;">
                <i class="fas fa-shield-halved" style="margin-right:6px;"></i>Administrador
              </div>
              <p style="margin:0;font-size:13px;color:#1e40af;">Acceso completo: puede añadir, editar y eliminar artículos, gestionar PDFs, lanzar procesos de IA y ver todas las herramientas del menú lateral.</p>
            </div>
            <div style="flex:1;min-width:220px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px 16px;">
              <div style="font-weight:700;font-size:14px;color:#065f46;margin-bottom:6px;">
                <i class="fas fa-user" style="margin-right:6px;"></i>Lector
              </div>
              <p style="margin:0;font-size:13px;color:#065f46;">Acceso de consulta: puede explorar la biblioteca, organizar su lectura personal, crear entradas de Journal Club y recibir notificaciones.</p>
            </div>
          </div>

          <h4>Permisos adicionales, independientes del rol</h4>
          <ul>
            <li><strong>Responsable de Journal Club:</strong> recibe los avisos de JC, puede marcar artículos con el libro azul, Convocar sesiones y liberar o desbloquear reservas de artículos JC (en la tabla aparece como "parcial" para el lector: solo si tiene este permiso).</li>
            <li><strong>Administrador de usuarios de PrionVault:</strong> puede gestionar usuarios desde <em>Miscelánea → Administración</em> sin tener el resto del panel de administración (ver la pestaña Administración).</li>
          </ul>

          <h4>Tabla comparativa de capacidades</h4>
          <table class="pv-help-role-table">
            <thead>
              <tr>
                <th style="width:45%;">Función</th>
                <th style="width:27.5%;text-align:center;">
                  <span style="color:#0F3460;">⚙ Admin</span>
                </th>
                <th style="width:27.5%;text-align:center;">
                  <span style="color:#065f46;">👤 Lector</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Exploración y búsqueda</td></tr>
              <tr><td>Ver listado de artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Búsqueda de texto libre (IA semántica)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Filtros por año, autores, revista, tags, colección…</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Ver abstract, PDF y resumen IA</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Ver artículos similares</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Exportar referencias (Word)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Filtrar por asignación en PrionRead (👥)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Estado personal del artículo</td></tr>
              <tr><td>Marcar como favorito (♥)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Marcar como leído (✓)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Poner bandera (🚩)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Marcar como hito (★)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Asignar color y prioridad</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Valorar artículo (★ rating)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Carrito propio (🛒), guardarlo y enviarlo a otros usuarios</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Sugerir referencias para un texto (IA)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Selección masiva</td></tr>
              <tr><td>Usar checkboxes y barra de acciones</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Acciones masivas: bandera, favorito, leído, color, prioridad</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Acciones masivas: eliminar artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Acciones masivas: generar resúmenes IA</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Acciones masivas: tags, PrionPack, colección</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Colecciones y tags</td></tr>
              <tr><td>Ver colecciones y tags existentes</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Filtrar por colección o tag (ves los artículos que cualquiera haya etiquetado)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Crear / editar / eliminar colecciones y tags</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Journal Club</td></tr>
              <tr><td>Ver presentaciones JC de todos ("Gestión de Journal clubs")</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Reservar un artículo del libro azul para presentarlo</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Liberar o desbloquear una reserva, Convocar sesión</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${PART}</td></tr>
              <tr><td>Crear nuevas entradas JC</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Adjuntar archivos (PPTX, PDF…) a sus propias entradas</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Editar o eliminar entradas propias</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Editar o eliminar entradas de otros usuarios</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Notificaciones</td></tr>
              <tr><td>Configurar suscripciones de email propias</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>
              <tr><td>Recibir PrionVault Picks (artículos con bandera)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${YES}</td></tr>

              <tr><td colspan="3" style="background:#f9fafb;font-weight:700;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 12px;">Gestión de contenido (solo admin)</td></tr>
              <tr><td>Añadir artículos (DOI, PMID, PDF, búsqueda PubMed…)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Editar metadatos de artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Eliminar artículos</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Subir y gestionar PDFs</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Abrir artículo en PrionRead admin ↗</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Búsqueda masiva por DOI / PMID</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Generar resúmenes IA, indexación vectorial</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Gestionar PrionPacks</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Ver Salud biblioteca (métricas del corpus)</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
              <tr><td>Encontrar duplicados, verificar PDFs, Estado IA</td><td style="text-align:center;">${YES}</td><td style="text-align:center;">${NO}</td></tr>
            </tbody>
          </table>
        </div>
      `,

      // ── Búsqueda ──────────────────────────────────────────────────────
      busqueda: `
        <div class="pv-help-section">
          <h3>Búsqueda y filtros</h3>
          <h4>Barra de búsqueda</h4>
          <p>La búsqueda de texto y la búsqueda con IA ahora están separadas — cada una en su propio campo, para que no compartan comportamiento por error:</p>
          <ul>
            <li><strong>🔤 Búsqueda estándar</strong> (la barra de siempre): por título, autores y abstract. Admite los operadores de PostgreSQL (<code>"frase exacta"</code>, <code>BSE -review</code>, <code>Castilla OR Soto</code>) y, para varias palabras sueltas, los botones <strong>AND / OR</strong> dentro del propio campo controlan si deben coincidir todas (AND, por defecto) o basta con una (OR).</li>
            <li><strong>⚡ Título exacto entre comillas:</strong> si sabes el título de un artículo, pégalo <strong>entre comillas</strong> (<code>"Prions activate a p38 MAPK synaptotoxic signaling pathway"</code>) y PrionVault lo busca directamente en los títulos con un índice propio: responde al instante tanto si está como si no. Da igual que haya diferencias de mayúsculas, espacios, guiones o signos de puntuación, y también sirve con solo una parte del título. Mientras la comilla está abierta (la estás escribiendo) no se lanza la búsqueda; empieza al cerrarla. Las búsquedas largas <em>sin</em> comillas también son ahora más rápidas.</li>
            <li><strong>🤖 Búsqueda con IA</strong> (icono de robot, a la derecha de la barra): abre un modal aparte con un campo de texto grande para escribir la pregunta en lenguaje natural y elegir el modelo — Claude Sonnet 4.6, GPT-4.1 o Gemini 2.5 Pro, por nombre — antes de lanzarla. Busca por significado sobre el contenido vectorizado de la biblioteca y responde citando las referencias usadas.</li>
            <li><strong>🔍 Búsqueda bibliográfica:</strong> consulta PubMed y Scopus en tiempo real. Los resultados se pueden importar directamente a la biblioteca.</li>
          </ul>
          <h4>Filtros del panel lateral</h4>
          <p>Filtra por año, autores, revista, colección, tag, estado PDF, estado resumen IA, bandera, hito, favorito, leído, color, prioridad, Journal Club, PrionPack y asignación PrionRead. Los filtros se combinan (AND). El contador "📝 Con notas" del menú lateral cuenta tus propias notas Post-it (no resúmenes IA) y filtra el listado a los artículos que las tienen.</p>
          <p><strong>Tags compartidas al consultar:</strong> el número de artículos de cada tag y el listado que aparece al pulsarla incluyen los artículos que <strong>cualquier usuario</strong> haya etiquetado, no solo los tuyos. Poner o quitar una tag a un artículo sigue siendo personal: solo puedes quitar las que pusiste tú.</p>
          <h4>Búsqueda masiva por DOI / PMID <span class="pv-help-chip pv-help-chip-admin">Solo admin</span></h4>
          <p>Pega varios DOIs o PMIDs separados por comas o saltos de línea en el campo de la barra de herramientas para encontrar de golpe qué artículos ya están en la biblioteca y cuáles faltan.</p>

          <h4>Acciones rápidas en el listado</h4>
          <ul>
            <li><strong>📍 Aislar un artículo:</strong> el icono de cada fila (y del modal de detalle) filtra el listado para mostrar <strong>solo ese artículo</strong>, sin perder el resto de filtros activos. Aparece un indicador visual con botón para quitar el aislamiento.</li>
            <li><strong>⬇ Descarga directa de PDF:</strong> justo antes del icono 📍, un botón (solo si el artículo tiene PDF) lo descarga directamente al disco — a diferencia del enlace "PDF", que lo abre en el visor del navegador.</li>
            <li><strong>🚫📄 Seleccionar los artículos sin PDF:</strong> junto a los iconos 📝 (notas) y 🛒 (carrito), en la parte superior del listado, selecciona de un clic <strong>todos los artículos de la biblioteca que no tienen PDF</strong> — sin importar los filtros puestos en ese momento — y activa la barra de acciones en lote sobre esa selección.</li>
            <li><strong>📋 Copiar DOI y PMID:</strong> en el modal de detalle, junto al DOI y al PMID hay un pequeño botón en superíndice que copia el identificador al portapapeles.</li>
            <li><strong>🔓 Buscar PDF</strong> <span class="pv-help-chip pv-help-chip-admin">Solo admin</span>: en los artículos sin PDF (en la fila del listado y en la ficha), busca una versión legal de acceso abierto en <strong>Unpaywall</strong> y luego en <strong>OpenAlex</strong>; si la encuentra, la descarga y la asocia al artículo. Si no, prepara un email en inglés para pedírsela al autor de correspondencia (con su dirección si se puede localizar y tu firma), un enlace para buscarlo en ResearchGate, y un botón <em>"Indicar que se ha solicitado"</em>: el icono pasa a 🔓✓ para que nadie lo vuelva a pedir.</li>
            <li><strong>✉️ Enviar por email — "Marcar como leído":</strong> el modal "Enviar artículo por email" tiene esta casilla, activada por defecto: al enviarlo, el artículo queda con tu tic verde de leído. Si lo <em>programas</em>, se marca cuando el email sale de verdad.</li>
          </ul>

          <h4>Tags y colecciones inteligentes</h4>
          <p>Además de las tags y colecciones normales, existen versiones <strong>inteligentes</strong> (icono de rayo ⚡ para las tags): se asignan solas a los artículos que cumplen unos criterios que tú defines (autores, revista, años, si tiene PDF/DOI/PMID, si tiene resumen IA, fuente, y una búsqueda libre — ver más abajo). A diferencia de las colecciones, las tags inteligentes se materializan de verdad (se guardan como si las hubieras puesto a mano) porque se muestran en cada fila del listado — se re-sincronizan automáticamente cada 20 minutos, o al momento con el botón de resincronizar. Créalas con el botón ⚡ junto a "+ Tags" en el menú lateral.</p>
          <p>Cada colección del menú lateral tiene un icono 🗑 junto a ✏ y 📦 para eliminarla directamente; para borrar un grupo entero, pasa el ratón por su cabecera y aparece una ✕.</p>

          <h4>Búsqueda booleana estilo PubMed en tags y colecciones inteligentes</h4>
          <p>El campo "Búsqueda libre" al crear/editar un <strong>tag inteligente</strong> o una <strong>colección inteligente</strong> acepta una búsqueda booleana completa, no solo palabras sueltas:</p>
          <ul>
            <li><strong>AND</strong> — exige que aparezcan ambos lados. <code>miRNA AND AAV</code> solo encuentra artículos que mencionen las dos cosas.</li>
            <li><strong>OR</strong> — basta con que aparezca uno de los dos. <code>PrPSc OR PrPres</code> encuentra cualquiera de las dos formas.</li>
            <li><strong>NOT</strong> — excluye lo que sigue. <code>prion NOT yeast</code> descarta los artículos que mencionen "yeast".</li>
            <li><strong>Paréntesis <code>( )</code></strong> — agrupan una parte de la búsqueda para que se evalúe junta, igual que en matemáticas. Se evalúa <em>de izquierda a derecha</em> (como en PubMed real): sin paréntesis, <code>A OR B AND C</code> se lee como <code>(A OR B) AND C</code>; con paréntesis puedes forzar cualquier otro orden.</li>
            <li><strong>Corchetes de campo</strong> — <code>[Ti]</code> (título), <code>[Ab]</code> (abstract), <code>[Au]</code> (autores) o <code>[Ja]</code> (revista), justo pegados después de una palabra, limitan esa palabra a ese campo concreto. Sin corchetes, la palabra se busca en título + abstract + autores a la vez.</li>
            <li><strong>Comillas</strong> — <code>"bat"</code> exige la palabra exacta (ni "combat" ni "battle"); sin comillas es una coincidencia parcial (substring).</li>
          </ul>
          <p>Ejemplo completo: <code>Castilla [Ti] OR Desojo [Ti] AND (avión [Ab] OR casa [Ab])</code> — encuentra artículos donde el título contenga "Castilla" o "Desojo", <em>y además</em> el abstract contenga "avión" o "casa". Un error de sintaxis (paréntesis sin cerrar, campo desconocido…) se avisa al guardar, con el motivo exacto. El propio formulario de reglas muestra esta misma explicación siempre visible, no solo al pasar el ratón por el icono ⓘ.</p>
        </div>
      `,

      // ── Notificaciones ────────────────────────────────────────────────
      notificaciones: `
        <div class="pv-help-section">
          <h3>Notificaciones por email</h3>
          <p>Accede desde <strong>Miscelánea → 🔔 Notificaciones</strong>. Puedes crear y gestionar tantas suscripciones como quieras, cada una con su propia configuración.</p>

          <h4>Tipos de suscripción</h4>
          <ul>
            <li><strong>PrionVault Picks:</strong> recopila los artículos de tu biblioteca que tengan bandera 🚩 activa en el período seleccionado (semana, quincena, mes…) y los envía en un digest estructurado. Una vez enviados, a esos artículos se les quita la bandera y se marcan como <strong>leídos</strong> (✓ verde).</li>
            <li><strong>PubMed Digest:</strong> busca artículos nuevos en PubMed según los temas que configures y te los envía periódicamente.</li>
          </ul>

          <h4>Opciones de configuración</h4>
          <ul>
            <li><strong>Nombre:</strong> identifica la suscripción (aparece en el asunto del email).</li>
            <li><strong>Email destinatario:</strong> puede ser diferente al de tu cuenta.</li>
            <li><strong>Frecuencia:</strong> diaria, semanal, quincenal o mensual.</li>
            <li><strong>Días de la semana:</strong> en frecuencia semanal, elige qué día llega el email.</li>
            <li><strong>Hora de envío y zona horaria:</strong> el digest se genera y envía a la hora local que indiques.</li>
            <li><strong>Período de búsqueda:</strong> cuántos días atrás mira el sistema para recopilar artículos (1–90 días).</li>
            <li><strong>Artículos por email:</strong> límite máximo de artículos incluidos en cada envío.</li>
            <li><strong>Solo Open Access:</strong> para el digest de PubMed, filtra únicamente artículos con acceso libre.</li>
            <li><strong>Incluir PDFs adjuntos:</strong> si el artículo tiene PDF almacenado en Dropbox, lo adjunta al email. Activado por defecto. Puede desactivarse si prefieres emails más ligeros.</li>
          </ul>

          <h4>Activar / desactivar</h4>
          <p>Cada suscripción tiene un interruptor que la activa o pausa sin necesidad de eliminarla. Los digests solo se envían si hay artículos que cumplan los criterios; si no hay nada nuevo, el email no se manda.</p>
        </div>
      `,

      // ── Salud biblioteca ──────────────────────────────────────────────
      salud: `
        <div class="pv-help-section">
          <h3>Salud de la biblioteca <span class="pv-help-chip pv-help-chip-admin">Solo admin</span></h3>
          <p>Abre desde el botón <strong>❤️ Salud biblioteca</strong> en la parte inferior del menú lateral. Ofrece un diagnóstico completo del estado del corpus.</p>

          <h4>Panel principal — métricas globales</h4>
          <ul>
            <li><strong>Artículos totales, con PDF, sin PDF:</strong> cuántos artículos tiene la biblioteca y qué proporción tiene PDF asociado.</li>
            <li><strong>Extracción de texto:</strong> artículos cuyo PDF ha sido procesado para poder buscar dentro de él (OCR incluido para escaneados).</li>
            <li><strong>Resúmenes IA:</strong> artículos con resumen generado por IA vs. pendientes.</li>
            <li><strong>Indexación vectorial:</strong> artículos disponibles para búsqueda semántica.</li>
            <li><strong>Journal Club:</strong> artículos presentados en sesiones JC.</li>
            <li><strong>Con DOI / con PMID:</strong> cobertura de identificadores para enlazar con bases de datos externas.</li>
          </ul>
          <p>Cada número es un botón clickable: al pulsarlo se cierra el modal y el listado muestra exactamente esos artículos.</p>

          <h4>🗂 Completitud de metadatos</h4>
          <p>Pulsa el botón <em>"🗂 Completitud de metadatos →"</em> para ver un sub-panel con el recuento de artículos que tienen vacíos los campos más importantes:</p>
          <ul>
            <li>Título · Autores · Revista · Año · Abstract · DOI · PMID</li>
          </ul>
          <p>Al igual que las métricas principales, cada contador es clickable y filtra el listado para que puedas completar esos campos de forma sistemática usando el editor de metadatos.</p>
          <p>Vuelve al panel principal con el botón <em>"← Atrás"</em>.</p>
        </div>
      `,

      // ── Journal Club ──────────────────────────────────────────────────
      jc: `
        <div class="pv-help-section">
          <h3>Journal Club (JC)</h3>
          <p>El módulo de Journal Club permite registrar las sesiones en las que se presenta y discute un artículo, con historial de presentadores, fechas y materiales adjuntos.</p>

          <h4>📋 El procedimiento completo, paso a paso</h4>
          <p>Desde que un artículo se propone para Journal Club hasta que la presentación queda archivada hay cinco fases. Cada una tiene su botón y <strong>no hace falta escribir ningún email a mano</strong>.</p>

          <p><strong>Fase 1 — Proponer artículos candidatos (el libro azul 📖)</strong></p>
          <ul>
            <li>Marcar o desmarcar un artículo como candidato a Journal Club (el libro 📖 de la fila o de la ficha) lo pueden hacer el <strong>administrador</strong> y el <strong>responsable de Journal Club</strong>. El libro azul significa que el artículo está <strong>en el circuito de Journal Club</strong>: disponible para que alguien lo presente o ya reservado (lo distingue el color del botón JC).</li>
            <li>Si no eres admin ni responsable y quieres proponer uno, pulsa su botón <strong>"JC"</strong> gris y elige <strong>"Informar al responsable"</strong>: le llega un email personal ("Hola, [su nombre]") al responsable de Journal Club y a cada administrador, con el artículo y el PDF, pidiéndoles que lo valoren. Al final del email hay un botón morado <strong>📖 Aceptar para Journal Club</strong>: quien lo pulse (solo funciona para el responsable de JC y los administradores) confirma en una página y el artículo queda marcado con el libro azul. Para rechazarlo no hace falta hacer nada.</li>
            <li>Si el artículo aún no está en PrionVault, envíalo a <code>prionvault_lab@joaquincastilla.com</code> con el PDF y <strong>"JC"</strong> o <strong>"Journal Club"</strong> en el Asunto: se procesa y queda marcado como candidato automáticamente.</li>
          </ul>

          <p><strong>Fase 2 — Elegir el artículo que vas a presentar (reserva)</strong></p>
          <ul>
            <li>Filtra por el libro azul y pulsa el botón <strong>"JC"</strong> (azul claro) del artículo que te interese.</li>
            <li>Primero se te pregunta <strong>"¿Eres [tu nombre]?"</strong>. Solo si confirmas, se muestran todos los datos del artículo (título, autores, revista, enlaces y abstract) y la pregunta <strong>"¿Quieres presentar este artículo en Journal Club?"</strong>.</li>
            <li>Al aceptar, el artículo queda <strong>reservado para ti</strong>: conserva el libro azul (sigue en el circuito de Journal Club), su botón JC pasa a <strong>rojo con candado 🔒</strong> y nadie más puede cogerlo. Si dos personas lo pulsan a la vez, solo una lo consigue.</li>
            <li>Al <strong>responsable de Journal Club</strong> le llega un email (con los administradores en copia, el artículo y su PDF) diciendo quién lo va a presentar, para que le avise de la fecha.</li>
            <li>Si otra persona pulsa ese botón rojo, ve para quién está reservado.</li>
          </ul>

          <p><strong>Fase 3 — Convocar la sesión (fecha, hora, lugar)</strong></p>
          <ul>
            <li>El botón <strong>"📢 Convocar"</strong> está en la sección Journal Club de la ficha, al lado del distintivo <em>"En Journal Club"</em> de la ficha y, como icono 📢, junto al libro de cada fila del listado. Aparece en los artículos candidatos o reservados que aún no tienen presentación, y solo lo ven el <strong>administrador</strong> y el <strong>responsable de Journal Club</strong>.</li>
            <li>El formulario pide <strong>Cuándo</strong> (fecha y hora con calendario), <strong>Dónde</strong> (por defecto "Sala de seminarios") y <strong>Notas</strong>. Con <strong>"Programar envío"</strong> puedes dejarlo preparado para que salga en otro momento; si lo dejas vacío se envía al instante.</li>
            <li>El email llega a <strong>todos los usuarios activos</strong>, con el artículo, el PDF y quién presenta.</li>
            <li><strong>Enviar la convocatoria desbloquea la reserva:</strong> el botón JC sigue en rojo pero sin candado, y el presentador ya puede subir su presentación. Si se programó, se desbloquea cuando el email sale.</li>
          </ul>

          <p><strong>Fase 4 — Celebrar la sesión</strong> (fuera de la aplicación).</p>

          <p><strong>Fase 5 — Subir la presentación</strong></p>
          <ul>
            <li>El presentador pulsa el botón JC rojo (ya sin candado) y se abre directamente el modal para subir la presentación (PowerPoint, PDF, etc.). La fecha se toma del nombre del archivo si sigue el formato <code>yyyymmdd</code>.</li>
            <li>Con la presentación subida, el botón pasa a <strong>verde</strong>. Al pulsarlo se abre <em>"Gestión de Journal clubs"</em> con ese artículo ya buscado, para abrir el documento.</li>
          </ul>

          <p><strong>Liberar o desbloquear una reserva</strong><br>
          Solo el <strong>responsable de Journal Club</strong> o un <strong>administrador</strong>, pulsando el botón rojo del artículo: <em>Liberar</em> (queda disponible otra vez), <em>Desbloquear</em> (deja subir la presentación sin esperar a la convocatoria) o <em>Subir presentación</em> ellos mismos.</p>

          <p><strong>Quién es "el responsable de Journal Club" y cómo se asigna</strong><br>
          Se marca desde <strong>Panel de administración → Users → Editar</strong> (casilla <em>"Journal Club responsible"</em>) o desde <strong>Miscelánea → Administración</strong> en PrionVault (casilla <em>"Responsable de Journal Club"</em>; en el listado de usuarios aparece con 📖). Puede haber más de una persona: los avisos les llegan a todas y todas pueden convocar, liberar y desbloquear.</p>

          <h4>Quién puede hacer qué</h4>
          <ul>
            <li><strong>Cualquier usuario (admin y lector)</strong> puede crear una nueva entrada JC para cualquier artículo de la biblioteca.</li>
            <li>El creador puede editar y eliminar sus propias entradas en cualquier momento.</li>
            <li>El administrador puede editar y eliminar las entradas de cualquier usuario.</li>
            <li>Todos pueden ver el historial completo de sesiones JC.</li>
          </ul>

          <h4>Archivos adjuntos</h4>
          <p>Puedes adjuntar uno o varios archivos a cada entrada JC (presentaciones PPTX, PDFs complementarios, notas…). Los archivos se almacenan en Dropbox y están disponibles para todos los usuarios. El creador de la entrada y el administrador pueden añadir o eliminar adjuntos, incluso uno por uno (✕ junto a cada fichero, sin tener que borrar toda la presentación).</p>

          <h4>Gestión de Journal clubs — el modal grande</h4>
          <p>El enlace <em>"Gestión de Journal clubs"</em> del menú lateral (antes "Añadir Journal clubs") está disponible para <strong>todos los usuarios</strong>, no solo para administradores, y abre un modal con tres partes:</p>
          <ul>
            <li><strong>Listado completo</strong> de todas las presentaciones registradas, con buscador instantáneo por artículo, responsable o año. El botón <strong>OR</strong> junto al buscador cambia el criterio de "todas las palabras deben coincidir" a "basta con que coincida una". Las columnas "Fecha" y "Responsable" se ordenan pulsando su cabecera. Cada fila enlaza directamente al PDF del artículo (si lo tiene) y a su DOI/PMID.</li>
            <li><strong>"Añadir nuevo JC"</strong> abre el mismo buscador de artículo de siempre (con la importación masiva, ver más abajo).</li>
            <li><strong>"Generar informe"</strong> descarga un PDF con todo el historial, agrupado a elegir entre Año→Responsable o Responsable→Año, para todo o restringido a un año o responsable concreto.</li>
          </ul>

          <h4>Los colores del botón "JC"</h4>
          <p>El botón "JC" aparece siempre en cada fila del listado (y en el carrito). Su color indica el estado:</p>
          <ul>
            <li><strong>Gris:</strong> el artículo no es candidato ni tiene presentación. Al pulsarlo puedes pedir al responsable que lo valore o añadir una presentación.</li>
            <li><strong>Azul claro:</strong> candidato disponible (libro azul). Al pulsarlo empieza la reserva para presentarlo tú.</li>
            <li><strong>Rojo con 🔒:</strong> reservado y bloqueado hasta que se convoque la sesión.</li>
            <li><strong>Rojo sin candado:</strong> reservado y con la sesión ya anunciada; su presentador puede subir la presentación.</li>
            <li><strong>Verde oscuro con letra amarilla:</strong> ya tiene presentación. Al pulsarlo se abre "Gestión de Journal clubs" con ese artículo buscado.</li>
          </ul>

          <h4>Ver los documentos adjuntos</h4>
          <p>Al pulsar sobre un archivo adjunto se abre en una pestaña nueva, siempre <strong>dentro del navegador</strong>, nunca como descarga:</p>
          <ul>
            <li><strong>PDF e imágenes:</strong> se muestran directamente.</li>
            <li><strong>PowerPoint / Word / Excel:</strong> se abren con el visor oficial de <strong>Microsoft Office Online</strong>, con fidelidad completa — animaciones, transiciones y modo presentador incluidos, sin conversión ni espera. Si el visor de Microsoft no está disponible (Dropbox no configurado, o un formato que no soporta como Keynote), cae de vuelta a una conversión a PDF hecha en el servidor la primera vez que se abre el archivo (las siguientes son instantáneas).</li>
          </ul>

          <h4>Aviso de presentación ya existente</h4>
          <p>Al pulsar "Añadir presentación" para un artículo que ya tenía una entrada de JC (de otro responsable, o del mismo en otra fecha), aparece un aviso amarillo indicando quién la presentó. No bloquea nada: tú decides si continuar (se crea una presentación adicional) o cerrar el modal y usar el 📎 de la presentación existente para sumar el archivo ahí en su lugar.</p>

          <h4>Importación masiva desde una carpeta de Dropbox</h4>
          <p>Si ya tenías muchas presentaciones antiguas guardadas a mano en Dropbox, no hace falta subirlas una a una. Desde <em>"Gestión de Journal clubs"</em> → <em>"Añadir nuevo JC"</em> se abre el modal de búsqueda de artículo, que incluye la opción <strong>"Importar carpeta completa de un responsable"</strong>:</p>
          <ul>
            <li>Espera que los archivos estén organizados como <code>PrionLab tools/Journal clubs/&lt;Responsable&gt;/&lt;yyyymmdd&gt;/</code>, con el PDF del artículo nombrado <code>Article ....pdf</code> (usado solo para identificar de qué artículo se trata) junto al documento de la sesión (p. ej. <code>JC yyyymmdd.pptx</code>).</li>
            <li>Escribe el nombre del responsable tal cual aparece la carpeta en Dropbox y pulsa "Importar". El proceso corre en segundo plano (puede tardar varios minutos si hay muchas carpetas) mostrando el progreso en vivo.</li>
            <li>Al terminar, un informe indica: cuántas presentaciones se crearon, cuántas ya existían, cuántos archivos se adjuntaron, un listado desplegable de <strong>lo que se importó bien</strong> (carpeta → artículo), y las carpetas cuyo artículo <strong>no se pudo identificar</strong> (con la ruta exacta, para revisarlas a mano) o que dieron algún error.</li>
            <li>Se puede repetir sin miedo: si vuelves a lanzarlo (por ejemplo, tras añadir carpetas nuevas), no duplica lo que ya se había importado.</li>
          </ul>

          <h4>Orden y localización</h4>
          <p>En la ficha del artículo, junto al título "JOURNAL CLUB", el botón <strong>"Fecha"</strong> invierte el orden de las presentaciones entre más antigua→más reciente y al revés. El botón "JC" del listado principal muestra en su texto emergente quién presentó el artículo (no solo que fue presentado).</p>

          <h4>Acceso</h4>
          <p>Las entradas JC aparecen en el panel lateral del artículo, en la sección <em>"Journal Club"</em>. También puedes filtrar el listado principal para ver solo artículos con presentaciones JC usando el filtro correspondiente en el menú lateral.</p>
        </div>
      `,

      // ── Administración ────────────────────────────────────────────────
      administracion: `
        <div class="pv-help-section">
          <h3>Administración <span class="pv-help-chip pv-help-chip-admin">Mayormente admin</span></h3>

          <h4>Añadir artículos</h4>
          <ul>
            <li><strong>📧 Email sin ser admin:</strong> el buzón <strong>prionvault_lab@joaquincastilla.com</strong> permite a cualquier usuario mandar un email con el PDF adjunto y que PrionVault lo procese igual que si se subiera desde la app — comprobación de duplicados, extracción de metadatos, resumen IA incluido. Solo funciona escribiendo desde <strong>el email con el que inicias sesión</strong> en la aplicación; cualquier otra dirección se ignora. Al terminar llega la respuesta con el resultado, con el administrador en copia oculta. Truco: si el <strong>Asunto</strong> incluye "JC" o "Journal Club", el artículo se marca automáticamente como candidato a Journal Club al terminar de procesarse.</li>
            <li><strong>🧩 Extensión del navegador:</strong> disponible para cualquier usuario, admin o no. Al añadir un artículo con PDF desde la extensión, pasa por el mismo procesamiento completo (extracción, metadatos, resumen IA) que un email a prionvault@ o prionvault_lab@; si quien la usa no es admin, el administrador recibe un aviso por email cuando termina, sin identificar a quién lo añadió. El administrador puede ver ambas claves de la extensión (admin y usuarios), descargar el <code>.zip</code> de instalación y enviarle a cualquier usuario un email con las instrucciones, su clave y la extensión adjunta, todo desde <strong>Panel de administración → System</strong>.</li>
            <li><strong>📥 Importar BibTeX (.bib):</strong> en <em>Entrada de artículos</em>. Sube un archivo <code>.bib</code> (Zotero, EndNote, Google Scholar, o exportado del propio PrionVault) y cada entrada se compara con la biblioteca por DOI, luego PMID y por último título — las que ya están permiten añadir tag/colección en lote; las que no se encuentran abren el flujo habitual de "Add by DOI / PMID" con navegación Anterior/Siguiente.</li>
            <li><strong>🔗 Cribar lista de referencias:</strong> además de bibliografías clásicas ("1. Autor..."), reconoce listados exportados de un chatbot o de un panel de "Fuentes", con marcadores <code>[1] [3] [8] ...</code> al principio de línea seguidos del enlace, extrae el PMID directamente de un enlace <code>pubmed.ncbi.nlm.nih.gov/&lt;pmid&gt;/</code>, y corta correctamente el DOI cuando viene incrustado en la URL de una revista. Además del botón "Importar todos los que faltan", puedes marcar con casilla los artículos concretos que no están en PrionVault y pulsar <strong>"📋 Copiar DOIs seleccionados"</strong> para copiarlos uno por línea sin importarlos de golpe (los artículos sin DOI se omiten de la copia).</li>
          </ul>

          <h4>Resúmenes IA</h4>
          <p>Al pulsar un número preestablecido (p. ej. "100") en el modal de <strong>Resumen IA</strong> sin seleccionar artículos concretos, se procesan los <strong>últimos artículos añadidos a la biblioteca</strong> que aún no tienen resumen, empezando por los más recientes en darse de alta.</p>

          <h4>Exportar referencias</h4>
          <p>Desde el modal <strong>Exportar referencias</strong>, el botón <em>"Formato Gobierno Vasco"</em> genera el .docx con el formato exacto de la justificación (Authors / Title / Name of journal / Volume / páginas / Year / Quality indicators), con opciones para las <strong>etiquetas</strong> de los campos (en español, en azul y/o en negrita). Los indicadores de calidad (cuartil, decil, percentil, ISSN y país) se rellenan solos a partir de los rankings de <strong>SCImago (SJR)</strong>, cargados por años desde <strong>Miscelánea → SCImago (SJR)</strong>; se elige siempre el mejor cuartil/decil. El resto de ajustes de formato del modal no afectan al formato Gobierno Vasco, que es fijo.</p>
          <p>En el modal de SCImago puedes guardar a mano revistas que SCImago no cubre. Cada entrada lleva un <strong>Año</strong>: déjalo vacío para «todos los años» o indica uno concreto — las revistas guardadas tienen prioridad sobre SCImago (primero el año exacto, luego «todos los años», y en su defecto SCImago).</p>

          <h4>Glosario</h4>
          <p>El botón <strong>Glosario</strong> de la barra lateral abre un modal dentro de PrionVault (buscar, filtrar por categoría, añadir, editar en línea, importar/exportar .tsv), con el mismo contenido que la página independiente <code>/prionvault/admin/glossary</code> — esta se mantiene por si otras herramientas del laboratorio (PrionLab, PrionPacks) enlazan directamente a ella. Es la terminología EN→ES que usan todos los resúmenes IA y chats.</p>

          <h4>👥 Miscelánea → Administración (usuarios, sin salir de PrionVault)</h4>
          <p>Permite gestionar usuarios desde PrionVault: crearlos, editar nombre, email e idioma, activarlos o desactivarlos, resetear su contraseña y marcar dos permisos:</p>
          <ul>
            <li><strong>Administrador de usuarios de PrionVault:</strong> da acceso a este mismo panel a alguien que no es administrador general, sin darle el resto del panel de administración de PrionLab (backups, base de datos, otras herramientas). Es independiente del rol general.</li>
            <li><strong>Responsable de Journal Club</strong> (📖 en el listado de usuarios): ver la pestaña Journal Club.</li>
          </ul>
          <p>Por seguridad, quien solo tiene el permiso de PrionVault <strong>no puede</strong> tocar cuentas de administradores generales, cambiar el rol general de nadie (los usuarios que crea son siempre lectores) ni desactivarse a sí mismo. Eliminar usuarios sigue siendo solo desde el panel de administración de PrionLab.</p>

          <h4>👁 Ver como <span class="pv-help-chip pv-help-chip-admin">Solo admin</span></h4>
          <p>Desde <strong>Miscelánea → 👁 Ver como</strong> (o desde el panel de administración de PrionLab) eliges un usuario no administrador y entras con su sesión completa para ver PrionVault exactamente como lo ve él. Una franja fija arriba indica que estás viéndolo como otra persona, con el botón <strong>Salir</strong> para volver a tu sesión, en la misma página donde estabas. Todo lo que hagas mientras tanto lo hace esa cuenta, y queda registrado quién lo usó y cuándo.</p>

          <h4>Copias de seguridad (Backups)</h4>
          <p>Panel de <strong>Backups</strong> accesible desde el menú lateral: crea copias de seguridad de la base de datos bajo demanda o consulta las programadas automáticamente, verifica su integridad, ajusta la frecuencia y restaura una copia si hace falta. La lista muestra las copias guardadas en <strong>Dropbox</strong>: si al crear una copia aparece un aviso ⚠ de que no se pudo subir a Dropbox (por ejemplo, por falta de espacio), la copia se ha hecho solo en el servidor y por eso no aparece en la lista.</p>
          <p><strong>Control de las copias:</strong> arriba del panel, un recuadro verde, ámbar o rojo indica si las copias se están haciendo bien: fecha de la última copia correcta, frecuencia, próxima copia programada, los problemas detectados y el historial de intentos (programadas, manuales y de recuperación, con su resultado y tamaño). El sistema lo vigila cada hora: si falta una copia (por ejemplo, porque la aplicación se estaba reiniciando a la hora programada) la hace sola, y si una copia falla, no llega a Dropbox o es mucho más pequeña que la anterior, se avisa por email a los administradores. Si hay un problema, aparece además un punto rojo o ámbar junto al botón <strong>Backups</strong> del menú lateral.</p>

          <h4>Exportar esta Ayuda</h4>
          <p>En la cabecera de este modal, los botones <strong>PDF</strong> y <strong>PPTX</strong> descargan toda esta guía — el PDF con el mismo texto e imágenes que ves aquí, y el PPTX como una presentación de diapositivas (portada, una diapositiva divisoria por pestaña y una por cada apartado, con tablas nativas). Ambos se generan a partir del contenido que ves en cada pestaña, así que siempre están al día.</p>

          <h4>Seguridad</h4>
          <ul>
            <li>Límite de intentos de login (10/min, 50/hora) para proteger contra fuerza bruta.</li>
            <li>Cabeceras HTTP de seguridad: <code>X-Frame-Options</code>, <code>X-Content-Type-Options</code>, CSP, Referrer-Policy.</li>
            <li>Clave de sesión configurable vía <code>APP_SECRET_KEY</code> independiente de la contraseña de admin.</li>
            <li>Rate limiting en endpoints de búsqueda DOI/PMID.</li>
          </ul>
        </div>
      `,
    };

    return html;
  }

  function _helpRenderTab(tab) {
    const body = document.getElementById('pv-help-body');
    if (!body) return;
    const html = _helpTabsHtml();
    body.innerHTML = html[tab] || `<p style="color:#9ca3af;">Sección no encontrada.</p>`;
  }


})();
