// Nazar, the in-page toast. One at a time: a newer message replaces the
// one on screen instead of stacking.
(() => {
  const N = (globalThis.Nazar = globalThis.Nazar || {});

  const BRAND_BLUE = '#2563eb';
  // Marks Nazar's own UI so no content script ever mistakes it for the
  // page's (the toast mentions consent and is fixed-position).
  const OWN_UI_ATTR = 'data-nazar-ui';
  let current = null;

  function css(rules) {
    return rules.join(';') + ';';
  }

  function show({ badge = '🧿', color = BRAND_BLUE, lines, hint = 'Click the 🧿 icon in your toolbar for details', durationMs = 8000 }) {
    if (current) current.remove();

    const toast = document.createElement('div');
    toast.setAttribute(OWN_UI_ATTR, '');
    toast.setAttribute('style', css([
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
      'display:flex', 'align-items:flex-start', 'gap:10px',
      'max-width:320px', 'padding:12px 14px',
      'background:#ffffff', 'color:#202124',
      'border:1px solid #e8eaed',
      `border-left:4px solid ${color}`,
      'border-radius:10px',
      'box-shadow:0 10px 40px -10px rgba(0,0,0,0.25)',
      'font-family:Lato,-apple-system,Segoe UI,Roboto,sans-serif',
      'font-size:13px', 'line-height:1.45',
      'transition:opacity .4s, transform .4s',
    ]));

    const badgeEl = document.createElement('div');
    badgeEl.textContent = badge;
    badgeEl.setAttribute('style', css([
      'flex-shrink:0', 'width:34px', 'height:34px', 'border-radius:50%',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-weight:800', 'font-size:16px', 'color:#fff',
      `background:${color}`,
    ]));

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = '🧿 Nazar';
    title.setAttribute('style', 'font-weight:800;margin-bottom:2px;color:#202124;');
    body.appendChild(title);
    for (const line of lines) {
      const p = document.createElement('div');
      p.textContent = line;
      p.setAttribute('style', 'color:#3c4043;');
      body.appendChild(p);
    }
    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.textContent = hint;
      hintEl.setAttribute('style', 'color:#80868b;font-size:11px;margin-top:4px;');
      body.appendChild(hintEl);
    }

    const brand = document.createElement('div');
    brand.setAttribute('style', 'display:flex;align-items:center;gap:4px;margin-top:6px;color:#80868b;font-size:10px;');
    const by = document.createElement('span');
    by.textContent = 'by';
    const logo = document.createElement('img');
    logo.src = chrome.runtime.getURL('assets/brand/logo-side.svg');
    logo.alt = 'Privacy Labs';
    logo.setAttribute('style', 'height:10px;width:auto;display:block;');
    brand.append(by, logo);
    body.appendChild(brand);

    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('style', 'background:none;border:none;color:#80868b;font-size:16px;cursor:pointer;padding:0 2px;line-height:1;');
    close.addEventListener('click', () => toast.remove());

    toast.append(badgeEl, body, close);
    (document.body || document.documentElement).appendChild(toast);
    current = toast;
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => {
        toast.remove();
        if (current === toast) current = null;
      }, 450);
    }, durationMs);
  }

  N.toast = Object.freeze({ OWN_UI_ATTR, show });
})();
