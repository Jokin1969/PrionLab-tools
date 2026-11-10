/* In-page replacements for the browser's confirm()/prompt()/alert().
 *
 * Browsers let users silence native dialogs ("don't allow this page to create
 * more dialogs"); after that confirm() silently answers "no" and delete/rename
 * buttons look dead. These cannot be blocked.
 *   await pvConfirm(msg) → boolean      await pvPrompt(msg, default) → string|null
 *   pvNotice(msg)        → non-blocking notice
 * (PrionVault's own bundle carries the same helper inside its IIFE.)
 */
(function () {
  function _pvDialog(kind, message, defaultValue) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const ov = document.createElement('div');
      ov.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.45);' +
                         'display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:12px;max-width:520px;width:100%;max-height:85vh;' +
                          'overflow:auto;padding:18px 20px;box-shadow:0 20px 50px rgba(0,0,0,.3);' +
                          'font-family:inherit;';
      const msg = document.createElement('div');
      msg.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.5;color:#111827;';
      msg.textContent = String(message ?? '');
      box.appendChild(msg);
      let input = null;
      if (kind === 'prompt') {
        input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue == null ? '' : String(defaultValue);
        input.style.cssText = 'width:100%;box-sizing:border-box;margin-top:12px;padding:8px 10px;' +
                              'border:1px solid #d1d5db;border-radius:8px;font-size:14px;';
        box.appendChild(input);
      }
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;';
      const mk = (label, primary) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = 'padding:7px 16px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;' +
          (primary ? 'background:#0F3460;color:#fff;border:1px solid #0F3460;'
                   : 'background:#fff;color:#374151;border:1px solid #d1d5db;');
        return b;
      };
      const cancel = kind === 'alert' ? null : mk('Cancelar', false);
      const ok = mk('Aceptar', true);
      if (cancel) row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(row);
      ov.appendChild(box);
      const done = (value) => {
        ov.remove();
        try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus(); } catch (_) {}
        resolve(value);
      };
      const accept = () => done(kind === 'prompt' ? input.value : true);
      const reject = () => done(kind === 'prompt' ? null : (kind === 'alert' ? true : false));
      ok.addEventListener('click', accept);
      if (cancel) cancel.addEventListener('click', reject);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov && kind === 'alert') reject(); });
      ov.addEventListener('keydown', (e) => {
        e.stopPropagation();            // don't let Escape/Tab reach the modal underneath
        if (e.key === 'Escape') { e.preventDefault(); reject(); }
        else if (e.key === 'Enter' && e.target !== cancel) { e.preventDefault(); accept(); }
        else if (e.key === 'Tab') {
          const f = [input, cancel, ok].filter(Boolean);
          const i = f.indexOf(document.activeElement);
          e.preventDefault();
          f[(i + (e.shiftKey ? f.length - 1 : 1) + f.length) % f.length].focus();
        }
      });
      document.body.appendChild(ov);
      if (input) { input.focus(); input.select(); } else ok.focus();
    });
  }
  window.pvConfirm = (message) => _pvDialog('confirm', message);
  window.pvPrompt  = (message, defaultValue) => _pvDialog('prompt', message, defaultValue);
  window.pvNotice  = (message) => { _pvDialog('alert', message); };
})();
