/**
 * Lab Publication Integration — UI fixes.
 * 1. Ensures any results panel with class .lab-results-panel can be closed.
 * 2. Converts bare DOI/PMID text nodes to clickable links anywhere on the page.
 */
(function () {
'use strict';

// ── DOI / PMID link conversion ────────────────────────────────────────────────

var _DOI_RE  = /\b(10\.\d{4,}\/[^\s"<>]+)/g;
var _PMID_RE = /\bPMID:?\s*(\d{6,})\b/gi;

function _makeLink(href, text, title) {
    var a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = title;
    a.textContent = text;
    a.style.cssText = 'color:#007bff;text-decoration:none;border-bottom:1px dotted #007bff';
    return a;
}

function _convertTextNode(node) {
    var text = node.textContent;
    if (!text || text.length > 500) return; // skip large blocks

    var parent = node.parentNode;
    if (!parent || parent.nodeName === 'A' || parent.nodeName === 'SCRIPT' || parent.nodeName === 'STYLE') return;

    // Check for DOI first
    _DOI_RE.lastIndex = 0;
    var doiMatch = _DOI_RE.exec(text);
    if (doiMatch) {
        var before = document.createTextNode(text.slice(0, doiMatch.index));
        var link   = _makeLink('https://doi.org/' + doiMatch[1], doiMatch[1], 'Open DOI: ' + doiMatch[1]);
        var after  = document.createTextNode(text.slice(doiMatch.index + doiMatch[0].length));
        parent.insertBefore(before, node);
        parent.insertBefore(link,   node);
        parent.insertBefore(after,  node);
        parent.removeChild(node);
        return;
    }

    // Check for PMID
    _PMID_RE.lastIndex = 0;
    var pmidMatch = _PMID_RE.exec(text);
    if (pmidMatch) {
        var pmid   = pmidMatch[1];
        var before2 = document.createTextNode(text.slice(0, pmidMatch.index));
        var link2   = _makeLink('https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/', 'PMID:' + pmid, 'Open PubMed');
        var after2  = document.createTextNode(text.slice(pmidMatch.index + pmidMatch[0].length));
        parent.insertBefore(before2, node);
        parent.insertBefore(link2,   node);
        parent.insertBefore(after2,  node);
        parent.removeChild(node);
    }
}

function convertDoiPmidLinks(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(_convertTextNode);
}

// ── Escape helper ─────────────────────────────────────────────────────────────

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── Close button guard ────────────────────────────────────────────────────────
// Adds a close button to any .card panel that has an id containing "result"
// and lacks a close button, so future refactors don't accidentally remove it.

function ensureResultsPanelClosable() {
    var panels = document.querySelectorAll('[id*="result"][id*="Panel"], [id*="result"][id*="panel"]');
    panels.forEach(function (panel) {
        if (panel.querySelector('.lab-close-btn')) return;
        var header = panel.querySelector('.card-header-row, .card-title');
        if (!header) return;

        var btn = document.createElement('button');
        btn.className = 'btn btn--secondary btn--sm lab-close-btn';
        btn.innerHTML = '&#10005; Close';
        btn.style.marginLeft = 'auto';
        btn.addEventListener('click', function () { panel.style.display = 'none'; });

        // Wrap card-title alone in a header-row if needed
        if (header.classList.contains('card-title') && !header.classList.contains('card-header-row')) {
            var wrapper = document.createElement('div');
            wrapper.className = 'card-header-row';
            header.parentNode.insertBefore(wrapper, header);
            wrapper.appendChild(header);
            wrapper.appendChild(btn);
        } else {
            header.appendChild(btn);
        }
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────

function init() {
    ensureResultsPanelClosable();
    convertDoiPmidLinks(document.body);

    // Watch for dynamically added content
    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
            m.addedNodes.forEach(function (node) {
                if (node.nodeType === 1) {
                    convertDoiPmidLinks(node);
                    ensureResultsPanelClosable();
                }
            });
        });
    });
    observer.observe(document.body, {childList: true, subtree: true});
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

})();
