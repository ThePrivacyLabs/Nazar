// Nazar, shared DOM primitives for every content script.
// Loaded first (see manifest.json); later scripts read them off
// globalThis.Nazar. Pure helpers only: nothing in here clicks or watches.
(() => {
  const N = (globalThis.Nazar = globalThis.Nazar || {});

  const CONTROL_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"]';

  // What a person reads on the element, whitespace-collapsed. innerText
  // (not textContent) respects CSS visibility, so responsive buttons with
  // one label hidden per breakpoint ("Reject" / "Reject All Cookies") read
  // as the words on screen instead of both concatenated.
  function textOf(el) {
    if (!el) return '';
    const raw = el.tagName === 'INPUT' ? el.value : (el.innerText || el.textContent);
    return (raw || '').trim().replace(/\s+/g, ' ');
  }

  // offsetParent is unreliable inside shadow roots; client rects are not.
  function isVisible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  // A text-only match can land on an unrelated link that happens to share
  // the wording (a footer "Cookie Settings" with a javascript: handler).
  // Clicking one trips the page's CSP, so never click them.
  function isUnsafeHref(el) {
    return typeof el.href === 'string' && /^\s*javascript:/i.test(el.href);
  }

  // Walk upward through shadow boundaries: when a chain tops out inside a
  // shadow root, continue from the root's host element in the outer DOM.
  function parentThroughShadow(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  }

  // The document plus every open shadow root. Many CMPs (Usercentrics,
  // GoTrust) render inside shadow DOM, which querySelectorAll cannot see.
  function searchRoots() {
    const roots = [document];
    try {
      for (const el of document.querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (roots.length > 20) break;
      }
    } catch { /* ignore */ }
    return roots;
  }

  // A button row sometimes mixes a real control with plain text the page
  // made clickable in script, with no pointer cursor or role to show it: a
  // WordPress disclaimer plugin renders "Agree" as a <span> beside a
  // "Disagree" link. So short, childless siblings of a real control count
  // as controls too. Real controls first, then these, each in page order.
  const MAX_LOOKALIKE_TEXT = 30;

  function controlsIn(root) {
    const real = [...root.querySelectorAll(CONTROL_SELECTOR)].filter(isVisible);
    const found = new Set(real);
    const lookalikes = [];
    for (const control of real) {
      for (const sibling of control.parentElement ? control.parentElement.children : []) {
        if (found.has(sibling) || sibling.firstElementChild || !isVisible(sibling)) continue;
        const text = textOf(sibling);
        if (!text || text.length > MAX_LOOKALIKE_TEXT) continue;
        found.add(sibling);
        lookalikes.push(sibling);
      }
    }
    return [...real, ...lookalikes];
  }

  // A link to another page. On a popup, "Disagree" that is such a link does
  // not refuse anything: it sends the person off the page they came to.
  function leavesPage(el) {
    if (el.tagName !== 'A' || !el.href) return false;
    try {
      const to = new URL(el.href, location.href);
      if (to.protocol !== 'http:' && to.protocol !== 'https:') return false;
      return to.origin + to.pathname + to.search !== location.origin + location.pathname + location.search;
    } catch {
      return false;
    }
  }

  // What a form control is called on screen: its aria-label, the element
  // its aria-labelledby points at, its <label>, or, failing those, the text
  // of the row it sits in.
  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    const byId = labelledBy && el.ownerDocument.getElementById(labelledBy.split(/\s+/)[0]);
    if (byId) return textOf(byId);
    const label = (el.labels && el.labels[0]) || el.closest('label');
    if (label) return textOf(label);
    return textOf(el.parentElement).slice(0, 60);
  }

  // A short human name for a popup: its heading if it has one, else the
  // opening words of its text.
  function titleOf(root) {
    const heading = root.querySelector('h1, h2, h3, h4, [role="heading"]');
    return (heading ? textOf(heading) : textOf(root)).slice(0, 80);
  }

  N.dom = Object.freeze({
    CONTROL_SELECTOR,
    textOf,
    isVisible,
    isUnsafeHref,
    parentThroughShadow,
    searchRoots,
    controlsIn,
    leavesPage,
    nameOf,
    titleOf,
  });
})();
