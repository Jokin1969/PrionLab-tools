import logging
from flask import jsonify, render_template, request, session

from core.decorators import login_required
from tools.help import help_bp

logger = logging.getLogger(__name__)

# ── Bilingual built-in help content ──────────────────────────────────────────

_BUILTIN_ARTICLES = {
    'dashboard-overview': {
        'title_es': 'Visión general del Panel Principal',
        'title_en': 'Dashboard Overview',
        'excerpt_es': 'Aprende a navegar y usar el panel principal de PrionLab Tools.',
        'excerpt_en': 'Learn to navigate and use the main PrionLab Tools dashboard.',
        'content_es': (
            'El **Panel Principal** es tu punto de partida en PrionLab Tools.\n\n'
            'Desde aquí puedes acceder a todos tus manuscritos, ver métricas de actividad reciente '
            'y navegar a cualquier herramienta.\n\n'
            '**Secciones principales:**\n'
            '- _Mis Manuscritos_: lista de todos tus proyectos activos\n'
            '- _Actividad reciente_: últimas acciones realizadas\n'
            '- _Accesos rápidos_: atajos a las herramientas más usadas\n\n'
            'Usa el botón **Nuevo Manuscrito** para comenzar un proyecto de investigación.'
        ),
        'content_en': (
            'The **Dashboard** is your starting point in PrionLab Tools.\n\n'
            'From here you can access all your manuscripts, view recent activity metrics '
            'and navigate to any tool.\n\n'
            '**Main sections:**\n'
            '- _My Manuscripts_: list of all your active projects\n'
            '- _Recent Activity_: latest actions performed\n'
            '- _Quick Access_: shortcuts to most-used tools\n\n'
            'Use the **New Manuscript** button to start a research project.'
        ),
        'page_context': 'dashboard',
        'difficulty_level': 'beginner',
        'category': {'name': 'Dashboard', 'icon': '🏠'},
        'slug': 'dashboard-overview',
    },
    'dashboard-analytics': {
        'title_es': 'Métricas y Analytics en el Dashboard',
        'title_en': 'Dashboard Metrics and Analytics',
        'excerpt_es': 'Cómo interpretar las métricas de impacto en el panel principal.',
        'excerpt_en': 'How to interpret the impact metrics on the main dashboard.',
        'content_es': (
            'El panel de **Analytics** muestra métricas clave de tu actividad investigadora.\n\n'
            '**Métricas disponibles:**\n'
            '- _Manuscritos activos_: proyectos en curso\n'
            '- _Referencias totales_: artículos en tu biblioteca\n'
            '- _Citas generadas_: número de citas producidas\n\n'
            'Haz clic en cualquier métrica para ver el detalle completo en la sección Analytics.'
        ),
        'content_en': (
            'The **Analytics** panel shows key metrics of your research activity.\n\n'
            '**Available metrics:**\n'
            '- _Active manuscripts_: projects in progress\n'
            '- _Total references_: articles in your library\n'
            '- _Generated citations_: number of citations produced\n\n'
            'Click any metric to see full details in the Analytics section.'
        ),
        'page_context': 'dashboard',
        'difficulty_level': 'beginner',
        'category': {'name': 'Dashboard', 'icon': '🏠'},
        'slug': 'dashboard-analytics',
    },
    'manuscriptforge-intro': {
        'title_es': 'Introducción a ManuscriptForge',
        'title_en': 'Introduction to ManuscriptForge',
        'excerpt_es': 'ManuscriptForge es el editor central para gestionar manuscritos y referencias.',
        'excerpt_en': 'ManuscriptForge is the central editor for managing manuscripts and references.',
        'content_es': (
            '**ManuscriptForge** es la herramienta principal para redactar y gestionar tus artículos científicos.\n\n'
            '**Funcionalidades clave:**\n'
            '- _Gestión de referencias_: importa referencias desde ORCID, DOI o archivos BibTeX\n'
            '- _Editor de manuscrito_: redacta secciones con ayuda de IA\n'
            '- _Sincronización ORCID_: mantén tu perfil actualizado automáticamente\n'
            '- _Exportación_: genera el manuscrito en formato Word, LaTeX o PDF\n\n'
            'Para empezar, crea un nuevo manuscrito desde el Dashboard y selecciona la plantilla apropiada.'
        ),
        'content_en': (
            '**ManuscriptForge** is the main tool to draft and manage your scientific articles.\n\n'
            '**Key features:**\n'
            '- _Reference management_: import references from ORCID, DOI or BibTeX files\n'
            '- _Manuscript editor_: draft sections with AI assistance\n'
            '- _ORCID sync_: keep your profile updated automatically\n'
            '- _Export_: generate the manuscript in Word, LaTeX or PDF format\n\n'
            'To get started, create a new manuscript from the Dashboard and select the appropriate template.'
        ),
        'page_context': 'manuscript_forge',
        'difficulty_level': 'beginner',
        'category': {'name': 'ManuscriptForge', 'icon': '📝'},
        'slug': 'manuscriptforge-intro',
    },
    'manuscriptforge-references': {
        'title_es': 'Gestión de Referencias en ManuscriptForge',
        'title_en': 'Reference Management in ManuscriptForge',
        'excerpt_es': 'Cómo importar, organizar y citar referencias en tus manuscritos.',
        'excerpt_en': 'How to import, organize and cite references in your manuscripts.',
        'content_es': (
            'La gestión de referencias es una de las funcionalidades más potentes de ManuscriptForge.\n\n'
            '**Formas de importar referencias:**\n'
            '- _Por DOI_: introduce el DOI y los metadatos se importan automáticamente\n'
            '- _Archivo BibTeX_: arrastra un archivo .bib para importar múltiples referencias\n'
            '- _ORCID_: sincroniza tus publicaciones directamente desde tu perfil ORCID\n'
            '- _PubMed_: busca y añade artículos directamente desde PubMed\n\n'
            'Una vez importadas, usa `[cita]` en el editor para insertar una cita en el texto.'
        ),
        'content_en': (
            'Reference management is one of the most powerful features of ManuscriptForge.\n\n'
            '**Ways to import references:**\n'
            '- _By DOI_: enter the DOI and metadata is imported automatically\n'
            '- _BibTeX file_: drag a .bib file to import multiple references\n'
            '- _ORCID_: sync your publications directly from your ORCID profile\n'
            '- _PubMed_: search and add articles directly from PubMed\n\n'
            'Once imported, use `[cite]` in the editor to insert a citation in the text.'
        ),
        'page_context': 'manuscript_forge',
        'difficulty_level': 'intermediate',
        'category': {'name': 'ManuscriptForge', 'icon': '📝'},
        'slug': 'manuscriptforge-references',
    },
    'methods-library': {
        'title_es': 'Biblioteca de Métodos',
        'title_en': 'Methods Library',
        'excerpt_es': 'Encuentra y documenta métodos científicos estandarizados para tu investigación.',
        'excerpt_en': 'Find and document standardized scientific methods for your research.',
        'content_es': (
            'La **Biblioteca de Métodos** contiene protocolos y procedimientos científicos estandarizados.\n\n'
            '**Usos principales:**\n'
            '- Buscar métodos por disciplina o técnica\n'
            '- Añadir métodos a tu manuscrito con un clic\n'
            '- Crear y compartir tus propios protocolos\n\n'
            'Usa el buscador para filtrar por categoría (bioquímica, biología molecular, etc.) '
            'o por nombre de técnica específica.'
        ),
        'content_en': (
            'The **Methods Library** contains standardized scientific protocols and procedures.\n\n'
            '**Main uses:**\n'
            '- Search methods by discipline or technique\n'
            '- Add methods to your manuscript with one click\n'
            '- Create and share your own protocols\n\n'
            'Use the search bar to filter by category (biochemistry, molecular biology, etc.) '
            'or by specific technique name.'
        ),
        'page_context': 'methods',
        'difficulty_level': 'beginner',
        'category': {'name': 'Methods', 'icon': '🔬'},
        'slug': 'methods-library',
    },
    'ai-assistant-guide': {
        'title_es': 'Guía del Asistente IA',
        'title_en': 'AI Assistant Guide',
        'excerpt_es': 'Cómo usar el Asistente IA para maximizar tu productividad investigadora.',
        'excerpt_en': 'How to use the AI Assistant to maximize your research productivity.',
        'content_es': (
            'El **Asistente IA** de PrionLab Tools está entrenado para ayudarte con tareas de investigación científica.\n\n'
            '**Capacidades principales:**\n'
            '- _Revisión de texto_: mejora la redacción de secciones de tu manuscrito\n'
            '- _Análisis de referencias_: resume y relaciona artículos de tu biblioteca\n'
            '- _Generación de hipótesis_: sugiere preguntas de investigación basadas en tu contexto\n'
            '- _Búsqueda semántica_: encuentra referencias relevantes por significado, no solo por palabras clave\n\n'
            '**Consejo:** Sé específico en tus preguntas. En lugar de "ayúdame con mi manuscrito", '
            'di "revisa la sección de Métodos y sugiere cómo mejorar la claridad".'
        ),
        'content_en': (
            'The PrionLab Tools **AI Assistant** is trained to help you with scientific research tasks.\n\n'
            '**Main capabilities:**\n'
            '- _Text review_: improve the writing of manuscript sections\n'
            '- _Reference analysis_: summarize and relate articles in your library\n'
            '- _Hypothesis generation_: suggest research questions based on your context\n'
            '- _Semantic search_: find relevant references by meaning, not just keywords\n\n'
            '**Tip:** Be specific in your questions. Instead of "help me with my manuscript", '
            'say "review the Methods section and suggest how to improve clarity".'
        ),
        'page_context': 'ai_assistant',
        'difficulty_level': 'beginner',
        'category': {'name': 'AI Assistant', 'icon': '🤖'},
        'slug': 'ai-assistant-guide',
    },
    'analytics-impact': {
        'title_es': 'Análisis de Impacto de Investigación',
        'title_en': 'Research Impact Analysis',
        'excerpt_es': 'Cómo medir y visualizar el impacto de tu investigación con Analytics.',
        'excerpt_en': 'How to measure and visualize your research impact with Analytics.',
        'content_es': (
            'La sección de **Analytics** proporciona métricas detalladas sobre el impacto de tu investigación.\n\n'
            '**Métricas disponibles:**\n'
            '- _Factor H_: índice h calculado a partir de tus publicaciones\n'
            '- _Citas totales_: número total de citas recibidas\n'
            '- _Tendencias_: evolución de citas por año\n'
            '- _Colaboradores_: red de coautores y colaboraciones\n\n'
            'Los datos se sincronizan automáticamente con ORCID y CrossRef para mantenerlos actualizados.'
        ),
        'content_en': (
            'The **Analytics** section provides detailed metrics about your research impact.\n\n'
            '**Available metrics:**\n'
            '- _H-Index_: h-index calculated from your publications\n'
            '- _Total citations_: total number of citations received\n'
            '- _Trends_: citation evolution by year\n'
            '- _Collaborators_: co-author network and collaborations\n\n'
            'Data syncs automatically with ORCID and CrossRef to stay up to date.'
        ),
        'page_context': 'analytics',
        'difficulty_level': 'intermediate',
        'category': {'name': 'Analytics', 'icon': '📊'},
        'slug': 'analytics-impact',
    },
    'export-formats': {
        'title_es': 'Formatos de Exportación',
        'title_en': 'Export Formats',
        'excerpt_es': 'Exporta tus manuscritos en los formatos requeridos por las revistas científicas.',
        'excerpt_en': 'Export your manuscripts in the formats required by scientific journals.',
        'content_es': (
            'PrionLab Tools soporta múltiples formatos de exportación para adaptarse a los requisitos de cada revista.\n\n'
            '**Formatos disponibles:**\n'
            '- _Word (.docx)_: formato estándar para la mayoría de revistas\n'
            '- _LaTeX (.tex)_: para revistas que requieren LaTeX (Nature, Science, etc.)\n'
            '- _PDF_: para previsualización y envío\n'
            '- _BibTeX_: exporta solo las referencias\n\n'
            'En **Configuración de exportación** puedes seleccionar el estilo de cita (APA, Vancouver, IEEE, etc.) '
            'y la plantilla de la revista específica.'
        ),
        'content_en': (
            'PrionLab Tools supports multiple export formats to meet each journal\'s requirements.\n\n'
            '**Available formats:**\n'
            '- _Word (.docx)_: standard format for most journals\n'
            '- _LaTeX (.tex)_: for journals requiring LaTeX (Nature, Science, etc.)\n'
            '- _PDF_: for preview and submission\n'
            '- _BibTeX_: exports only the references\n\n'
            'In **Export Settings** you can select the citation style (APA, Vancouver, IEEE, etc.) '
            'and the specific journal template.'
        ),
        'page_context': 'export',
        'difficulty_level': 'beginner',
        'category': {'name': 'Export', 'icon': '📤'},
        'slug': 'export-formats',
    },

    # ── PrionVault ────────────────────────────────────────────────────────────

    'prionvault-intro': {
        'title_es': 'Introducción a PrionVault',
        'title_en': 'Introduction to PrionVault',
        'excerpt_es': 'PrionVault es la biblioteca científica inteligente del laboratorio.',
        'excerpt_en': 'PrionVault is the lab\'s intelligent scientific library.',
        'content_es': (
            '**PrionVault** es la biblioteca de literatura científica del laboratorio, '
            'diseñada para almacenar, organizar y explorar artículos sobre priones y neurodegeneración.\n\n'
            '**Qué puedes hacer:**\n'
            '- Subir PDFs de artículos y extraer su texto automáticamente\n'
            '- Generar resúmenes con IA (Claude, GPT o Gemini)\n'
            '- Buscar por título, autor, año, revista o texto libre\n'
            '- Hacer preguntas sobre la biblioteca entera con el asistente RAG\n'
            '- Organizar artículos en colecciones y etiquetas personales\n'
            '- Ver el estado de salud de la biblioteca de un vistazo\n\n'
            '**Acceso:** ve a _PrionVault_ desde el menú lateral. '
            'Los investigadores ven la biblioteca; los administradores además gestionan el contenido.'
        ),
        'content_en': (
            '**PrionVault** is the lab\'s scientific literature library, '
            'designed to store, organize and explore articles on prions and neurodegeneration.\n\n'
            '**What you can do:**\n'
            '- Upload article PDFs and extract text automatically\n'
            '- Generate AI summaries (Claude, GPT or Gemini)\n'
            '- Search by title, author, year, journal or free text\n'
            '- Ask questions about the whole library with the RAG assistant\n'
            '- Organize articles in personal collections and tags\n'
            '- See the library health at a glance\n\n'
            '**Access:** go to _PrionVault_ from the sidebar. '
            'Researchers see the library; admins also manage its content.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-intro',
    },

    'prionvault-search': {
        'title_es': 'Buscar y filtrar artículos',
        'title_en': 'Search and filter articles',
        'excerpt_es': 'Cómo encontrar artículos por texto, año, revista, etiqueta o estado.',
        'excerpt_en': 'How to find articles by text, year, journal, tag or status.',
        'content_es': (
            '**Búsqueda y filtros en PrionVault**\n\n'
            '**Barra de búsqueda:** escribe cualquier término para buscar en título, autores, '
            'abstract y DOI. La búsqueda es instantánea.\n\n'
            '**Filtros disponibles:**\n'
            '- _Año_: rango de fechas de publicación\n'
            '- _Revista_: filtra por nombre de revista\n'
            '- _Etiqueta_: tus etiquetas personales\n'
            '- _Colección_: colecciones manuales o inteligentes\n'
            '- _Estado PDF_: con PDF, sin PDF, escaneado (OCR)\n'
            '- _Proveedor IA_: resúmenes de Claude, GPT, Gemini o sin proveedor\n'
            '- _Verificación PDF_: artículos con Mismatch, Sospechosos o verificados OK\n\n'
            '**Ordenación:** haz clic en las cabeceras de columna (Año, Título, Añadido) '
            'para reordenar la lista ascendente o descendente.\n\n'
            '**Selección múltiple:** marca varios artículos con las casillas para aplicar '
            'acciones en bloque (mover a colección, etiquetar, generar resúmenes).'
        ),
        'content_en': (
            '**Search and filters in PrionVault**\n\n'
            '**Search bar:** type any term to search in title, authors, abstract and DOI. '
            'Search is instant.\n\n'
            '**Available filters:**\n'
            '- _Year_: publication date range\n'
            '- _Journal_: filter by journal name\n'
            '- _Tag_: your personal tags\n'
            '- _Collection_: manual or smart collections\n'
            '- _PDF status_: with PDF, without PDF, scanned (OCR)\n'
            '- _AI provider_: summaries by Claude, GPT, Gemini or unknown\n'
            '- _PDF verification_: articles with Mismatch, Suspect or verified OK\n\n'
            '**Sorting:** click column headers (Year, Title, Added) to sort ascending or descending.\n\n'
            '**Multi-select:** check several articles to apply bulk actions '
            '(move to collection, tag, generate summaries).'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-search',
    },

    'prionvault-upload': {
        'title_es': 'Subir artículos y procesar PDFs',
        'title_en': 'Upload articles and process PDFs',
        'excerpt_es': 'Cómo añadir artículos, extraer texto y activar el OCR.',
        'excerpt_en': 'How to add articles, extract text and activate OCR.',
        'content_es': (
            '**Añadir artículos a PrionVault**\n\n'
            '**Desde el menú _Procesado de artículos_:**\n'
            '- _Subir PDF_: sube uno o varios PDFs. PrionVault extrae el texto automáticamente.\n'
            '- _Importar por DOI o PMID_: introduce el identificador y se rellenan los metadatos '
            'automáticamente desde PubMed / CrossRef.\n'
            '- _Inventario PubMed_: importa lotes de artículos desde una búsqueda PubMed (XML).\n\n'
            '**Extracción de texto:**\n'
            'Al subir un PDF, el sistema intenta extraer el texto directamente. '
            'Si el PDF es una imagen escaneada, se activa OCR automáticamente y el artículo '
            'queda marcado con la etiqueta 📸 OCR.\n\n'
            '**Auto-fetcher OA:** para artículos del inventario PubMed sin PDF, el sistema '
            'busca automáticamente en Unpaywall y PMC una copia en acceso abierto. '
            'Si no la encuentra, aparece la etiqueta _PDF: sin OA_.\n\n'
            '**Comprobar veracidad del PDF:** al final del menú _Procesado_, '
            'puedes lanzar un análisis IA que compara los metadatos del artículo '
            '(título, año, revista, autores) con el contenido real del PDF '
            'para detectar PDFs incorrectos o intercambiados.'
        ),
        'content_en': (
            '**Adding articles to PrionVault**\n\n'
            '**From the _Article processing_ menu:**\n'
            '- _Upload PDF_: upload one or several PDFs. PrionVault extracts text automatically.\n'
            '- _Import by DOI or PMID_: enter the identifier and metadata are auto-filled '
            'from PubMed / CrossRef.\n'
            '- _PubMed Inventory_: import batches of articles from a PubMed search (XML).\n\n'
            '**Text extraction:**\n'
            'When uploading a PDF, the system tries to extract text directly. '
            'If the PDF is a scanned image, OCR activates automatically and the article '
            'is marked with the 📸 OCR tag.\n\n'
            '**OA auto-fetcher:** for inventory articles without a PDF, the system '
            'automatically searches Unpaywall and PMC for an open access copy. '
            'If not found, the _PDF: no OA_ tag appears.\n\n'
            '**PDF authenticity check:** at the end of the _Processing_ menu, '
            'you can run an AI analysis that compares article metadata '
            '(title, year, journal, authors) with the actual PDF content '
            'to detect incorrect or swapped PDFs.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-upload',
    },

    'prionvault-summaries': {
        'title_es': 'Resúmenes IA: generar, gestionar y corregir',
        'title_en': 'AI summaries: generate, manage and fix',
        'excerpt_es': 'Cómo generar resúmenes con Claude, GPT o Gemini y gestionar errores.',
        'excerpt_en': 'How to generate summaries with Claude, GPT or Gemini and manage errors.',
        'content_es': (
            '**Resúmenes IA en PrionVault**\n\n'
            '**Generar resúmenes en lote:**\n'
            'Ve a _Miscelánea → Estado IA_ y pulsa **Iniciar batch**. '
            'El sistema procesará todos los artículos que tienen texto extraído pero aún no tienen resumen. '
            'Puedes elegir el proveedor (Claude, GPT o Gemini) antes de empezar. '
            'El proceso es reanudable: si lo detienes o el servidor se reinicia, '
            'continúa desde donde lo dejó.\n\n'
            '**Badges en la lista:**\n'
            '- ✦ Claude — resumen de Anthropic\n'
            '- ⬡ GPT — resumen de OpenAI\n'
            '- ◈ Gemini — resumen de Google\n'
            '- _1.2k tk_ — tokens usados (entrada + salida); indica la longitud del resumen\n\n'
            '**Si un resumen da error:**\n'
            'El artículo queda marcado en _Salud de la biblioteca → Con errores/notas_. '
            'Abre el artículo en **Editar** para ver el tipo de error y el detalle del fallo. '
            'Usa **✕ Limpiar error** para borrar la nota una vez resuelto. '
            'El batch lo reintentará en la próxima ejecución si `summary_ai` sigue siendo NULL.\n\n'
            '**Corregir el proveedor:**\n'
            'Si un resumen se guardó sin proveedor registrado (aparece "IA" sin nombre), '
            'abre el artículo en Editar → sección _Resumen IA_ → desplegable → selecciona el proveedor correcto. '
            'Se guarda al instante.'
        ),
        'content_en': (
            '**AI summaries in PrionVault**\n\n'
            '**Batch summary generation:**\n'
            'Go to _Miscellaneous → AI Status_ and press **Start batch**. '
            'The system will process all articles that have extracted text but no summary yet. '
            'You can choose the provider (Claude, GPT or Gemini) before starting. '
            'The process is resumable: if you stop it or the server restarts, '
            'it continues from where it left off.\n\n'
            '**List badges:**\n'
            '- ✦ Claude — Anthropic summary\n'
            '- ⬡ GPT — OpenAI summary\n'
            '- ◈ Gemini — Google summary\n'
            '- _1.2k tk_ — tokens used (in + out); indicates summary length\n\n'
            '**If a summary fails:**\n'
            'The article is flagged under _Library health → With errors/notes_. '
            'Open the article in **Edit** to see the error type and failure detail. '
            'Use **✕ Clear error** to remove the note once resolved. '
            'The batch will retry it in the next run if `summary_ai` is still NULL.\n\n'
            '**Fix the provider:**\n'
            'If a summary was saved without a registered provider (shows "AI" with no name), '
            'open the article in Edit → _AI Summary_ section → dropdown → select the correct provider. '
            'Saves instantly.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-summaries',
    },

    'prionvault-rag': {
        'title_es': 'Preguntas sobre la biblioteca (RAG)',
        'title_en': 'Ask questions about the library (RAG)',
        'excerpt_es': 'Cómo hacer preguntas científicas y obtener respuestas con citas de la biblioteca.',
        'excerpt_en': 'How to ask scientific questions and get cited answers from the library.',
        'content_es': (
            '**Asistente RAG de PrionVault**\n\n'
            'El asistente RAG (_Retrieval-Augmented Generation_) te permite hacer preguntas '
            'en lenguaje natural sobre todos los artículos de la biblioteca.\n\n'
            '**Cómo funciona:**\n'
            '1. Tu pregunta se convierte en un vector semántico (Voyage AI)\n'
            '2. Se recuperan los fragmentos más relevantes de los PDFs indexados\n'
            '3. Para cada artículo citado, se añade además su resumen IA si existe\n'
            '4. El modelo seleccionado (Claude, GPT o Gemini) genera una respuesta '
            'basada ÚNICAMENTE en esos fragmentos, citando cada afirmación con [N]\n'
            '5. Se indica el nivel de confianza: alto / medio / bajo\n\n'
            '**Expansión de consulta:** el sistema reconoce términos biomédicos y los expande '
            'automáticamente (p. ej. "prion" incluye PrPSc, PrPC, prión, etc.).\n\n'
            '**Fallback de proveedor:** si el proveedor elegido rechaza la consulta o falla, '
            'el sistema intenta automáticamente con el siguiente proveedor disponible '
            'y te informa del cambio.\n\n'
            '**Ver más resultados:** si hay más artículos relevantes de los mostrados, '
            'aparece un botón _"Ver más"_ para ampliar la búsqueda.\n\n'
            '**Importante:** el RAG responde solo con lo que está en la biblioteca. '
            'Si no hay evidencia suficiente, lo dice explícitamente.'
        ),
        'content_en': (
            '**PrionVault RAG assistant**\n\n'
            'The RAG (_Retrieval-Augmented Generation_) assistant lets you ask questions '
            'in natural language about all articles in the library.\n\n'
            '**How it works:**\n'
            '1. Your question is converted into a semantic vector (Voyage AI)\n'
            '2. The most relevant fragments from indexed PDFs are retrieved\n'
            '3. For each cited article, its AI summary is also added if available\n'
            '4. The selected model (Claude, GPT or Gemini) generates an answer '
            'based ONLY on those fragments, citing each claim with [N]\n'
            '5. A confidence level is indicated: high / medium / low\n\n'
            '**Query expansion:** the system recognises biomedical terms and expands them '
            'automatically (e.g. "prion" includes PrPSc, PrPC, prion, etc.).\n\n'
            '**Provider fallback:** if the chosen provider rejects the query or fails, '
            'the system automatically tries the next available provider and notifies you.\n\n'
            '**See more results:** if there are more relevant articles than shown, '
            'a _"See more"_ button appears to expand the search.\n\n'
            '**Important:** RAG only answers with what is in the library. '
            'If there is insufficient evidence, it says so explicitly.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-rag',
    },

    'prionvault-health': {
        'title_es': 'Salud de la biblioteca',
        'title_en': 'Library health',
        'excerpt_es': 'El panel de salud muestra el estado completo de la biblioteca de un vistazo.',
        'excerpt_en': 'The health panel shows the complete library status at a glance.',
        'content_es': (
            '**Salud de la biblioteca**\n\n'
            'Accede desde _Miscelánea → Salud de la biblioteca_. '
            'Muestra el estado real y actualizado de todos los artículos.\n\n'
            '**Secciones del panel:**\n\n'
            '_Biblioteca_: total de artículos, con texto extraído, con abstract, con PDF, indexados.\n\n'
            '_Resúmenes IA_: cuántos tienen resumen, desglose por proveedor (Claude / GPT / Gemini / sin proveedor), '
            'cuántos tienen notas de error. Cada tarjeta es clicable y filtra la lista de artículos.\n\n'
            '_Verificación PDF_: artículos con Mismatch (discrepancia detectada), '
            'Sospechosos, Match OK, y sin verificar. Clica para ver solo ese grupo.\n\n'
            '_Inventario PubMed_: artículos importados desde inventario, '
            'con PDF conseguido, en espera o sin acceso abierto.\n\n'
            '**Artículos con errores/notas:** los artículos donde la IA intentó generar un resumen '
            'y falló aparecen aquí. Abre cada artículo en Editar para ver el error y limpiarlo.'
        ),
        'content_en': (
            '**Library health**\n\n'
            'Access from _Miscellaneous → Library health_. '
            'Shows the real, live status of all articles.\n\n'
            '**Panel sections:**\n\n'
            '_Library_: total articles, with extracted text, with abstract, with PDF, indexed.\n\n'
            '_AI Summaries_: how many have a summary, breakdown by provider (Claude / GPT / Gemini / unknown), '
            'how many have error notes. Each card is clickable and filters the article list.\n\n'
            '_PDF verification_: articles with Mismatch (detected discrepancy), '
            'Suspect, Match OK, and unverified. Click to see only that group.\n\n'
            '_PubMed inventory_: articles imported from inventory, '
            'with PDF found, waiting or with no open access.\n\n'
            '**Articles with errors/notes:** articles where the AI tried to generate a summary '
            'and failed appear here. Open each article in Edit to see the error and clear it.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-health',
    },

    'prionvault-edit': {
        'title_es': 'Editar artículos y gestionar metadatos',
        'title_en': 'Edit articles and manage metadata',
        'excerpt_es': 'Cómo editar metadatos, corregir verificaciones PDF y gestionar el proveedor del resumen.',
        'excerpt_en': 'How to edit metadata, fix PDF verifications and manage the summary provider.',
        'content_es': (
            '**Modal de edición de artículos**\n\n'
            'Pulsa **✏ Editar** en cualquier artículo para abrir el modal de edición.\n\n'
            '**Metadatos editables:** título, autores, año, revista, DOI, PMID, abstract.\n\n'
            '**Buscar metadatos automáticamente:**\n'
            '- _Por DOI_: consulta CrossRef / PubMed y rellena los campos\n'
            '- _Por PMID_: consulta PubMed directamente\n'
            '- _🤖 Buscar PMID con IA_: la IA lee el PDF e identifica el artículo\n\n'
            '**Sección Resumen IA** (si existe resumen o error):\n'
            '- Muestra el proveedor actual con un desplegable para corregirlo\n'
            '- Muestra los tokens usados (entrada / salida) — indicativo del coste y longitud\n'
            '- Si hay una nota de error, muestra la primera línea en rojo con el botón **✕ Limpiar error**\n\n'
            '**Sección Verificación PDF** (si se ha verificado):\n'
            '- Badge de estado: ✗ Mismatch / ⚠ Sospechoso / ✓ OK\n'
            '- Score de confianza y detalle de qué campos discrepan\n'
            '- **✓ Marcar OK**: marca el artículo como verificado manualmente\n'
            '- **🔁 Reverificar**: lo pone en cola para una nueva verificación IA\n\n'
            '**Acciones adicionales:** eliminar artículo, marcar sin abstract, '
            'navegar al artículo anterior/siguiente sin cerrar el modal.'
        ),
        'content_en': (
            '**Article edit modal**\n\n'
            'Press **✏ Edit** on any article to open the edit modal.\n\n'
            '**Editable metadata:** title, authors, year, journal, DOI, PMID, abstract.\n\n'
            '**Auto-fetch metadata:**\n'
            '- _By DOI_: queries CrossRef / PubMed and fills in the fields\n'
            '- _By PMID_: queries PubMed directly\n'
            '- _🤖 Find PMID with AI_: the AI reads the PDF and identifies the article\n\n'
            '**AI Summary section** (if a summary or error exists):\n'
            '- Shows the current provider with a dropdown to correct it\n'
            '- Shows tokens used (input / output) — indicative of cost and length\n'
            '- If there is an error note, shows the first line in red with **✕ Clear error** button\n\n'
            '**PDF Verification section** (if verified):\n'
            '- Status badge: ✗ Mismatch / ⚠ Suspect / ✓ OK\n'
            '- Confidence score and detail of which fields differ\n'
            '- **✓ Mark OK**: marks the article as manually verified\n'
            '- **🔁 Re-verify**: queues it for a new AI verification\n\n'
            '**Additional actions:** delete article, mark as no abstract, '
            'navigate to previous/next article without closing the modal.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-edit',
    },

    'prionvault-collections': {
        'title_es': 'Colecciones y etiquetas',
        'title_en': 'Collections and tags',
        'excerpt_es': 'Organiza artículos en colecciones manuales o inteligentes y etiquetas personales.',
        'excerpt_en': 'Organize articles in manual or smart collections and personal tags.',
        'content_es': (
            '**Colecciones en PrionVault**\n\n'
            '**Colecciones manuales:** agrupa artículos de forma libre. '
            'Crea una colección desde el panel lateral → _Colecciones_ → +. '
            'Añade artículos seleccionándolos en la lista y usando el menú de acciones en bloque.\n\n'
            '**Colecciones inteligentes:** se definen con reglas (p. ej. "todos los artículos de 2020-2024 '
            'con resumen IA"). El contenido se actualiza automáticamente sin intervención manual.\n\n'
            '**Jerarquía:** las colecciones pueden tener subcolecciones. '
            'En el panel lateral, las colecciones padre muestran el recuento total incluyendo hijos.\n\n'
            '**Etiquetas personales:**\n'
            'Las etiquetas son por usuario — cada investigador tiene las suyas sin interferir con los demás. '
            'Crea y asigna etiquetas desde el menú lateral o desde la lista de artículos. '
            'Filtra por etiqueta usando el desplegable de filtros.\n\n'
            '**Marcas personales:**\n'
            '- ⭐ Favorito / 📌 Hito / 🚩 Marcado — solo visibles para ti\n'
            '- Prioridad (1-5) y etiqueta de color — también por usuario'
        ),
        'content_en': (
            '**Collections in PrionVault**\n\n'
            '**Manual collections:** group articles freely. '
            'Create a collection from the sidebar → _Collections_ → +. '
            'Add articles by selecting them in the list and using the bulk actions menu.\n\n'
            '**Smart collections:** defined with rules (e.g. "all articles from 2020-2024 '
            'with AI summary"). Content updates automatically without manual intervention.\n\n'
            '**Hierarchy:** collections can have subcollections. '
            'In the sidebar, parent collections show the total count including children.\n\n'
            '**Personal tags:**\n'
            'Tags are per-user — each researcher has their own without interfering with others. '
            'Create and assign tags from the sidebar or from the article list. '
            'Filter by tag using the filters dropdown.\n\n'
            '**Personal marks:**\n'
            '- ⭐ Favourite / 📌 Milestone / 🚩 Flagged — visible only to you\n'
            '- Priority (1-5) and colour label — also per user'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-collections',
    },

    'prionvault-pdf-verify': {
        'title_es': 'Verificación de veracidad de PDFs',
        'title_en': 'PDF authenticity verification',
        'excerpt_es': 'La IA compara metadatos y contenido PDF para detectar artículos mal asignados.',
        'excerpt_en': 'AI compares metadata and PDF content to detect misassigned articles.',
        'content_es': (
            '**Verificación de veracidad de PDFs**\n\n'
            'Accede desde _Procesado de artículos → Comprobar veracidad PDFs_.\n\n'
            '**Qué hace:** la IA analiza el PDF de cada artículo y compara título, año, '
            'revista y autores con los metadatos registrados en la base de datos. '
            'Detecta PDFs incorrectos, intercambiados o mal enlazados.\n\n'
            '**Estados de verificación:**\n'
            '- ✗ **Mismatch** (rojo): discrepancia clara detectada — revisa el PDF\n'
            '- ⚠ **Sospechoso** (naranja): la IA tiene dudas — revisa manualmente\n'
            '- ✓ **Match OK** (verde): PDF coincide con los metadatos\n'
            '- ✓ **OK manual** (verde): verificado manualmente por un administrador\n\n'
            '**Badges en la lista:** los artículos verificados muestran un badge clicable. '
            'Pulsar en Mismatch o Sospechoso abre directamente el modal de edición.\n\n'
            '**Transferir al listado:** en el modal de verificación, '
            'usa _"Ver en listado"_ para trasladar los artículos de una pestaña (o tu selección) '
            'al listado principal y trabajar con ellos.\n\n'
            '**Acciones rápidas en Editar:**\n'
            '- _✓ Marcar OK_: fuerza el estado a OK manual sin reverificar\n'
            '- _🔁 Reverificar_: pone el artículo en cola para un nuevo análisis IA'
        ),
        'content_en': (
            '**PDF authenticity verification**\n\n'
            'Access from _Article processing → Check PDF authenticity_.\n\n'
            '**What it does:** AI analyses each article\'s PDF and compares title, year, '
            'journal and authors against the metadata in the database. '
            'Detects incorrect, swapped or mislinked PDFs.\n\n'
            '**Verification states:**\n'
            '- ✗ **Mismatch** (red): clear discrepancy detected — review the PDF\n'
            '- ⚠ **Suspect** (orange): AI has doubts — review manually\n'
            '- ✓ **Match OK** (green): PDF matches the metadata\n'
            '- ✓ **Manual OK** (green): manually verified by an administrator\n\n'
            '**List badges:** verified articles show a clickable badge. '
            'Clicking Mismatch or Suspect opens the edit modal directly.\n\n'
            '**Transfer to list:** in the verification modal, '
            'use _"View in list"_ to move articles from a tab (or your selection) '
            'to the main list to work with them.\n\n'
            '**Quick actions in Edit:**\n'
            '- _✓ Mark OK_: forces the status to manual OK without re-verifying\n'
            '- _🔁 Re-verify_: queues the article for a new AI analysis'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-pdf-verify',
    },

    'prionvault-indexing': {
        'title_es': 'Indexado semántico (Voyage AI)',
        'title_en': 'Semantic indexing (Voyage AI)',
        'excerpt_es': 'Cómo funciona el indexado vectorial que alimenta el buscador semántico y el RAG.',
        'excerpt_en': 'How vector indexing works to power semantic search and RAG.',
        'content_es': (
            '**Indexado semántico en PrionVault**\n\n'
            'El indexado convierte el texto de los artículos en vectores numéricos '
            '(embeddings) almacenados en PostgreSQL con pgvector. '
            'Esto permite búsquedas semánticas y el asistente RAG.\n\n'
            '**Motor:** Voyage AI con el modelo _voyage-4-large_, especializado en texto científico. '
            'El texto se divide en fragmentos (_chunks_) de tamaño controlado.\n\n'
            '**Dos fuentes de texto:** el sistema indexa tanto el texto completo del PDF '
            'como el abstract, de forma independiente.\n\n'
            '**Cuándo se indexa:** automáticamente tras extraer el texto de un PDF. '
            'El badge _indexed_ en verde en la lista del artículo confirma que está listo.\n\n'
            '**Reindexado:** desde _Procesado de artículos_ hay un botón de reindexado limpio '
            'que borra los chunks existentes y los regenera. Útil si el modelo de embeddings '
            'se actualiza o si el texto se ha re-extraído con mejor calidad.\n\n'
            '**Búsqueda híbrida:** la recuperación combina búsqueda vectorial (semántica) '
            'con BM25 (léxica) mediante Reciprocal Rank Fusion para mejores resultados.'
        ),
        'content_en': (
            '**Semantic indexing in PrionVault**\n\n'
            'Indexing converts article text into numerical vectors '
            '(embeddings) stored in PostgreSQL with pgvector. '
            'This enables semantic search and the RAG assistant.\n\n'
            '**Engine:** Voyage AI with the _voyage-4-large_ model, specialised for scientific text. '
            'Text is split into controlled-size fragments (_chunks_).\n\n'
            '**Two text sources:** the system indexes both the full PDF text '
            'and the abstract, independently.\n\n'
            '**When it indexes:** automatically after extracting text from a PDF. '
            'The green _indexed_ badge in the article list confirms it\'s ready.\n\n'
            '**Re-indexing:** from _Article processing_ there is a clean re-index button '
            'that deletes existing chunks and regenerates them. Useful if the embeddings model '
            'is updated or if text has been re-extracted with better quality.\n\n'
            '**Hybrid search:** retrieval combines vector search (semantic) '
            'with BM25 (lexical) via Reciprocal Rank Fusion for better results.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'advanced',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-indexing',
    },

    'prionvault-chrome-extension': {
        'title_es': 'Extensión Chrome: instalación y uso',
        'title_en': 'Chrome Extension: installation and use',
        'excerpt_es': 'Cómo instalar la extensión de PrionVault para Chrome y añadir artículos desde cualquier web.',
        'excerpt_en': 'How to install the PrionVault Chrome extension and add articles from any website.',
        'content_es': (
            '**Extensión de Chrome para PrionVault**\n\n'
            'La extensión detecta DOIs y PMIDs en cualquier página web y te permite añadir '
            'artículos directamente a PrionVault sin salir del navegador.\n\n'

            '**1. Descargar la extensión**\n'
            'En PrionVault, abre el menú de usuario (tu inicial en la esquina superior derecha) '
            'y haz clic en **🧩 Chrome Extension**. Se descargará el fichero '
            '`prionvault-extension.zip`. Descomprímelo en una carpeta de tu ordenador.\n\n'

            '**2. Instalar en Chrome**\n'
            '- Abre Chrome y ve a `chrome://extensions`\n'
            '- Activa el **Modo desarrollador** (interruptor en la esquina superior derecha)\n'
            '- Haz clic en **Cargar descomprimida**\n'
            '- Selecciona la carpeta `prionvault-extension` que acabas de descomprimir\n\n'

            '**3. Fijar la extensión en la barra**\n'
            'Haz clic en el icono de puzzle 🧩 de Chrome (barra superior derecha) para ver '
            'todas tus extensiones. Busca **PrionVault** y haz clic en el pin 📌 para fijarlo. '
            'Aparecerá el icono con la "P" azul directamente en la barra.\n\n'

            '**4. Configurar servidor y API key**\n'
            'Haz clic en el icono de PrionVault en la barra de Chrome. Se abrirá un popup con dos campos:\n'
            '- _URL del servidor_: la URL raíz de tu instancia, por ejemplo '
            '`https://tu-app.up.railway.app` (sin rutas adicionales al final)\n'
            '- _API Key_: el valor que has configurado en la variable de entorno '
            '`PRIONVAULT_EXTENSION_API_KEY` en el servidor\n\n'
            'Pulsa **Guardar configuración**. Si la conexión es correcta, verás ✓ Conectado.\n\n'

            '**5. Usar la extensión**\n'
            'Navega a la página de cualquier artículo científico (PubMed, DOI.org, revista, etc.). '
            'Si la página contiene un DOI o PMID, la extensión abrirá automáticamente un panel '
            'lateral con los metadatos del artículo.\n\n'
            'Desde ese panel puedes:\n'
            '- Ver título, autores, revista, año, DOI, PMID y abstract\n'
            '- Pulsar **+ Añadir a PrionVault** para guardarlo con sus metadatos\n'
            '- Pulsar **📄 Añadir con PDF** para guardar también el PDF '
            '(funciona con PDFs en acceso abierto o si tienes acceso institucional activo)\n\n'
            'Si el artículo ya está en tu biblioteca, el panel lo indica con una marca verde '
            'y un enlace directo para verlo en PrionVault.\n\n'

            '**Generar la API key**\n'
            'Si aún no has creado la clave, ejecuta en tu máquina:\n'
            '`python -c "import secrets; print(secrets.token_hex(32))"`\n'
            'Copia el resultado y añádelo como variable de entorno `PRIONVAULT_EXTENSION_API_KEY` '
            'en Railway (u donde tengas el servidor). Usa ese mismo valor en el popup de la extensión.'
        ),
        'content_en': (
            '**PrionVault Chrome Extension**\n\n'
            'The extension detects DOIs and PMIDs on any web page and lets you add '
            'articles directly to PrionVault without leaving your browser.\n\n'

            '**1. Download the extension**\n'
            'In PrionVault, open the user menu (your initial in the top-right corner) '
            'and click **🧩 Chrome Extension**. The file `prionvault-extension.zip` will download. '
            'Unzip it to a folder on your computer.\n\n'

            '**2. Install in Chrome**\n'
            '- Open Chrome and go to `chrome://extensions`\n'
            '- Enable **Developer mode** (toggle in the top-right corner)\n'
            '- Click **Load unpacked**\n'
            '- Select the `prionvault-extension` folder you just unzipped\n\n'

            '**3. Pin the extension to the toolbar**\n'
            'Click the Chrome puzzle icon 🧩 (top-right toolbar) to see all your extensions. '
            'Find **PrionVault** and click the pin 📌 to pin it. '
            'The blue "P" icon will appear directly in the toolbar.\n\n'

            '**4. Configure server and API key**\n'
            'Click the PrionVault icon in the Chrome toolbar. A popup opens with two fields:\n'
            '- _Server URL_: the root URL of your instance, e.g. '
            '`https://your-app.up.railway.app` (no extra path at the end)\n'
            '- _API Key_: the value you set in the `PRIONVAULT_EXTENSION_API_KEY` '
            'environment variable on the server\n\n'
            'Click **Save settings**. If the connection is successful you will see ✓ Connected.\n\n'

            '**5. Using the extension**\n'
            'Navigate to any scientific article page (PubMed, DOI.org, journal site, etc.). '
            'If the page contains a DOI or PMID, the extension automatically opens a side panel '
            'with the article metadata.\n\n'
            'From that panel you can:\n'
            '- View title, authors, journal, year, DOI, PMID and abstract\n'
            '- Click **+ Add to PrionVault** to save it with its metadata\n'
            '- Click **📄 Add with PDF** to also save the PDF '
            '(works with open-access PDFs or if you have active institutional access)\n\n'
            'If the article is already in your library, the panel shows a green badge '
            'and a direct link to view it in PrionVault.\n\n'

            '**Generate the API key**\n'
            'If you have not created the key yet, run on your machine:\n'
            '`python -c "import secrets; print(secrets.token_hex(32))"`\n'
            'Copy the result and add it as the `PRIONVAULT_EXTENSION_API_KEY` environment variable '
            'in Railway (or wherever your server runs). Use the same value in the extension popup.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-chrome-extension',
    },

    'prionvault-notes': {
        'title_es': 'Notas en los artículos',
        'title_en': 'Article sticky notes',
        'excerpt_es': 'Crea hasta 5 notas de colores por artículo, con texto e imágenes.',
        'excerpt_en': 'Create up to 5 colour-coded notes per article, with text and images.',
        'content_es': (
            '**Notas por artículo**\n\n'
            'Cada artículo puede tener tus propias notas privadas. Son personales: '
            'solo tú ves las tuyas.\n\n'

            '**Dónde están**\n'
            'En el listado de artículos, a la izquierda del carrito 🛒, verás un icono '
            'de nota. Si el artículo aún no tiene notas, aparece una **nota gris** '
            '(añadir). Al crear notas, cada una aparece con su color y la gris se '
            'mantiene a su derecha para añadir la siguiente.\n\n'

            '**Colores automáticos**\n'
            'No se elige el color: se asigna por orden de creación.\n'
            '- 1ª nota: **amarilla**\n'
            '- 2ª nota: **azul**\n'
            '- 3ª nota: **verde**\n'
            '- 4ª nota: **morada**\n'
            '- 5ª nota: **naranja**\n\n'
            'El máximo es **5 notas por artículo**. Al llegar a la quinta, la nota gris '
            'de "añadir" desaparece.\n\n'

            '**Crear, ver, editar y borrar**\n'
            '- Clic en la **nota gris** para escribir una nueva.\n'
            '- Clic en una **nota de color** para abrir esa nota y editarla.\n'
            '- Dentro del editor puedes escribir texto y **pegar imágenes** '
            '(se comprimen automáticamente).\n'
            '- Pulsa **Guardar** (o Ctrl/Cmd+S). Para eliminar, usa **Eliminar**.\n\n'
            'Si borras una nota, su color queda libre y la nota gris vuelve a aparecer '
            'hasta completar de nuevo las 5.\n\n'
            'Dentro del modal, los círculos de color de arriba te permiten cambiar de '
            'una nota a otra o crear una nueva con el botón **+**.'
        ),
        'content_en': (
            '**Per-article notes**\n\n'
            'Every article can hold your own private notes. They are personal — only '
            'you see yours.\n\n'

            '**Where they are**\n'
            'In the article list, to the left of the cart 🛒, you will see a note icon. '
            'If the article has no notes yet, a **grey note** (add) appears. As you '
            'create notes, each shows in its colour and the grey one stays to its right '
            'to add the next.\n\n'

            '**Automatic colours**\n'
            'The colour is not chosen — it follows creation order.\n'
            '- 1st note: **yellow**\n'
            '- 2nd note: **blue**\n'
            '- 3rd note: **green**\n'
            '- 4th note: **purple**\n'
            '- 5th note: **orange**\n\n'
            'The maximum is **5 notes per article**. On the fifth, the grey "add" note '
            'disappears.\n\n'

            '**Create, view, edit and delete**\n'
            '- Click the **grey note** to write a new one.\n'
            '- Click a **coloured note** to open and edit it.\n'
            '- In the editor you can type text and **paste images** '
            '(auto-compressed).\n'
            '- Click **Save** (or Ctrl/Cmd+S). To remove it, use **Delete**.\n\n'
            'If you delete a note, its colour frees up and the grey note reappears '
            'until you reach 5 again.\n\n'
            'Inside the modal, the coloured circles at the top let you switch between '
            'notes or create a new one with the **+** button.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-notes',
    },

    'prionvault-ai-chat': {
        'title_es': 'Chatear con la IA sobre un artículo',
        'title_en': 'Chat with the AI about an article',
        'excerpt_es': 'Haz preguntas sobre un artículo concreto; con cambio automático de IA y conversaciones guardadas.',
        'excerpt_en': 'Ask questions about a specific article; automatic AI fallback and saved conversations.',
        'content_es': (
            '**Preguntar a la IA sobre un artículo**\n\n'
            'Puedes abrir un chat centrado en un solo artículo. La IA recibe como contexto '
            'el propio artículo (su texto vectorizado), su resumen IA si lo tiene, y las '
            'conversaciones previas, para dar mejores respuestas.\n\n'

            '**Cómo abrirlo**\n'
            '- En el listado, pulsa el botón azul **🤖 Chat** del artículo.\n'
            '- O dentro de la ficha del artículo, el botón **🤖 Preguntar a la IA sobre este artículo**.\n\n'

            '**Elegir la IA (y cambio automático)**\n'
            'En el modal puedes elegir el modelo. Por defecto es **Claude**. Si el modelo '
            'elegido falla (límite de uso, filtro de seguridad, etc.), el sistema cambia '
            'solo en este orden: **Claude → GPT → Gemini**, y te avisa con un aviso ámbar '
            'de qué IA respondió finalmente.\n\n'

            '**Formato de chat**\n'
            'Escribes tu pregunta y la respuesta aparece debajo, en forma de conversación. '
            'Cada respuesta lleva la etiqueta de la IA que la generó.\n\n'

            '**Conversaciones guardadas**\n'
            'Todas las conversaciones se guardan. Con **🕑 Chats anteriores** recuperas las '
            'conversaciones previas sobre ese artículo, cada una marcada con la IA usada. '
            'Puedes retomarlas, crear una **+ Nueva conversación** o eliminar las que no '
            'quieras. Las conversaciones son personales (por usuario).'
        ),
        'content_en': (
            '**Ask the AI about an article**\n\n'
            'You can open a chat focused on a single article. The AI receives the article '
            'itself (its vectorized text), its AI summary if any, and prior conversations '
            'as context, for better answers.\n\n'

            '**How to open it**\n'
            '- In the list, click the blue **🤖 Chat** button on the article.\n'
            '- Or inside the article view, the **🤖 Ask the AI about this article** button.\n\n'

            '**Choose the AI (and automatic fallback)**\n'
            'In the modal you can pick the model. Default is **Claude**. If the chosen model '
            'fails (rate limit, safety filter, etc.), the system switches automatically in '
            'this order: **Claude → GPT → Gemini**, and shows an amber note telling you which '
            'AI actually answered.\n\n'

            '**Chat format**\n'
            'You type your question and the answer appears below, as a conversation. Each '
            'answer is tagged with the AI that produced it.\n\n'

            '**Saved conversations**\n'
            'All conversations are saved. Use **🕑 Past chats** to retrieve prior '
            'conversations about that article, each tagged with the AI used. You can resume '
            'them, start a **+ New conversation**, or delete the ones you do not want. '
            'Conversations are personal (per user).'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-ai-chat',
    },

    'prionvault-glossary': {
        'title_es': 'Glosario de traducción para la IA',
        'title_en': 'Translation glossary for the AI',
        'excerpt_es': 'Fija traducciones correctas que la IA debe respetar en resúmenes y chat.',
        'excerpt_en': 'Pin correct translations the AI must respect in summaries and chat.',
        'content_es': (
            '**Glosario de traducción**\n\n'
            'A veces la IA traduce mal un término. El glosario te permite fijar la '
            'traducción correcta para que la respete siempre. Ejemplo clásico: '
            '_bank vole_ debe ser **topillo rojo**, y nunca «musaraña de banco».\n\n'

            '**Dónde está**\n'
            'En la barra lateral de PrionVault, dentro de **Miscelánea → 🗣 Glosario de '
            'traducción** (solo administradores).\n\n'

            '**Cómo usarlo**\n'
            '- Escribe el **término original** (en inglés) y su **traducción correcta**, '
            'con una nota opcional (por ejemplo, el nombre científico).\n'
            '- Pulsa **+ Añadir**. Puedes editar, filtrar o eliminar reglas.\n\n'

            '**Qué garantiza**\n'
            'Cada regla se inyecta como instrucción obligatoria en la IA, tanto en los '
            '**resúmenes** (Claude, GPT y Gemini) como en el **chat del artículo**. Así, '
            'cuando aparezca el término de origen, usará siempre tu traducción.\n\n'
            '_Nota:_ afecta a lo que se genere a partir de ahora. Los resúmenes ya creados '
            'con la traducción incorrecta hay que **regenerarlos** para que apliquen el glosario.'
        ),
        'content_en': (
            '**Translation glossary**\n\n'
            'Sometimes the AI mistranslates a term. The glossary lets you pin the correct '
            'translation so it always respects it. Classic example: _bank vole_ must be '
            '**topillo rojo** in Spanish, never «musaraña de banco».\n\n'

            '**Where it is**\n'
            'In the PrionVault sidebar, under **Miscellaneous → 🗣 Translation glossary** '
            '(admins only).\n\n'

            '**How to use it**\n'
            '- Enter the **source term** (English) and its **correct translation**, with an '
            'optional note (e.g. the scientific name).\n'
            '- Click **+ Add**. You can edit, filter or delete rules.\n\n'

            '**What it guarantees**\n'
            'Each rule is injected as a mandatory instruction into the AI, both in the '
            '**summaries** (Claude, GPT and Gemini) and in the **article chat**. So whenever '
            'the source term appears, it will always use your translation.\n\n'
            '_Note:_ this affects text generated from now on. Summaries already created with '
            'the wrong translation must be **regenerated** to apply the glossary.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-glossary',
    },

    'prionvault-notifications': {
        'title_es': 'Notificaciones por email y PrionVault Picks',
        'title_en': 'Email notifications and PrionVault Picks',
        'excerpt_es': 'Digest semanal, PrionVault Picks con PDF adjunto, importación en bloque y diagnóstico.',
        'excerpt_en': 'Weekly digest, PrionVault Picks with attached PDF, bulk import and diagnostics.',
        'content_es': (
            '**Notificaciones por email**\n\n'
            'Desde **Miscelánea → 🔔 Notificaciones** configuras avisos por email: temas, '
            'frecuencia (semanal, quincenal, mensual), día y hora.\n\n'

            '**Digest de novedades de PubMed**\n'
            '- El email muestra los artículos nuevos de tus temas. Si un artículo coincide '
            'con **varios temas** (por ejemplo Prion y Prion-like), ahora se muestra una sola '
            'vez con **todas sus etiquetas**.\n'
            '- Botón **Importar todos** al final del email para pasar todos los artículos a '
            'PrionVault de una vez (abre una página de confirmación). Cada artículo también '
            'tiene su botón individual.\n\n'

            '**PrionVault Picks**\n'
            'Es un envío con artículos que has marcado en tu biblioteca. Ahora el email trae '
            'el botón **Ver en PrionVault →** y, cuando es posible, **adjunta el PDF** del '
            'artículo para que puedas leerlo directamente.\n\n'

            '**Diagnóstico ("¿por qué no llegaron artículos?")**\n'
            'En cada notificación hay un botón **🔍 Diagnóstico** que comprueba, sin enviar '
            'ningún email, exactamente qué encontraría la consulta con tus parámetros: temas, '
            'fechas, número de artículos y si el filtro de solo acceso abierto está ocultando '
            'resultados. Útil cuando un envío dice "sin novedades".'
        ),
        'content_en': (
            '**Email notifications**\n\n'
            'From **Miscellaneous → 🔔 Notifications** you configure email alerts: topics, '
            'frequency (weekly, biweekly, monthly), day and time.\n\n'

            '**PubMed new-articles digest**\n'
            '- The email lists new articles for your topics. If an article matches '
            '**several topics** (e.g. Prion and Prion-like), it now shows once with **all its '
            'tags**.\n'
            '- An **Import all** button at the bottom sends every article to PrionVault at '
            'once (opens a confirmation page). Each article also has its own button.\n\n'

            '**PrionVault Picks**\n'
            'A send with articles you flagged in your library. The email now carries a '
            '**View in PrionVault →** button and, when possible, **attaches the article PDF** '
            'so you can read it directly.\n\n'

            '**Diagnostics ("why no articles?")**\n'
            'Each notification has a **🔍 Diagnostics** button that checks — without sending '
            'any email — exactly what the query would find with your parameters: topics, '
            'dates, article count, and whether the open-access-only filter is hiding results. '
            'Handy when a send says "nothing new".'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'beginner',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-notifications',
    },

    'prionvault-email-ingest': {
        'title_es': 'Enviar artículos por email a PrionVault',
        'title_en': 'Email articles into PrionVault',
        'excerpt_es': 'Manda un PDF por email y PrionVault lo deja listo (PMID, abstract, buscable, indexado y resumido) y te contesta con el resumen.',
        'excerpt_en': 'Email a PDF and PrionVault sets it up (PMID, abstract, searchable, indexed, summarised) and replies with the summary.',
        'content_es': (
            '**Enviar un artículo por email**\n\n'
            'Puedes reenviar un artículo (con el PDF adjunto) a la dirección de ingesta de '
            'PrionVault. La app lo procesa por completo y te responde con un email HTML '
            'que confirma cada paso e incluye el resumen de la IA.\n\n'

            '**Qué hace con un artículo nuevo**\n'
            'Tras añadirlo, ejecuta automáticamente (cada paso es independiente):\n'
            '1. **Código PMID** — lo busca en PubMed a partir del DOI si falta.\n'
            '2. **Abstract de PubMed** — lo descarga una vez tiene el PMID.\n'
            '3. **PDF buscable** — le añade la capa de texto (OCR si hace falta).\n'
            '4. **Resumen con IA** — lo genera (Claude por defecto).\n'
            '5. **Indexado por Voyage** — vectoriza texto + abstract + resumen.\n\n'

            '**Si el artículo ya estaba en PrionVault**\n'
            'No lo duplica: comprueba que esté completo y **completa solo lo que falte** '
            '(buscable, indexado, resumen si no lo tenía). El email de respuesta lo indica '
            'con un aviso morado ("ya estaba en PrionVault") e **incluye igualmente el resumen**.\n\n'

            '**El email de confirmación**\n'
            'Llega en formato HTML con: los datos del artículo, una lista de comprobación '
            'con ✅/⏭️/⚠️ por cada paso, el **resumen de la IA incrustado**, un botón '
            '**Ver en PrionVault →** y el **PDF original adjunto**.\n\n'
            '_Nota:_ el remitente debe estar en la lista autorizada del servidor. Si el PDF '
            'es un escaneo sin texto, los pasos de buscable/indexado quedan pendientes del '
            'OCR por lotes y el resto se hace con lo disponible.'
        ),
        'content_en': (
            '**Email an article in**\n\n'
            'You can forward an article (with the PDF attached) to the PrionVault ingest '
            'address. The app fully processes it and replies with an HTML email confirming '
            'each step and including the AI summary.\n\n'

            '**What it does with a new article**\n'
            'After adding it, it automatically runs (each step is independent):\n'
            '1. **PMID** — looks it up on PubMed from the DOI if missing.\n'
            '2. **PubMed abstract** — fetched once a PMID is known.\n'
            '3. **Searchable PDF** — adds the text layer (OCR if needed).\n'
            '4. **AI summary** — generated (Claude by default).\n'
            '5. **Voyage index** — vectorizes text + abstract + summary.\n\n'

            '**If the article was already in PrionVault**\n'
            'It is not duplicated: it verifies the article is complete and **completes only '
            'what is missing** (searchable, indexed, summary if it had none). The reply email '
            'flags it with a purple note ("already in PrionVault") and **still includes the '
            'summary**.\n\n'

            '**The confirmation email**\n'
            'Arrives as HTML with: the article details, a checklist with ✅/⏭️/⚠️ per step, '
            'the **AI summary inline**, a **View in PrionVault →** button, and the '
            '**original PDF attached**.\n\n'
            '_Note:_ the sender must be on the server allowlist. If the PDF is a text-less '
            'scan, the searchable/index steps wait for the batch OCR and the rest is done '
            'with what is available.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-email-ingest',
    },

    'prionvault-govasco-export': {
        'title_es': 'Exportar referencias en formato Gobierno Vasco (con cuartil SCImago)',
        'title_en': 'Export references in Basque Government format (with SCImago quartile)',
        'excerpt_es': 'Genera el Word de justificación del Gobierno Vasco y rellena el cuartil automáticamente con SCImago (SJR).',
        'excerpt_en': 'Generate the Basque Government justification Word and auto-fill the quartile with SCImago (SJR).',
        'content_es': (
            '**Exportar en formato Gobierno Vasco**\n\n'
            'En el listado de PrionVault, abre **Miscelánea → 📄 Exportar referencias**. '
            'Junto al botón normal verás **🏛 Formato Gobierno Vasco**, que genera un Word '
            'con el diseño que pide la justificación: Authors / Title / Name of journal / '
            'Volume · Initial pag · Final pag · Year / Quality indicators.\n\n'

            '- Se exportan las **referencias visibles** en el listado (aplica antes los '
            'filtros que quieras).\n'
            '- El **autor marcado** (campo "Autor marcado" del modal) sale en **negrita**; '
            'los autores se separan por comas y con «and»/«y» antes del último.\n'
            '- Los campos que PrionVault no almacena (páginas, volumen…) se dejan **vacíos** '
            'para completarlos a mano si hace falta.\n\n'

            '**Idioma de las etiquetas**\n'
            'Por defecto las etiquetas van en **inglés** (como pide el formulario). Activa '
            'la casilla **Etiquetas en español** para generarlas en español '
            '(Autores, Título, Nombre de la revista, Volumen, Cuartil, etc.).\n\n'

            '**Cuartil automático con SCImago (SJR)**\n'
            'El indicador de calidad se rellena solo a partir de los datos de SCImago:\n'
            '1. Descarga el CSV anual (gratis) en scimagojr.com → «Download data» '
            '(un fichero por año).\n'
            '2. En **Miscelánea → 🏆 Rankings SCImago (cuartiles)**, indica el **año**, '
            'sube el **CSV** y pulsa **Importar**. Se procesa en segundo plano; puedes '
            'ver el progreso y los años ya importados (y borrarlos).\n'
            '3. Al exportar, para cada artículo se busca la revista **por su nombre** y el '
            'año más cercano (no posterior) al del artículo. Se elige **el mejor cuartil** '
            '(Q1 es mejor que Q2…) y se indica **la categoría entre paréntesis**, por '
            'ejemplo: `Cuartil: Q1 (Cellular and Molecular Neuroscience)`. La base de datos '
            'se rellena como **SCImago (SJR)**.\n\n'
            'Si la revista no está en los datos importados, el cuartil se deja vacío.\n\n'

            '**Notas**\n'
            '- Importa el/los **años** que necesites antes de exportar (p. ej. el CSV de '
            '2022 para publicaciones de 2022).\n'
            '- SCImago da **cuartiles** (Q1–Q4), no deciles ni percentiles: el «D1» y el '
            'percentil exacto solo están en el JCR (Web of Science), que es de pago.\n'
            '- El cruce es por **nombre de revista** (PrionVault no guarda ISSN), así que '
            'funciona mejor con nombres completos que con abreviaturas.'
        ),
        'content_en': (
            '**Export in Basque Government format**\n\n'
            'In the PrionVault list, open **Miscellaneous → 📄 Export references**. Next to '
            'the normal button you will see **🏛 Basque Government format**, which builds a '
            'Word with the layout the justification requires: Authors / Title / Name of '
            'journal / Volume · Initial pag · Final pag · Year / Quality indicators.\n\n'

            '- It exports the **visible references** in the list (apply your filters first).\n'
            '- The **marked author** (the modal\'s "Marked author" field) appears in **bold**; '
            'authors are comma-separated with "and"/"y" before the last one.\n'
            '- Fields PrionVault does not store (pages, volume…) are left **blank** to fill '
            'in by hand if needed.\n\n'

            '**Label language**\n'
            'Labels default to **English** (as the form requires). Tick **Etiquetas en '
            'español** to generate them in Spanish.\n\n'

            '**Automatic quartile with SCImago (SJR)**\n'
            'The quality indicator is auto-filled from SCImago data:\n'
            '1. Download the yearly CSV (free) at scimagojr.com → "Download data" '
            '(one file per year).\n'
            '2. In **Miscellaneous → 🏆 SCImago rankings**, enter the **year**, upload the '
            '**CSV** and click **Import**. It runs in the background; you can watch progress '
            'and see/delete imported years.\n'
            '3. On export, each article\'s journal is matched **by name** for the year '
            'closest to (not after) the article\'s year. The **best quartile** is chosen '
            '(Q1 beats Q2…) with **the category in parentheses**, e.g. '
            '`Cuartil: Q1 (Cellular and Molecular Neuroscience)`. The database is filled as '
            '**SCImago (SJR)**.\n\n'
            'If the journal is not in the imported data, the quartile is left blank.\n\n'

            '**Notes**\n'
            '- Import the **year(s)** you need before exporting (e.g. the 2022 CSV for 2022 '
            'papers).\n'
            '- SCImago provides **quartiles** (Q1–Q4), not deciles/percentiles: "D1" and the '
            'exact percentile only exist in JCR (Web of Science), which is paid.\n'
            '- Matching is by **journal name** (PrionVault stores no ISSN), so full names '
            'work better than abbreviations.'
        ),
        'page_context': 'prionvault',
        'difficulty_level': 'intermediate',
        'category': {'name': 'PrionVault', 'icon': '📚'},
        'slug': 'prionvault-govasco-export',
    },

}

# ── Quick tips per page context ───────────────────────────────────────────────

_QUICK_TIPS = {
    'es': {
        'dashboard': [
            '💡 Usa el buscador global para encontrar cualquier manuscrito o referencia rápidamente.',
            '📊 Haz clic en las métricas del panel para ver el análisis detallado.',
            '🔔 Revisa las notificaciones para estar al día de actualizaciones importantes.',
        ],
        'manuscript_forge': [
            '📎 Arrastra archivos PDF o BibTeX directamente sobre la lista de referencias para importarlos.',
            '🔄 Usa el botón ORCID para sincronizar tus publicaciones automáticamente.',
            '💾 Los cambios se guardan automáticamente — no necesitas guardar manualmente.',
        ],
        'manuscriptforge': [
            '📎 Arrastra archivos PDF o BibTeX directamente sobre la lista de referencias para importarlos.',
            '🔄 Usa el botón ORCID para sincronizar tus publicaciones automáticamente.',
            '💾 Los cambios se guardan automáticamente — no necesitas guardar manualmente.',
        ],
        'ai_assistant': [
            '🎯 Sé específico: indica qué sección quieres revisar y qué aspecto mejorar.',
            '📄 Puedes pegar texto directamente en el chat para obtener feedback.',
            '🧠 El asistente recuerda el contexto de tu manuscrito activo.',
        ],
        'methods': [
            '🔍 Filtra por categoría para encontrar métodos de tu disciplina específica.',
            '➕ Haz clic en "Añadir al manuscrito" para insertar un método directamente.',
        ],
        'analytics': [
            '📈 Compara tu evolución anual usando el selector de rango de fechas.',
            '🌐 Los datos de citas se actualizan cada 24h desde CrossRef y ORCID.',
        ],
        'prionvault': [
            '🔍 El RAG responde solo con evidencia de tu biblioteca — si dice "no sé", es que el tema no está cubierto todavía.',
            '✦ Los badges de color en cada artículo indican qué IA generó el resumen (Claude violeta, GPT verde, Gemini azul).',
            '📊 Abre _Salud de la biblioteca_ para ver de un vistazo cuántos artículos faltan de indexar, resumir o verificar.',
            '✗ Si ves un badge _Mismatch_ rojo, clícalo para abrir el editor y resolver la discrepancia del PDF.',
            '💡 Los resúmenes IA se usan también en las búsquedas RAG, no solo para leer — más resúmenes = mejores respuestas.',
            '🔁 El batch de resúmenes es reanudable: si lo paras o el servidor se reinicia, continúa desde donde lo dejó.',
        ],
    },
    'en': {
        'dashboard': [
            '💡 Use the global search to find any manuscript or reference quickly.',
            '📊 Click on panel metrics to see detailed analysis.',
            '🔔 Check notifications to stay up to date on important updates.',
        ],
        'manuscript_forge': [
            '📎 Drag PDF or BibTeX files directly onto the reference list to import them.',
            '🔄 Use the ORCID button to sync your publications automatically.',
            '💾 Changes are saved automatically — no need to save manually.',
        ],
        'manuscriptforge': [
            '📎 Drag PDF or BibTeX files directly onto the reference list to import them.',
            '🔄 Use the ORCID button to sync your publications automatically.',
            '💾 Changes are saved automatically — no need to save manually.',
        ],
        'ai_assistant': [
            '🎯 Be specific: tell it which section to review and what aspect to improve.',
            '📄 You can paste text directly in the chat to get feedback.',
            '🧠 The assistant remembers the context of your active manuscript.',
        ],
        'methods': [
            '🔍 Filter by category to find methods from your specific discipline.',
            '➕ Click "Add to manuscript" to insert a method directly.',
        ],
        'analytics': [
            '📈 Compare your annual evolution using the date range selector.',
            '🌐 Citation data updates every 24h from CrossRef and ORCID.',
        ],
        'prionvault': [
            '🔍 RAG only answers from your library — if it says "I don\'t know", the topic isn\'t covered yet.',
            '✦ Colour badges on each article show which AI generated the summary (Claude purple, GPT green, Gemini blue).',
            '📊 Open _Library health_ to see at a glance how many articles still need indexing, summarising or verifying.',
            '✗ If you see a red _Mismatch_ badge, click it to open the editor and resolve the PDF discrepancy.',
            '💡 AI summaries are also used in RAG searches, not just for reading — more summaries = better answers.',
            '🔁 The summary batch is resumable: if you stop it or the server restarts, it continues from where it left off.',
        ],
    },
}

# ── Suggested actions per page context ────────────────────────────────────────

_SUGGESTED_ACTIONS = {
    'es': {
        'dashboard': [
            {'icon': '📝', 'title': 'Crear nuevo manuscrito', 'description': 'Empieza un nuevo proyecto de investigación'},
            {'icon': '📚', 'title': 'Importar referencias', 'description': 'Añade referencias desde ORCID o archivo BibTeX'},
        ],
        'manuscript_forge': [
            {'icon': '🔄', 'title': 'Sincronizar con ORCID', 'description': 'Actualiza tus publicaciones automáticamente'},
            {'icon': '📋', 'title': 'Generar bibliografía', 'description': 'Crea la bibliografía en el formato deseado'},
        ],
        'ai_assistant': [
            {'icon': '✏️', 'title': 'Revisar sección', 'description': 'Pide al asistente que revise una sección'},
            {'icon': '🔍', 'title': 'Buscar referencias', 'description': 'Encuentra artículos relevantes por tema'},
        ],
    },
    'en': {
        'dashboard': [
            {'icon': '📝', 'title': 'Create new manuscript', 'description': 'Start a new research project'},
            {'icon': '📚', 'title': 'Import references', 'description': 'Add references from ORCID or BibTeX file'},
        ],
        'manuscript_forge': [
            {'icon': '🔄', 'title': 'Sync with ORCID', 'description': 'Update your publications automatically'},
            {'icon': '📋', 'title': 'Generate bibliography', 'description': 'Create bibliography in desired format'},
        ],
        'ai_assistant': [
            {'icon': '✏️', 'title': 'Review section', 'description': 'Ask the assistant to review a section'},
            {'icon': '🔍', 'title': 'Search references', 'description': 'Find relevant articles by topic'},
        ],
    },
}

# ── Interactive tutorials ─────────────────────────────────────────────────────

_TUTORIALS = [
    {
        'id': 'welcome-tour',
        'title_es': 'Bienvenido a PrionLab Tools',
        'title_en': 'Welcome to PrionLab Tools',
        'description_es': 'Un recorrido rápido por las funcionalidades principales',
        'description_en': 'A quick tour of the main features',
        'icon': '🎯',
        'duration': '5 min',
        'difficulty': 'beginner',
        'steps': [
            {
                'title_es': 'Bienvenido',
                'title_en': 'Welcome',
                'body_es': 'PrionLab Tools es una plataforma integral para investigadores. Te ayuda a gestionar manuscritos, referencias, métodos y análisis en un solo lugar.',
                'body_en': 'PrionLab Tools is a comprehensive platform for researchers. It helps you manage manuscripts, references, methods and analysis in one place.',
            },
            {
                'title_es': 'El Panel Principal',
                'title_en': 'The Dashboard',
                'body_es': 'El Dashboard es tu centro de operaciones. Desde aquí puedes ver todos tus proyectos activos, métricas de actividad y acceder a cualquier herramienta con un clic.',
                'body_en': 'The Dashboard is your operations center. From here you can see all your active projects, activity metrics, and access any tool with one click.',
            },
            {
                'title_es': 'ManuscriptForge',
                'title_en': 'ManuscriptForge',
                'body_es': 'ManuscriptForge es tu editor de manuscritos con gestión integrada de referencias. Importa referencias por DOI, ORCID o BibTeX y genera bibliografías automáticamente.',
                'body_en': 'ManuscriptForge is your manuscript editor with integrated reference management. Import references by DOI, ORCID or BibTeX and generate bibliographies automatically.',
            },
            {
                'title_es': 'Asistente IA',
                'title_en': 'AI Assistant',
                'body_es': 'El Asistente IA te ayuda a redactar, revisar y mejorar tu investigación. Puedes pedirle que revise secciones, busque referencias relacionadas o genere hipótesis.',
                'body_en': 'The AI Assistant helps you write, review and improve your research. You can ask it to review sections, find related references or generate hypotheses.',
            },
            {
                'title_es': '¡Listo para empezar!',
                'title_en': 'Ready to Start!',
                'body_es': 'Ya conoces las bases de PrionLab Tools. Ve al Dashboard y crea tu primer manuscrito. El panel de ayuda siempre está disponible haciendo clic en el botón "?" en la esquina inferior derecha.',
                'body_en': 'You now know the basics of PrionLab Tools. Go to the Dashboard and create your first manuscript. The help panel is always available by clicking the "?" button in the bottom right corner.',
            },
        ],
    },
    {
        'id': 'manuscript-basics',
        'title_es': 'ManuscriptForge: Lo Esencial',
        'title_en': 'ManuscriptForge: The Essentials',
        'description_es': 'Aprende a crear y gestionar manuscritos con referencias',
        'description_en': 'Learn to create and manage manuscripts with references',
        'icon': '📝',
        'duration': '10 min',
        'difficulty': 'beginner',
        'steps': [
            {
                'title_es': 'Crear un manuscrito',
                'title_en': 'Create a manuscript',
                'body_es': 'Desde el Dashboard, haz clic en "Nuevo Manuscrito". Introduce el título y selecciona el tipo de artículo (original, revisión, caso clínico, etc.).',
                'body_en': 'From the Dashboard, click "New Manuscript". Enter the title and select the article type (original, review, case report, etc.).',
            },
            {
                'title_es': 'Importar referencias',
                'title_en': 'Import references',
                'body_es': 'En la pestaña Referencias, puedes importar por DOI (introduce el DOI y pulsa Enter), por archivo BibTeX (arrastra el archivo) o sincronizando con ORCID.',
                'body_en': 'In the References tab, you can import by DOI (enter the DOI and press Enter), by BibTeX file (drag the file) or by syncing with ORCID.',
            },
            {
                'title_es': 'Citar en el texto',
                'title_en': 'Cite in the text',
                'body_es': 'Coloca el cursor donde quieras insertar una cita, luego selecciona la referencia deseada en el panel y haz clic en "Insertar cita". La referencia se añadirá automáticamente a la bibliografía.',
                'body_en': 'Place the cursor where you want to insert a citation, then select the desired reference in the panel and click "Insert citation". The reference will be automatically added to the bibliography.',
            },
            {
                'title_es': 'Generar bibliografía',
                'title_en': 'Generate bibliography',
                'body_es': 'Ve a la pestaña Bibliografía y selecciona el estilo de cita (APA, Vancouver, IEEE, etc.). La bibliografía se genera automáticamente a partir de las citas usadas en el texto.',
                'body_en': 'Go to the Bibliography tab and select the citation style (APA, Vancouver, IEEE, etc.). The bibliography is generated automatically from the citations used in the text.',
            },
            {
                'title_es': 'Exportar el manuscrito',
                'title_en': 'Export the manuscript',
                'body_es': 'Cuando termines, ve a Exportar y selecciona el formato: Word para la mayoría de revistas, LaTeX para Nature/Science, o PDF para previsualización.',
                'body_en': 'When finished, go to Export and select the format: Word for most journals, LaTeX for Nature/Science, or PDF for preview.',
            },
            {
                'title_es': '¡Manuscrito listo!',
                'title_en': 'Manuscript ready!',
                'body_es': 'Has completado el flujo básico de ManuscriptForge. Explora las funcionalidades avanzadas como la búsqueda semántica de referencias y el análisis de similaridad con otros artículos.',
                'body_en': 'You have completed the basic ManuscriptForge workflow. Explore advanced features like semantic reference search and similarity analysis with other articles.',
            },
        ],
    },
    {
        'id': 'ai-assistant-guide',
        'title_es': 'Domina el Asistente IA',
        'title_en': 'Master the AI Assistant',
        'description_es': 'Saca el máximo partido al Asistente IA',
        'description_en': 'Get the most out of the AI Assistant',
        'icon': '🤖',
        'duration': '8 min',
        'difficulty': 'intermediate',
        'steps': [
            {
                'title_es': 'El chat del asistente',
                'title_en': 'The assistant chat',
                'body_es': 'El Asistente IA usa el contexto de tu manuscrito activo. Puedes hacerle preguntas, pedirle revisiones o solicitar ayuda con cualquier aspecto de tu investigación.',
                'body_en': 'The AI Assistant uses the context of your active manuscript. You can ask it questions, request reviews or ask for help with any aspect of your research.',
            },
            {
                'title_es': 'Revisar secciones',
                'title_en': 'Review sections',
                'body_es': 'Para revisar una sección específica, selecciona el texto en el editor y haz clic en "Revisar con IA". El asistente analizará el texto y sugerirá mejoras de claridad, coherencia y estilo.',
                'body_en': 'To review a specific section, select the text in the editor and click "Review with AI". The assistant will analyze the text and suggest clarity, coherence and style improvements.',
            },
            {
                'title_es': 'Buscar referencias relevantes',
                'title_en': 'Find relevant references',
                'body_es': 'Escribe una pregunta de investigación o concepto clave en el chat. El asistente buscará en tu biblioteca y en bases de datos externas para sugerirte las referencias más relevantes.',
                'body_en': 'Type a research question or key concept in the chat. The assistant will search your library and external databases to suggest the most relevant references.',
            },
            {
                'title_es': 'Generar texto de apoyo',
                'title_en': 'Generate supporting text',
                'body_es': 'Pide al asistente que genere un párrafo de introducción, una descripción de metodología o el texto de una figura. Siempre revisa y adapta el texto generado a tu voz científica.',
                'body_en': 'Ask the assistant to generate an introduction paragraph, a methodology description or figure text. Always review and adapt the generated text to your scientific voice.',
            },
            {
                'title_es': 'Mejores prácticas',
                'title_en': 'Best practices',
                'body_es': 'Para mejores resultados: (1) Sé específico en tus peticiones. (2) Indica el nivel de detalle que necesitas. (3) Proporciona contexto sobre tu campo de investigación. El asistente aprende de tus correcciones.',
                'body_en': 'For best results: (1) Be specific in your requests. (2) State the level of detail you need. (3) Provide context about your research field. The assistant learns from your corrections.',
            },
        ],
    },
    {
        'id': 'analytics-mastery',
        'title_es': 'Analytics: Mide tu Impacto',
        'title_en': 'Analytics: Measure Your Impact',
        'description_es': 'Analiza y visualiza el impacto de tu investigación',
        'description_en': 'Analyze and visualize your research impact',
        'icon': '📊',
        'duration': '12 min',
        'difficulty': 'advanced',
        'steps': [
            {
                'title_es': 'Panel de métricas',
                'title_en': 'Metrics panel',
                'body_es': 'El panel de Analytics muestra tus métricas de impacto actualizadas: Factor H, citas totales, publicaciones por año y tendencias. Los datos se sincronizan con ORCID y CrossRef.',
                'body_en': 'The Analytics panel shows your updated impact metrics: H-Index, total citations, publications per year and trends. Data syncs with ORCID and CrossRef.',
            },
            {
                'title_es': 'Análisis de tendencias',
                'title_en': 'Trend analysis',
                'body_es': 'Usa el selector de rango de fechas para analizar la evolución de tus citas. Puedes comparar períodos y ver qué publicaciones han tenido mayor impacto en cada etapa de tu carrera.',
                'body_en': 'Use the date range selector to analyze your citation evolution. You can compare periods and see which publications had the most impact at each stage of your career.',
            },
            {
                'title_es': 'Red de colaboradores',
                'title_en': 'Collaborator network',
                'body_es': 'La visualización de red muestra tus coautores y las conexiones entre ellos. El tamaño de cada nodo indica el número de publicaciones conjuntas. Haz clic en un nodo para ver el perfil del investigador.',
                'body_en': 'The network visualization shows your co-authors and connections between them. Node size indicates the number of joint publications. Click a node to see the researcher profile.',
            },
            {
                'title_es': 'Exportar informes',
                'title_en': 'Export reports',
                'body_es': 'Genera informes de impacto en PDF o Excel para incluir en solicitudes de becas, promociones o evaluaciones. Los informes incluyen todas las métricas y gráficas de visualización.',
                'body_en': 'Generate impact reports in PDF or Excel to include in grant applications, promotions or evaluations. Reports include all metrics and visualization charts.',
            },
            {
                'title_es': 'Configurar alertas',
                'title_en': 'Set up alerts',
                'body_es': 'En Configuración de Analytics, activa las alertas automáticas para recibir notificaciones cuando alguna de tus publicaciones reciba nuevas citas o cuando tu Factor H aumente.',
                'body_en': 'In Analytics Settings, enable automatic alerts to receive notifications when any of your publications receives new citations or when your H-Index increases.',
            },
        ],
    },
]

# ── Helper: search builtin articles ──────────────────────────────────────────

def _search_builtin(query, lang):
    q = query.lower()
    results = []
    for slug, art in _BUILTIN_ARTICLES.items():
        title = art.get('title_' + lang, art.get('title_es', ''))
        excerpt = art.get('excerpt_' + lang, art.get('excerpt_es', ''))
        content = art.get('content_' + lang, art.get('content_es', ''))
        score = 0
        if q in title.lower():
            score += 10
        if q in excerpt.lower():
            score += 5
        if q in content.lower():
            score += 1
        if score == 0:
            continue
        # Extract snippet around the match
        snippet = ''
        idx = content.lower().find(q)
        if idx >= 0:
            start = max(0, idx - 40)
            end = min(len(content), idx + len(q) + 60)
            snippet = content[start:end].replace('\n', ' ').strip()
        results.append({
            'slug': slug,
            'title': title,
            'excerpt': excerpt,
            'snippet': snippet,
            'category': art.get('category', {}),
            'difficulty': art.get('difficulty_level', 'beginner'),
            'page_context': art.get('page_context', ''),
            'relevance_score': score,
        })
    results.sort(key=lambda x: x['relevance_score'], reverse=True)
    return results


# ── Routes ────────────────────────────────────────────────────────────────────

@help_bp.route('/')
@login_required
def center():
    lang = session.get('language', 'es')
    q = request.args.get('q', '').strip()

    search_results = []
    if q:
        search_results = _search_builtin(q, lang)

    # Featured articles (first 6 from builtin)
    featured = []
    for slug, art in list(_BUILTIN_ARTICLES.items())[:6]:
        featured.append({
            'slug': slug,
            'title': art.get('title_' + lang, art.get('title_es', '')),
            'excerpt': art.get('excerpt_' + lang, art.get('excerpt_es', '')),
            'difficulty': art.get('difficulty_level', 'beginner'),
            'category': art.get('category', {'name': '', 'icon': '📄'}),
        })

    # Categories (synthetic from builtin data)
    cat_map = {}
    for slug, art in _BUILTIN_ARTICLES.items():
        ctx = art.get('page_context', 'general')
        cat = art.get('category', {})
        if ctx not in cat_map:
            cat_map[ctx] = {
                'id': ctx,
                'icon': cat.get('icon', '📄'),
                'name': cat.get('name', ctx.replace('_', ' ').title()),
                'description': '',
                'article_count': 0,
            }
        cat_map[ctx]['article_count'] += 1

    categories = list(cat_map.values())

    return render_template(
        'help/center.html',
        search_query=q,
        search_results=search_results,
        featured_articles=featured,
        categories=categories,
        page_context='help',
    )


@help_bp.route('/api/contextual')
@login_required
def api_contextual():
    lang = session.get('language', 'es')
    page = request.args.get('page', '').strip()

    # Filter articles by page context
    articles = []
    for slug, art in _BUILTIN_ARTICLES.items():
        ctx = art.get('page_context', '')
        if not page or ctx == page or ctx in page or page in ctx:
            articles.append({
                'slug': slug,
                'title': art.get('title_' + lang, art.get('title_es', '')),
                'excerpt': art.get('excerpt_' + lang, art.get('excerpt_es', '')),
                'difficulty': art.get('difficulty_level', 'beginner'),
                'category': art.get('category', {}),
            })

    tips = _QUICK_TIPS.get(lang, {}).get(page, [])
    actions = _SUGGESTED_ACTIONS.get(lang, {}).get(page, [])

    return jsonify({
        'articles': articles[:5],
        'tips': tips,
        'actions': actions,
    })


@help_bp.route('/api/search')
@login_required
def api_search():
    lang = session.get('language', 'es')
    q = request.args.get('q', '').strip()
    if not q or len(q) < 2:
        return jsonify([])
    return jsonify(_search_builtin(q, lang))


@help_bp.route('/api/article/<slug>')
@login_required
def api_article(slug):
    lang = session.get('language', 'es')
    art = _BUILTIN_ARTICLES.get(slug)
    if not art:
        return jsonify(None), 404

    # Try to increment DB view count — silently skip if DB unavailable
    try:
        from database.config import db
        from database.help_system import HelpArticle
        with db.get_session() as s:
            db_art = s.query(HelpArticle).filter_by(slug=slug).first()
            if db_art:
                db_art.view_count = (db_art.view_count or 0) + 1
    except Exception:
        pass

    # Related articles (same page_context, different slug)
    ctx = art.get('page_context', '')
    related = []
    for s2, a2 in _BUILTIN_ARTICLES.items():
        if s2 != slug and a2.get('page_context') == ctx:
            related.append({
                'slug': s2,
                'title': a2.get('title_' + lang, a2.get('title_es', '')),
            })

    return jsonify({
        'slug': slug,
        'title': art.get('title_' + lang, art.get('title_es', '')),
        'excerpt': art.get('excerpt_' + lang, art.get('excerpt_es', '')),
        'content': art.get('content_' + lang, art.get('content_es', '')),
        'difficulty': art.get('difficulty_level', 'beginner'),
        'category': art.get('category', {}),
        'tags': [],
        'related_articles': related[:3],
        'page_context': ctx,
    })


@help_bp.route('/api/tutorials')
@login_required
def api_tutorials():
    lang = session.get('language', 'es')
    user_id = session.get('user_id', 0)

    result = []
    for t in _TUTORIALS:
        progress = {'completed_steps': 0, 'total_steps': len(t['steps']), 'completed': False, 'percentage': 0}

        # Try to load progress from DB
        try:
            from database.config import db
            from database.help_system import HelpUserProgress
            with db.get_session() as s:
                rec = s.query(HelpUserProgress).filter_by(
                    user_id=user_id, tutorial_id=t['id']
                ).first()
                if rec:
                    progress = {
                        'completed_steps': rec.step_completed,
                        'total_steps': rec.total_steps,
                        'completed': rec.completed,
                        'percentage': int(rec.step_completed / max(rec.total_steps, 1) * 100),
                    }
        except Exception:
            pass

        result.append({
            'id': t['id'],
            'title': t.get('title_' + lang, t.get('title_es', '')),
            'description': t.get('description_' + lang, t.get('description_es', '')),
            'icon': t['icon'],
            'duration': t['duration'],
            'difficulty': t['difficulty'],
            'steps': [
                {
                    'title_es': step['title_es'],
                    'title_en': step['title_en'],
                    'body_es': step['body_es'],
                    'body_en': step['body_en'],
                }
                for step in t['steps']
            ],
            'progress': progress,
        })

    return jsonify(result)


@help_bp.route('/api/tutorial/progress', methods=['POST'])
@login_required
def api_tutorial_progress():
    data = request.get_json(silent=True) or {}
    tutorial_id = data.get('tutorial_id', '')
    step = int(data.get('step', 0))
    total = int(data.get('total', 1))
    user_id = session.get('user_id', 0)

    try:
        from database.config import db
        from database.help_system import HelpUserProgress
        from datetime import datetime, timezone
        with db.get_session() as s:
            rec = s.query(HelpUserProgress).filter_by(
                user_id=user_id, tutorial_id=tutorial_id
            ).first()
            if rec:
                rec.step_completed = step
                rec.total_steps = total
                rec.completed = (step >= total)
                rec.updated_at = datetime.now(timezone.utc)
            else:
                s.add(HelpUserProgress(
                    user_id=user_id,
                    tutorial_id=tutorial_id,
                    step_completed=step,
                    total_steps=total,
                    completed=(step >= total),
                ))
    except Exception as e:
        logger.debug('Help progress DB save skipped: %s', e)

    return jsonify({'ok': True})


@help_bp.route('/api/feedback', methods=['POST'])
@login_required
def api_feedback():
    data = request.get_json(silent=True) or {}
    slug = data.get('slug', '')
    rating = int(data.get('rating', 0))
    is_helpful = data.get('is_helpful')
    text = data.get('text', '')
    user_id = session.get('user_id', 0)

    try:
        from database.config import db
        from database.help_system import HelpFeedback
        with db.get_session() as s:
            s.add(HelpFeedback(
                user_id=user_id,
                rating=rating,
                is_helpful=is_helpful,
                feedback_text=text,
            ))
    except Exception as e:
        logger.debug('Help feedback DB save skipped: %s', e)

    return jsonify({'ok': True})
