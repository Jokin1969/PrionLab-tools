/* Enhanced Professional Navbar — PrionLab Tools */
(function () {
  'use strict';

  /* ── Dropdown toggle ──────────────────────────────────────────────────── */
  function initDropdowns() {
    document.querySelectorAll('.nb-dropdown').forEach(function (dd) {
      var trigger = dd.querySelector('.nb-link');
      if (!trigger) return;

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = dd.classList.contains('nb-open');
        closeAll();
        if (!isOpen) dd.classList.add('nb-open');
      });

      trigger.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          trigger.click();
        }
        if (e.key === 'Escape') closeAll();
      });

      /* Trap focus inside open menu */
      var menu = dd.querySelector('.nb-menu');
      if (menu) {
        menu.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            closeAll();
            trigger.focus();
          }
        });
      }
    });

    /* Close on outside click */
    document.addEventListener('click', function () { closeAll(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll();
    });
  }

  function closeAll() {
    document.querySelectorAll('.nb-dropdown.nb-open').forEach(function (dd) {
      dd.classList.remove('nb-open');
    });
  }

  /* ── Mobile drawer ────────────────────────────────────────────────────── */
  function initMobileDrawer() {
    var toggle = document.getElementById('nb-mobile-toggle');
    var drawer = document.getElementById('nb-mobile-drawer');
    if (!toggle || !drawer) return;

    toggle.addEventListener('click', function () {
      var open = toggle.classList.toggle('nb-open');
      drawer.classList.toggle('nb-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    });

    /* Close on backdrop click */
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) closeDrawer();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    function closeDrawer() {
      toggle.classList.remove('nb-open');
      drawer.classList.remove('nb-open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }
  }

  /* ── Scroll shadow ────────────────────────────────────────────────────── */
  function initScrollShadow() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    window.addEventListener('scroll', function () {
      header.classList.toggle('nb-scrolled', window.scrollY > 4);
    }, { passive: true });
  }

  /* ── Active link highlight ────────────────────────────────────────────── */
  function initActiveLinks() {
    var path = window.location.pathname;
    document.querySelectorAll('.nb-link[href], .nb-item[href]').forEach(function (el) {
      var href = el.getAttribute('href');
      if (href && href !== '/' && path.startsWith(href)) {
        el.classList.add('nb-active');
        /* Also mark parent dropdown trigger */
        var dd = el.closest('.nb-dropdown');
        if (dd) {
          var trigger = dd.querySelector(':scope > .nb-link');
          if (trigger) trigger.classList.add('nb-active');
        }
      }
    });
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */
  function boot() {
    initDropdowns();
    initMobileDrawer();
    initScrollShadow();
    initActiveLinks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
