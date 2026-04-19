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
