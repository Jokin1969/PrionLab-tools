/* Comprehensive Help System — PrionLab Tools */
(function () {
  'use strict';

  var LANG = document.documentElement.lang || 'es';
  var PAGE_CTX = '';
  var _tutorialsLoaded = false;
  var _categoriesLoaded = false;
  var _activeTutorial = null;
  var _activeTutorialStep = 0;
  var _prevTabContent = null;
  var _prevTab = 'contextual';

  /* ── DOM helpers ─────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return (root || document).querySelectorAll(sel); }
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function renderMarkdown(text) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }
  function diffBadge(level) {
    var labels = {
      beginner: {es:'Principiante',en:'Beginner'},
      intermediate: {es:'Intermedio',en:'Intermediate'},
      advanced: {es:'Avanzado',en:'Advanced'}
    };
    var l = level || 'beginner';
    var label = (labels[l] || labels.beginner)[LANG] || l;
    return '<span class="hs-badge hs-badge--' + l + '">' + esc(label) + '</span>';
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  /* ── API fetch helpers ───────────────────────────────────────────────── */
  function apiGet(url, cb) {
    fetch(url, {credentials:'same-origin'})
      .then(function(r){ return r.json(); })
      .then(cb)
      .catch(function(e){ console.warn('Help API error:', e); });
  }
  function apiPost(url, data, cb) {
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(data)
    })
      .then(function(r){ return r.json(); })
      .then(cb || function(){})
      .catch(function(e){ console.warn('Help API error:', e); });
  }

  /* ── Panel open / close ──────────────────────────────────────────────── */
  function openPanel(tab) {
    var panel = $('hs-panel');
    var toggle = $('hs-toggle');
    if (!panel) return;
    panel.classList.add('hs-open');
    if (toggle) { toggle.setAttribute('aria-expanded', 'true'); }
    if (!localStorage.getItem('hs_opened')) {
      localStorage.setItem('hs_opened', '1');
      if (toggle) toggle.classList.remove('hs-pulse');
    }
    if (tab) switchTab(tab);
    else { loadContextual(PAGE_CTX); }
  }
  function closePanel() {
    var panel = $('hs-panel');
    var toggle = $('hs-toggle');
    if (!panel) return;
    panel.classList.remove('hs-open');
    if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
  }

  /* ── Tabs ────────────────────────────────────────────────────────────── */
  function switchTab(name) {
    qsa('.hs-tab').forEach(function(t) {
      var active = t.dataset.tab === name;
      t.classList.toggle('hs-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    qsa('.hs-tab-pane').forEach(function(p) {
      p.classList.toggle('hs-active', p.id === 'hs-pane-' + name);
    });
    if (name === 'tutorials' && !_tutorialsLoaded) loadTutorials();
    if (name === 'browse' && !_categoriesLoaded) loadCategories();
    if (name === 'contextual') loadContextual(PAGE_CTX);
  }

  /* ── Contextual help ─────────────────────────────────────────────────── */
  function loadContextual(ctx) {
    if (!ctx) return;
    apiGet('/help/api/contextual?page=' + encodeURIComponent(ctx), function(data) {
      renderTips(data.tips || []);
      renderArticles(data.articles || []);
      renderActions(data.actions || []);
    });
  }
  function renderTips(tips) {
    var el = $('hs-tips'); if (!el) return;
    if (!tips.length) { el.innerHTML = ''; return; }
    el.innerHTML = tips.map(function(t) {
      return '<div class="hs-tip">' + esc(t) + '</div>';
    }).join('');
  }
  function renderArticles(articles) {
    var el = $('hs-articles'); if (!el) return;
    if (!articles.length) {
      el.innerHTML = '<p class="hs-empty-msg">' + (LANG==='es'?'No hay artículos para esta página.':'No articles for this page.') + '</p>';
      return;
    }
    el.innerHTML = articles.map(function(a) {
      return '<div class="hs-article-card" data-slug="' + esc(a.slug) + '">'
        + '<div class="hs-article-title">' + esc(a.title) + '</div>'
        + '<div class="hs-article-excerpt">' + esc(a.excerpt || '') + '</div>'
        + '<div class="hs-article-meta">' + diffBadge(a.difficulty) + '</div>'
        + '</div>';
    }).join('');
    el.querySelectorAll('.hs-article-card').forEach(function(card) {
      card.addEventListener('click', function() { showArticle(card.dataset.slug); });
    });
  }
  function renderActions(actions) {
    var el = $('hs-actions'); if (!el) return;
    if (!actions.length) { el.innerHTML = ''; return; }
    el.innerHTML = actions.map(function(a) {
      return '<div class="hs-action-item">'
        + '<div class="hs-action-icon">' + esc(a.icon || '🔗') + '</div>'
        + '<div class="hs-action-body">'
        + '<div class="hs-action-title">' + esc(a.title) + '</div>'
        + '<div class="hs-action-desc">' + esc(a.description || '') + '</div>'
        + '</div></div>';
    }).join('');
  }

  /* ── Article detail ──────────────────────────────────────────────────── */
  function showArticle(slug) {
    apiGet('/help/api/article/' + encodeURIComponent(slug), function(art) {
      if (!art) return;
      var pane = $('hs-pane-contextual'); if (!pane) return;
      _prevTabContent = pane.innerHTML;
      var html = '<button class="hs-back-btn" id="hs-back">&#8592; ' + (LANG==='es'?'Volver':'Back') + '</button>'
        + '<h4 class="hs-article-detail-title">' + esc(art.title) + '</h4>'
        + '<div class="hs-article-meta" style="margin-bottom:.75rem">' + diffBadge(art.difficulty)
        + (art.category ? ' <span class="hs-cat-chip">' + esc(art.category.name) + '</span>' : '') + '</div>'
        + '<div class="hs-article-detail-content"><p>' + renderMarkdown(art.content) + '</p></div>';
      if (art.related_articles && art.related_articles.length) {
        html += '<div class="hs-section-title" style="margin-top:1rem">' + (LANG==='es'?'Artículos relacionados':'Related articles') + '</div>';
        html += art.related_articles.map(function(r) {
          return '<div class="hs-article-card" data-slug="' + esc(r.slug) + '">'
            + '<div class="hs-article-title">' + esc(r.title) + '</div>'
            + '</div>';
        }).join('');
      }
      pane.innerHTML = html;
      var backBtn = $('hs-back');
      if (backBtn) {
        backBtn.addEventListener('click', function() {
          if (_prevTabContent) { pane.innerHTML = _prevTabContent; _prevTabContent = null; }
          else { loadContextual(PAGE_CTX); }
        });
      }
      pane.querySelectorAll('.hs-article-card').forEach(function(card) {
        card.addEventListener('click', function() { showArticle(card.dataset.slug); });
      });
    });
  }

  /* ── Tutorials ───────────────────────────────────────────────────────── */
  function loadTutorials() {
    apiGet('/help/api/tutorials', function(tutorials) {
      _tutorialsLoaded = true;
      var el = $('hs-tutorials'); if (!el) return;
      if (!tutorials.length) {
        el.innerHTML = '<p class="hs-empty-msg">' + (LANG==='es'?'No hay tutoriales.':'No tutorials available.') + '</p>';
        return;
      }
      el.innerHTML = tutorials.map(function(t) {
        var pct = t.progress ? t.progress.percentage : 0;
        var doneLabel = t.progress && t.progress.completed ? (LANG==='es'?' ✓ Completado':' ✓ Completed') : '';
        return '<div class="hs-tutorial-card" data-id="' + esc(t.id) + '">'
          + '<div class="hs-tutorial-icon">' + esc(t.icon || '📚') + '</div>'
          + '<div class="hs-tutorial-body">'
          + '<div class="hs-tutorial-title">' + esc(t.title) + doneLabel + '</div>'
          + '<div class="hs-tutorial-meta">'
          + '<span>' + esc(t.duration || '') + '</span>'
          + '<span>' + diffBadge(t.difficulty) + '</span>'
          + '</div>'
          + '</div>'
          + '<div class="hs-progress-bar"><div class="hs-progress-fill" style="width:' + pct + '%"></div></div>'
          + '</div>';
      }).join('');
      el.querySelectorAll('.hs-tutorial-card').forEach(function(card, i) {
        card.addEventListener('click', function() { startTutorial(tutorials[i]); });
      });
    });
  }

  function startTutorial(tutorial) {
    _activeTutorial = tutorial;
    _activeTutorialStep = 0;
    var overlay = $('hs-overlay'); if (!overlay) return;
    overlay.classList.add('hs-overlay-open');
    $('hs-tutorial-title').textContent = tutorial.title;
    $('hs-tutorial-total').textContent = tutorial.steps ? tutorial.steps.length : (tutorial.total_steps || 1);
    showTutorialStep(0);
    trapFocus(overlay);
  }
  function showTutorialStep(n) {
    if (!_activeTutorial) return;
    var steps = _activeTutorial.steps || [];
    if (!steps.length) return;
    var step = steps[n] || steps[0];
    var total = steps.length;
    _activeTutorialStep = n;

    $('hs-tutorial-step').textContent = n + 1;
    var pct = ((n + 1) / total) * 100;
    $('hs-tutorial-progress-fill').style.width = pct + '%';

    var title = LANG === 'es' ? (step.title_es || step.title || '') : (step.title_en || step.title || '');
    var body = LANG === 'es' ? (step.body_es || step.body || '') : (step.body_en || step.body || '');
    $('hs-tutorial-body').innerHTML = '<h4 style="margin:0 0 .5rem;font-size:.9rem">' + esc(title) + '</h4>'
      + '<p style="font-size:.84rem;color:#374151;line-height:1.5;margin:0">' + esc(body) + '</p>';

    var prevBtn = $('hs-tutorial-prev');
    var nextBtn = $('hs-tutorial-next');
    if (prevBtn) prevBtn.style.visibility = n === 0 ? 'hidden' : 'visible';
    if (nextBtn) nextBtn.textContent = (n === total - 1)
      ? (LANG === 'es' ? '✓ Finalizar' : '✓ Finish')
      : (LANG === 'es' ? 'Siguiente →' : 'Next →');

    // Save progress
    apiPost('/help/api/tutorial/progress', {
      tutorial_id: _activeTutorial.id,
      step: n + 1,
      total: total
    });
  }
  function closeTutorialOverlay(completed) {
    var overlay = $('hs-overlay');
    if (!overlay) return;
    overlay.classList.remove('hs-overlay-open');
    if (completed) {
      var msg = document.createElement('div');
      msg.className = 'hs-completion-toast';
      msg.textContent = '🎉 ' + (LANG==='es'?'¡Tutorial completado!':'Tutorial complete!');
      document.body.appendChild(msg);
      setTimeout(function() { if (msg.parentNode) msg.parentNode.removeChild(msg); }, 3000);
      _tutorialsLoaded = false; // refresh tutorial list
      loadTutorials();
    }
    _activeTutorial = null;
  }

  /* ── Categories / Browse ─────────────────────────────────────────────── */
  var _BUILT_IN_CATS = [
    {id:'dashboard', icon:'🏠', name_es:'Panel Principal', name_en:'Dashboard', desc_es:'Gestión general', desc_en:'General management', count:3},
    {id:'manuscript_forge', icon:'📝', name_es:'ManuscriptForge', name_en:'ManuscriptForge', desc_es:'Manuscritos y referencias', desc_en:'Manuscripts and references', count:4},
    {id:'methods', icon:'🔬', name_es:'Métodos', name_en:'Methods', desc_es:'Biblioteca de métodos', desc_en:'Methods library', count:2},
    {id:'ai_assistant', icon:'🤖', name_es:'Asistente IA', name_en:'AI Assistant', desc_es:'Ayuda inteligente', desc_en:'Intelligent assistance', count:3},
    {id:'analytics', icon:'📊', name_es:'Analytics', name_en:'Analytics', desc_es:'Métricas e impacto', desc_en:'Metrics and impact', count:3},
    {id:'references', icon:'📚', name_es:'Referencias', name_en:'References', desc_es:'Gestión de referencias', desc_en:'Reference management', count:4},
    {id:'export', icon:'📤', name_es:'Exportación', name_en:'Export', desc_es:'Formatos de exportación', desc_en:'Export formats', count:2},
    {id:'introduction', icon:'✍️', name_es:'Introducción', name_en:'Introduction', desc_es:'Generador de introducción', desc_en:'Introduction generator', count:2}
  ];
  function loadCategories() {
    var el = $('hs-categories'); if (!el) return;
    _categoriesLoaded = true;
    el.innerHTML = '<div class="hs-category-grid">'
      + _BUILT_IN_CATS.map(function(c) {
        var name = LANG === 'es' ? c.name_es : c.name_en;
        var desc = LANG === 'es' ? c.desc_es : c.desc_en;
        return '<div class="hs-category-item" data-ctx="' + c.id + '">'
          + '<div class="hs-category-icon">' + c.icon + '</div>'
          + '<div class="hs-category-name">' + esc(name) + '</div>'
          + '<div style="font-size:.72rem;color:#9ca3af">' + esc(desc) + '</div>'
          + '<div class="hs-category-count">' + c.count + '</div>'
          + '</div>';
      }).join('')
      + '</div>';
    el.querySelectorAll('.hs-category-item').forEach(function(item) {
      item.addEventListener('click', function() {
        switchTab('contextual');
        loadContextual(item.dataset.ctx);
      });
    });
  }

  /* ── Search ──────────────────────────────────────────────────────────── */
  var doSearch = debounce(function(q) {
    if (!q || q.length < 2) { clearSearchResults(); return; }
    apiGet('/help/api/search?q=' + encodeURIComponent(q), function(results) {
      var el = $('hs-search-results'); if (!el) return;
      if (!results.length) {
        el.innerHTML = '<div class="hs-search-empty">' + (LANG==='es'?'Sin resultados':'No results') + '</div>';
        return;
      }
      el.innerHTML = results.slice(0, 8).map(function(r) {
        return '<div class="hs-search-result-item" data-slug="' + esc(r.slug) + '">'
          + '<div style="font-size:.83rem;font-weight:500">' + esc(r.title) + '</div>'
          + (r.snippet ? '<div style="font-size:.75rem;color:#6b7280;font-style:italic">' + esc(r.snippet) + '</div>' : '')
          + (r.category ? '<span class="hs-cat-chip">' + esc(r.category.name || '') + '</span>' : '')
          + '</div>';
      }).join('');
      el.querySelectorAll('.hs-search-result-item').forEach(function(item) {
        item.addEventListener('click', function() {
          clearSearch();
          switchTab('contextual');
          showArticle(item.dataset.slug);
        });
      });
    });
  }, 300);
  function clearSearchResults() {
    var el = $('hs-search-results'); if (el) el.innerHTML = '';
  }
  function clearSearch() {
    var input = $('hs-search-input');
    if (input) input.value = '';
    clearSearchResults();
    var searchDiv = $('hs-search');
    if (searchDiv) searchDiv.classList.remove('hs-search-open');
  }

  /* ── Focus trap ──────────────────────────────────────────────────────── */
  function trapFocus(container) {
    var focusable = container.querySelectorAll('button,a,[tabindex="0"]');
    if (!focusable.length) return;
    focusable[0].focus();
    container.addEventListener('keydown', function trap(e) {
      if (e.key !== 'Tab') return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      if (!container.classList.contains('hs-overlay-open')) {
        container.removeEventListener('keydown', trap);
      }
    });
  }

  /* ── Onboarding modal ────────────────────────────────────────────────── */
  function maybeShowOnboarding() {
    if (!window.HELP_USER_LOGGED_IN) return;
    if (localStorage.getItem('hs_onboarding_done')) return;
    setTimeout(function() {
      var modal = $('hs-onboarding');
      if (modal) modal.classList.add('hs-onboarding-open');
    }, 1500);
  }

  /* ── Boot ────────────────────────────────────────────────────────────── */
  function init() {
    LANG = (window.HELP_LANG || document.body.dataset.lang || 'es');
    PAGE_CTX = (window.HELP_PAGE_CONTEXT || document.body.dataset.pageContext || '');

    // Toggle button
    var toggle = $('hs-toggle');
    if (toggle) {
      if (!localStorage.getItem('hs_opened')) toggle.classList.add('hs-pulse');
      toggle.addEventListener('click', function() {
        var panel = $('hs-panel');
        if (panel && panel.classList.contains('hs-open')) closePanel();
        else openPanel();
      });
    }

    // Close button
    var closeBtn = $('hs-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    // Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        var overlay = $('hs-overlay');
        if (overlay && overlay.classList.contains('hs-overlay-open')) { closeTutorialOverlay(false); return; }
        closePanel();
      }
    });

    // Tabs
    qsa('.hs-tab').forEach(function(tab) {
      tab.addEventListener('click', function() { switchTab(tab.dataset.tab); });
    });

    // Search toggle
    var searchToggle = $('hs-search-toggle');
    if (searchToggle) {
      searchToggle.addEventListener('click', function() {
        var s = $('hs-search');
        if (s) {
          s.classList.toggle('hs-search-open');
          if (s.classList.contains('hs-search-open')) {
            var inp = $('hs-search-input'); if (inp) inp.focus();
          }
        }
      });
    }

    // Search input
    var searchInput = $('hs-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function() { doSearch(searchInput.value); });
    }
    var searchClear = $('hs-search-clear');
    if (searchClear) searchClear.addEventListener('click', clearSearch);

    // Tutorial overlay buttons
    var tutNext = $('hs-tutorial-next');
    var tutPrev = $('hs-tutorial-prev');
    var tutSkip = $('hs-tutorial-skip');
    var tutClose = $('hs-tutorial-close');
    if (tutNext) {
      tutNext.addEventListener('click', function() {
        if (!_activeTutorial) return;
        var total = (_activeTutorial.steps || []).length;
        if (_activeTutorialStep >= total - 1) { closeTutorialOverlay(true); }
        else { showTutorialStep(_activeTutorialStep + 1); }
      });
    }
    if (tutPrev) {
      tutPrev.addEventListener('click', function() {
        if (_activeTutorialStep > 0) showTutorialStep(_activeTutorialStep - 1);
      });
    }
    if (tutSkip) tutSkip.addEventListener('click', function() { closeTutorialOverlay(false); });
    if (tutClose) tutClose.addEventListener('click', function() { closeTutorialOverlay(false); });

    // Footer start tutorial button
    var startBtn = $('hs-start-tutorial');
    if (startBtn) {
      startBtn.addEventListener('click', function() {
        switchTab('tutorials');
        if (!_tutorialsLoaded) {
          loadTutorials();
          setTimeout(function() {
            var first = document.querySelector('.hs-tutorial-card');
            if (first) first.click();
          }, 600);
        } else {
          var first = document.querySelector('.hs-tutorial-card');
          if (first) first.click();
        }
      });
    }

    // Onboarding modal
    var obSkip = $('hs-onboarding-skip');
    var obStart = $('hs-onboarding-start');
    if (obSkip) {
      obSkip.addEventListener('click', function() {
        localStorage.setItem('hs_onboarding_done', '1');
        var m = $('hs-onboarding'); if (m) m.classList.remove('hs-onboarding-open');
      });
    }
    if (obStart) {
      obStart.addEventListener('click', function() {
        localStorage.setItem('hs_onboarding_done', '1');
        var m = $('hs-onboarding'); if (m) m.classList.remove('hs-onboarding-open');
        openPanel('tutorials');
        setTimeout(function() {
          var first = document.querySelector('.hs-tutorial-card');
          if (first) first.click();
        }, 800);
      });
    }

    // Onboarding overlay backdrop click
    var onboardingModal = $('hs-onboarding');
    if (onboardingModal) {
      onboardingModal.addEventListener('click', function(e) {
        if (e.target === onboardingModal) {
          localStorage.setItem('hs_onboarding_done', '1');
          onboardingModal.classList.remove('hs-onboarding-open');
        }
      });
    }

    // Load contextual help when panel first opens
    if (PAGE_CTX) loadContextual(PAGE_CTX);

    maybeShowOnboarding();
  }

  /* ── Public API ──────────────────────────────────────────────────────── */
  window.HelpSystem = {
    open: function(tab) { openPanel(tab); },
    close: closePanel,
    search: function(q) {
      openPanel();
      var s = $('hs-search'); if (s) s.classList.add('hs-search-open');
      var inp = $('hs-search-input');
      if (inp) { inp.value = q; doSearch(q); }
    },
    showArticle: showArticle
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
