// Nazar, content script
// 1. Clicks "reject all" on known CMPs (so consent is actually refused, not just hidden)
// 2. Generic reject-button detection as a fallback
// 3. Unlocks page scroll after a banner is removed
// 4. Detects known trackers loaded by the page
// 5. Finds the site's privacy policy link and reports to the background worker

(() => {
  if (window.top !== window) return; // top frame only

  const HOST = location.hostname;
  let bannerHandled = false;
  let rejectClicked = false;

  // After the extension reloads or auto-updates, a content script from the
  // old version keeps running in already-open tabs, but its chrome.* calls
  // throw "Extension context invalidated". Guard every chrome API use with
  // this so those calls fail silently instead of spamming uncaught errors.
  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }
  function notifyBlocked() {
    if (!extAlive()) return;
    try {
      chrome.runtime.sendMessage({ action: 'bannerBlocked', host: HOST }).catch(() => {});
    } catch { /* context gone */ }
  }

  // ---------------------------------------------------------------
  // 1. CMP-specific reject buttons (selector, optional shadow host)
  // ---------------------------------------------------------------
  const CMP_REJECT_SELECTORS = [
    '#onetrust-reject-all-handler',                    // OneTrust
    '.ot-pc-refuse-all-handler',                       // OneTrust preference center
    '#CybotCookiebotDialogBodyButtonDecline',          // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
    '#didomi-notice-disagree-button',                  // Didomi
    '.didomi-continue-without-agreeing',
    '.cky-btn-reject',                                 // CookieYes
    '.cmplz-deny',                                     // Complianz
    '.osano-cm-denyAll',                               // Osano
    '.osano-cm-button--type_denyAll',
    '.fc-cta-do-not-consent',                          // Google Funding Choices
    '.qc-cmp2-summary-buttons button[mode="secondary"]', // Quantcast (Reject/More options row)
    '#moove_gdpr_cookie_info_bar .moove-gdpr-infobar-reject-btn',
    '.iubenda-cs-reject-btn',                          // Iubenda
    '[data-cookiefirst-action="reject"]',              // CookieFirst
    'a[data-cookie-refuse]',                           // Borlabs
    '.cn-decline-cookie',                              // Cookie Notice (WP)
    '#cookie_action_close_header_reject',              // Cookie Law Info
    '.cc-btn.cc-deny',                                 // Insites cookieconsent
    '.klaro .cn-decline',                              // Klaro
    '[data-testid="consent-reject"]',                  // Anthropic / claude.ai
  ];

  // Usercentrics lives inside shadow DOM
  function tryUsercentrics() {
    const host = document.querySelector('#usercentrics-root');
    const root = host && host.shadowRoot;
    if (!root) return false;
    const btn = root.querySelector('button[data-testid="uc-deny-all-button"]');
    if (btn) { btn.click(); return true; }
    return false;
  }

  // Many modern CMPs (Usercentrics, GoTrust as used by Lenskart, others)
  // render inside open shadow roots, which document.querySelectorAll cannot
  // see into. Collect every open shadow root so all detection, CMP
  // selectors, generic reject, and AI candidates, works through them.
  function getSearchRoots() {
    const roots = [document];
    try {
      for (const el of document.querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (roots.length > 20) break;
      }
    } catch { /* ignore */ }
    return roots;
  }

  // Walk upward through shadow boundaries: when a chain tops out inside a
  // shadow root, continue from the root's host element in the outer DOM.
  function parentThroughShadow(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  }

  // PrivacyLabs DPDP banner has no one-click reject; rejecting means
  // opening Customize (toggles default off) and saving preferences.
  function tryDpdpPrivacyLabs() {
    const banner = document.querySelector('#dpdp-cookie-banner');
    if (!banner) return false;
    const settingsBtn = banner.querySelector('#dpdp-settings-btn');
    const panel = banner.querySelector('#dpdp-settings-panel');
    if (!settingsBtn || !panel) return false;
    settingsBtn.click();
    setTimeout(() => {
      const save = [...panel.querySelectorAll('button')].find(
        (b) => /save preferences/i.test(b.innerText || b.textContent || '')
      );
      if (save) save.click();
    }, 300);
    return true;
  }

  // ---------------------------------------------------------------
  // 2. Generic reject-button detection
  // ---------------------------------------------------------------
  const REJECT_TEXT = new RegExp(
    '^(' +
    [
      'reject( all| non.essential| unnecessary| optional)?( cookies)?',
      'decline( all| non.essential| unnecessary| optional)?( cookies)?',
      'refuse( all| non.essential| unnecessary| optional)?( cookies)?',
      'deny( all)?',
      'disagree',
      'i (do not|don.t) accept',
      'only (strictly )?(necessary|essential)( cookies)?',
      '(strictly )?(necessary|essential)( cookies)? only',
      'use necessary cookies only',
      'continue without (agreeing|accepting)',
      'no,? thanks?',
      'अस्वीकार करें', // Hindi: reject
    ].join('|') +
    ')$',
    'i'
  );

  const BANNER_HINT = /cookie|consent|gdpr|dpdp|cmp|privacy|banner|notice|policy/i;

  // A real consent banner is anchored to the viewport (fixed/sticky) AND
  // carries a cookie/consent hint in its id/class chain. Requiring both avoids
  // false positives like demo/mockup banners rendered inline in page content
  // (e.g. CMP vendors showing a fake banner in their product preview).
  function looksLikeBannerContainer(el) {
    let node = el;
    let hintSeen = false;
    for (let i = 0; i < 12 && node && node !== document.documentElement; i++) {
      // Accessible dialogs (Radix/shadcn-style) often carry the semantic
      // naming only via aria-describedby/aria-labelledby (referencing ids
      // like "cookieConsentDesc" on a child), not on the dialog's own
      // id/className, which is frequently just Tailwind utility classes.
      // Others (e.g. Anthropic's own site) skip id/class/aria entirely and
      // only mark the container via a data-testid attribute. Others still
      // (e.g. shadcn/ui-style dialogs) put the descriptive text directly
      // in aria-label rather than referencing another element's id.
      const describedBy = node.getAttribute ? (node.getAttribute('aria-describedby') || '') : '';
      const labelledBy = node.getAttribute ? (node.getAttribute('aria-labelledby') || '') : '';
      const ariaLabel = node.getAttribute ? (node.getAttribute('aria-label') || '') : '';
      const testId = node.getAttribute ? (node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-cy') || node.getAttribute('data-qa') || '') : '';
      const idClass = (node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '') + ' ' + describedBy + ' ' + labelledBy + ' ' + ariaLabel + ' ' + testId;
      if (BANNER_HINT.test(idClass)) hintSeen = true;
      const style = getComputedStyle(node);
      if (style.position === 'fixed' || style.position === 'sticky') {
        return hintSeen ? node : null;
      }
      node = parentThroughShadow(node);
    }
    return null;
  }

  // Fallback for containers that carry no id/class/aria hint at all (seen
  // in the wild: a plain flex div with only Tailwind layout classes). If
  // the visible text nearby literally says "cookie", trust that instead.
  function nearbyCookieText(el) {
    let node = el;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      // Generous cap: a real cookie-preferences panel (category toggles
      // with descriptions) easily runs 1-2k chars, still far short of
      // unrelated page chrome that might mention "cookie" in passing.
      const text = node.innerText || node.textContent || '';
      if (text.length < 2000 && /cookie/i.test(text)) return node;
      node = parentThroughShadow(node);
    }
    return null;
  }

  // Some banners only offer Accept + a "Customize"/"Manage" step, with the
  // real reject option (or per-category toggles) hidden inside a panel that
  // doesn't exist in the DOM until that button is clicked. Click through
  // once; the existing retry loop then finds the newly-rendered reject
  // button on its own via genericReject().
  // Deliberately NOT matching bare "settings" / "preferences" / "manage":
  // those appear all over normal app UIs (e.g. Google Ads) and caused false
  // clicks. Only cookie/consent-qualified phrases, or unambiguous CMP
  // wording, count as a customize control.
  const CUSTOMIZE_TEXT = /^(customi[sz]e( cookies?( settings| preferences| choices)?| choices| settings| preferences)?|manage cookies|manage (cookie )?(preferences|options|choices)|cookie (preferences|settings|choices)|allow selection)$/i;
  let customizeAttempted = false;

  function tryCustomizeFlow() {
    if (customizeAttempted) return false;
    const candidates = [];
    for (const root of getSearchRoots()) {
      candidates.push(...root.querySelectorAll('button, a, [role="button"]'));
    }
    for (const el of candidates) {
      if (el.getClientRects().length === 0) continue;
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!CUSTOMIZE_TEXT.test(text)) continue;
      const container = looksLikeBannerContainer(el) || nearbyCookieText(el);
      if (!container) continue;
      // Skip if this same container already has a direct reject button;
      // genericReject() would have already clicked it.
      const hasDirectReject = [...container.querySelectorAll('button, a, [role="button"]')].some((b) => {
        const t = (b.innerText || b.textContent || '').trim().replace(/\s+/g, ' ');
        return REJECT_TEXT.test(t);
      });
      if (hasDirectReject) continue;
      customizeAttempted = true;
      el.click();
      return false; // not rejected yet; let the loop pick up the revealed panel
    }
    return false;
  }

  // Opt-out CMPs (e.g. GoTrust as configured on lenskart.com) offer NO
  // reject button anywhere: only "Allow all" and a preferences panel where
  // every toggle defaults to ON. Rejecting means: open the panel (the
  // customize flow above), switch every consent toggle OFF, then save.
  // Gated on customizeAttempted so we only ever touch toggles after having
  // clicked a customize button inside a verified cookie banner.
  const SAVE_TEXT = /^((save|confirm)( my)?( choices| preferences| selection| settings)?|save my choices)$/i;
  let toggleSaveAttempted = false;

  function tryToggleSave() {
    if (toggleSaveAttempted || !customizeAttempted) return false;
    const roots = getSearchRoots();
    const toggles = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll('[role="switch"][aria-checked="true"], input[type="checkbox"]:checked:not(:disabled)')) {
        if (el.getClientRects().length === 0) continue;
        if (!(looksLikeBannerContainer(el) || nearbyCookieText(el))) continue;
        toggles.push(el);
      }
    }
    if (toggles.length === 0) return false;
    toggleSaveAttempted = true;
    for (const el of toggles.slice(0, 15)) el.click();
    // Give the CMP a beat to register the state changes, then save
    setTimeout(() => {
      for (const root of getSearchRoots()) {
        for (const b of root.querySelectorAll('button, [role="button"]')) {
          if (b.getClientRects().length === 0) continue;
          const t = (b.innerText || b.textContent || '').trim().replace(/\s+/g, ' ');
          if (!SAVE_TEXT.test(t)) continue;
          if (!(looksLikeBannerContainer(b) || nearbyCookieText(b))) continue;
          b.click();
          if (!bannerHandled) {
            rejectClicked = true;
            bannerHandled = true;
            unlockScroll();
            notifyBlocked();
          }
          return;
        }
      }
    }, 600);
    return true;
  }

  function genericReject() {
    for (const root of getSearchRoots()) {
      const candidates = root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
      for (const el of candidates) {
        // offsetParent is unreliable inside shadow roots; use client rects
        if (el.getClientRects().length === 0) continue; // hidden
        // innerText (not textContent) respects CSS visibility, so responsive
        // buttons with two text spans (one hidden per breakpoint, e.g.
        // "Reject" / "Reject All Cookies") don't concatenate into garbage.
        const text = (el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 60) continue;
        if (!REJECT_TEXT.test(text)) continue;
        // A reject button revealed inside a Customize/Preferences panel (e.g.
        // Radix Dialog) often sits under ancestors with no semantic hint at
        // all, just an auto-generated id via aria-labelledby. Text this
        // specific ("Reject All") plus nearby "cookie" wording is trustworthy
        // even without the stricter attribute+position check.
        const container = looksLikeBannerContainer(el) || nearbyCookieText(el);
        if (!container) continue;
        el.click();
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------
  // Banner handling loop: try for the first ~15s of the page's life
  // ---------------------------------------------------------------
  function attemptReject() {
    if (rejectClicked) return true;
    const roots = getSearchRoots();
    outer: for (const sel of CMP_REJECT_SELECTORS) {
      for (const root of roots) {
        const btn = root.querySelector(sel);
        if (btn && btn.getClientRects().length > 0) {
          btn.click();
          rejectClicked = true;
          break outer;
        }
      }
    }
    if (!rejectClicked && tryUsercentrics()) rejectClicked = true;
    if (!rejectClicked && tryDpdpPrivacyLabs()) rejectClicked = true;
    if (!rejectClicked && genericReject()) rejectClicked = true;
    if (!rejectClicked) tryCustomizeFlow();
    if (!rejectClicked) tryToggleSave();

    if (rejectClicked && !bannerHandled) {
      bannerHandled = true;
      unlockScroll();
      notifyBlocked();
    }
    return rejectClicked;
  }

  function unlockScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.overflow === 'hidden' || style.overflowY === 'hidden') {
        el.style.setProperty('overflow', 'auto', 'important');
      }
    }
  }

  // ---------------------------------------------------------------
  // AI fallback: when every heuristic failed but the page clearly talks
  // about cookies, ask the backend which element rejects consent. Only
  // element text + a selector is sent, never page content. Results are
  // cached per site for 30 days (in the background worker), so each site
  // costs at most one model call a month across all its visits.
  // ---------------------------------------------------------------
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const testId = el.getAttribute && el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    // Positional path fallback, capped at 5 levels
    const parts = [];
    let node = el;
    for (let i = 0; i < 5 && node && node !== document.body; i++) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  function collectCandidates() {
    const candidates = [];
    for (const root of getSearchRoots()) {
      for (const el of root.querySelectorAll('button, a, [role="button"]')) {
        if (el.getClientRects().length === 0) continue;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 80) continue;
        candidates.push({ selector: buildSelector(el), text });
        if (candidates.length >= 40) return candidates;
      }
    }
    return candidates;
  }

  const ACCEPT_LIKE = /accept|agree|allow|enable|got it|ok(ay)?$/i;
  const REJECT_LIKE = /reject|decline|refuse|deny|disagree|necessary|essential/i;

  let aiRecipeTried = false;

  async function tryAiRecipe() {
    if (bannerHandled || aiRecipeTried) return;
    aiRecipeTried = true;
    const bodyText = (document.body && document.body.innerText) || '';
    if (!/cookie|consent/i.test(bodyText)) return; // nothing banner-like here
    const candidates = collectCandidates();
    if (candidates.length === 0) return;

    let recipe = null;
    try {
      recipe = await chrome.runtime.sendMessage({
        action: 'aiBannerRecipe',
        origin: location.origin,
        candidates,
      });
    } catch { /* background unavailable */ }
    if (!recipe || !recipe.found || !Array.isArray(recipe.steps)) return;

    let lastText = '';
    for (const step of recipe.steps.slice(0, 2)) {
      // Selectors were collected per search root; resolve in the same way
      let el = null;
      for (const root of getSearchRoots()) {
        el = root.querySelector(step.selector);
        if (el) break;
      }
      if (!el || el.getClientRects().length === 0) return;
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      // The live element must still say what the recipe recorded, and must
      // never be accept-like. Abort entirely on any mismatch.
      if (!text || !step.expectText || !text.toLowerCase().startsWith(String(step.expectText).toLowerCase().slice(0, 40))) return;
      if (ACCEPT_LIKE.test(text) && !REJECT_LIKE.test(text)) return;
      el.click();
      lastText = text;
      await new Promise((r) => setTimeout(r, 900));
      // A customize click may have revealed a directly clickable reject
      if (attemptReject()) return;
    }

    if (REJECT_LIKE.test(lastText) && !bannerHandled) {
      rejectClicked = true;
      bannerHandled = true;
      unlockScroll();
      notifyBlocked();
    }
  }

  // Resolves once the banner loop has finished (rejected, or given up), so
  // the popup reports the banner's final state instead of a mid-flight
  // snapshot taken before Nazar has tried to reject it.
  let settleResolve;
  const bannerSettled = new Promise((resolve) => { settleResolve = resolve; });
  function markSettled() {
    if (settleResolve) { settleResolve(); settleResolve = null; }
  }

  function startWatching() {
    attemptReject();
    const observer = new MutationObserver(() => {
      if (attemptReject()) { observer.disconnect(); markSettled(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // Some CMPs load late; retry a few times then give up
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      // Stop cleanly if the extension was reloaded/updated under us
      if (!extAlive()) { clearInterval(interval); observer.disconnect(); markSettled(); return; }
      // Heuristics haven't matched after ~6s; let the AI take one look
      // while the loop keeps retrying (it may catch a late-loading CMP).
      if (tries === 4 && !rejectClicked) tryAiRecipe();
      if (attemptReject() || tries > 14) {
        clearInterval(interval);
        observer.disconnect();
        // Even without a reject click, hidden-by-CSS banners can leave scroll locked
        if (tries > 14) unlockScroll();
        markSettled();
      }
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWatching);
  } else {
    startWatching();
  }

  // ---------------------------------------------------------------
  // 4. Tracker detection (no extra permissions: reads resource timing)
  // ---------------------------------------------------------------
  const TRACKER_DOMAINS = {
    'doubleclick.net': 'Google Ads', 'googlesyndication.com': 'Google Ads',
    'googleadservices.com': 'Google Ads', 'google-analytics.com': 'Google Analytics',
    'googletagmanager.com': 'Google Tag Manager', 'connect.facebook.net': 'Meta Pixel',
    'facebook.net': 'Meta Pixel', 'hotjar.com': 'Hotjar', 'clarity.ms': 'Microsoft Clarity',
    'mixpanel.com': 'Mixpanel', 'segment.com': 'Segment', 'segment.io': 'Segment',
    'amplitude.com': 'Amplitude', 'criteo.com': 'Criteo', 'criteo.net': 'Criteo',
    'taboola.com': 'Taboola', 'outbrain.com': 'Outbrain', 'adnxs.com': 'Xandr',
    'scorecardresearch.com': 'Comscore', 'quantserve.com': 'Quantcast',
    'fullstory.com': 'FullStory', 'mouseflow.com': 'Mouseflow',
    'mc.yandex.ru': 'Yandex Metrica', 'analytics.tiktok.com': 'TikTok Pixel',
    'sc-static.net': 'Snap Pixel', 'ads.linkedin.com': 'LinkedIn Ads',
    'ads-twitter.com': 'X (Twitter) Ads', 'bat.bing.com': 'Microsoft Ads',
    'ct.pinterest.com': 'Pinterest Tag', 'adroll.com': 'AdRoll',
    'pubmatic.com': 'PubMatic', 'rubiconproject.com': 'Magnite',
    'openx.net': 'OpenX', 'casalemedia.com': 'Index Exchange',
    'moatads.com': 'Moat', 'chartbeat.com': 'Chartbeat',
    'crazyegg.com': 'Crazy Egg', 'luckyorange.com': 'Lucky Orange',
    'inspectlet.com': 'Inspectlet', 'branch.io': 'Branch',
  };

  function detectTrackers() {
    const found = new Set();
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        let host;
        try { host = new URL(entry.name).hostname; } catch { continue; }
        for (const [domain, name] of Object.entries(TRACKER_DOMAINS)) {
          if (host === domain || host.endsWith('.' + domain)) found.add(name);
        }
      }
    } catch { /* ignore */ }
    return [...found];
  }

  // ---------------------------------------------------------------
  // 5. Privacy policy link discovery
  // ---------------------------------------------------------------
  // Ranked list of likely policy URLs. The background worker fetches them
  // in order (and follows privacy-ish links inside them) until it finds a
  // page with real policy text, so a nav menu or JS shell at the top link
  // no longer poisons the analysis.
  function findPolicyLinks(limit = 5) {
    const anchors = document.querySelectorAll('a[href]');
    const seen = new Map();
    for (const a of anchors) {
      const href = a.href || '';
      const text = (a.textContent || '').trim();
      if (!/^https?:/i.test(href)) continue;
      const hrefMatch = /privacy|dpdp|data[-_]?protection/i.test(href);
      const textMatch = /privacy/i.test(text);
      if (!hrefMatch && !textMatch) continue;
      const score = (hrefMatch ? 2 : 0) + (textMatch ? 1 : 0) + (href.startsWith(location.origin) ? 1 : 0);
      if (!seen.has(href) || seen.get(href) < score) seen.set(href, score);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([href]) => href);
  }

  function findPolicyLink() {
    return findPolicyLinks(1)[0] || null;
  }

  // ---------------------------------------------------------------
  // In-page toast: alerts the user on risky sites (popup can't auto-open)
  // ---------------------------------------------------------------
  const GRADE_COLORS = { A: '#16a34a', B: '#65a30d', C: '#d97706', D: '#dc2626', F: '#991b1b' };

  async function maybeShowToast(result) {
    const risky = result && (result.grade === 'D' || result.grade === 'F');
    if (!risky && !bannerHandled) return;
    if (!extAlive()) return;

    let settings = {};
    let toastLog = {};
    try {
      ({ settings = {}, toastLog = {} } = await chrome.storage.local.get(['settings', 'toastLog']));
    } catch { return; } // context invalidated between checks
    if (settings.toastEnabled === false) return;
    // Throttle: one toast per site per 6 hours
    if (toastLog[HOST] && Date.now() - toastLog[HOST] < 6 * 60 * 60 * 1000) return;
    toastLog[HOST] = Date.now();
    await chrome.storage.local.set({ toastLog });

    const lines = [];
    if (bannerHandled) lines.push('Cookie tracking auto-rejected');
    if (risky) lines.push(`Privacy grade ${result.grade}, think twice before sharing personal data here`);
    showToast(risky ? result.grade : null, lines);
  }

  function showToast(grade, lines) {
    const toast = document.createElement('div');
    toast.setAttribute('style', [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
      'display:flex', 'align-items:flex-start', 'gap:10px',
      'max-width:320px', 'padding:12px 14px',
      'background:#ffffff', 'color:#202124',
      'border:1px solid #e8eaed',
      `border-left:4px solid ${grade ? GRADE_COLORS[grade] : '#2563eb'}`,
      'border-radius:10px',
      'box-shadow:0 10px 40px -10px rgba(0,0,0,0.25)',
      'font-family:Lato,-apple-system,Segoe UI,Roboto,sans-serif',
      'font-size:13px', 'line-height:1.45',
      'transition:opacity .4s, transform .4s',
    ].join(';') + ';');

    const badge = document.createElement('div');
    badge.textContent = grade || '🧿';
    badge.setAttribute('style', [
      'flex-shrink:0', 'width:34px', 'height:34px', 'border-radius:50%',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-weight:800', 'font-size:16px', 'color:#fff',
      `background:${grade ? GRADE_COLORS[grade] : '#2563eb'}`,
    ].join(';') + ';');

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
    const hint = document.createElement('div');
    hint.textContent = 'Click the 🧿 icon in your toolbar for details';
    hint.setAttribute('style', 'color:#80868b;font-size:11px;margin-top:4px;');
    body.appendChild(hint);

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

    toast.append(badge, body, close);
    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 450);
    }, 8000);
  }

  // ---------------------------------------------------------------
  // Report to background (auto policy analysis + badge) and answer popup
  // ---------------------------------------------------------------
  // Detection is separate from rejection: report that a cookie banner is
  // PRESENT even when there is no reject option to click (e.g. Ola's
  // accept-only bar). A known CMP container, or any visible fixed/sticky
  // element whose text mentions cookies with an accept/consent control,
  // counts as a banner. Runs across shadow roots too.
  const CMP_CONTAINER_SELECTORS = [
    '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#didomi-host',
    '.cky-consent-container', '#cmplz-cookiebanner-container', '.osano-cm-window',
    '#usercentrics-root', '.fc-consent-root', '#iubenda-cs-banner',
    '.cookiefirst-root', '#gotrust-cookie-banner', '#truste-consent-track',
    '.qc-cmp2-container', '#CybotCookiebotDialogBodyContent', '#cookie-law-info-bar',
  ];

  function detectBannerPresent() {
    const roots = getSearchRoots();
    for (const sel of CMP_CONTAINER_SELECTORS) {
      for (const root of roots) {
        const el = root.querySelector(sel);
        if (el && el.getClientRects().length > 0) return true;
      }
    }
    // Generic: a viewport-anchored element that talks about cookies and has
    // an accept/agree/consent-style button inside it.
    for (const root of roots) {
      for (const el of root.querySelectorAll('div, section, aside, dialog, [role="dialog"]')) {
        let cs;
        try { cs = getComputedStyle(el); } catch { continue; }
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (el.getClientRects().length === 0) continue;
        const text = (el.innerText || '').slice(0, 500);
        if (text.length > 600 || !/cookie|consent/i.test(text)) continue;
        const hasControl = [...el.querySelectorAll('button, a, [role="button"]')].some((b) =>
          /accept|agree|allow|consent|reject|decline|manage|customize|preferences|got it/i.test(
            (b.innerText || b.textContent || '')
          )
        );
        if (hasControl) return true;
      }
    }
    return false;
  }

  function report() {
    if (!extAlive()) return;
    try {
      chrome.runtime.sendMessage(
        {
          action: 'pageReady',
          origin: location.origin,
          policyUrl: findPolicyLink(),
          policyUrls: findPolicyLinks(),
          trackers: detectTrackers(),
          bannerBlocked: bannerHandled,
          bannerPresent: bannerHandled || detectBannerPresent(),
        },
        (result) => {
          if (chrome.runtime.lastError) return;
          maybeShowToast(result);
        }
      );
    } catch { /* context gone */ }
  }

  // Report only once the banner loop has settled, so the popup reflects the
  // page AFTER Nazar has done its work. Capped so a page that never settles
  // still reports.
  function reportWhenSettled() {
    Promise.race([
      bannerSettled,
      new Promise((r) => setTimeout(r, 24000)),
    ]).then(report);
  }

  if (document.readyState === 'complete') {
    reportWhenSettled();
  } else {
    window.addEventListener('load', reportWhenSettled);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'getPageReport') {
      sendResponse({
        host: HOST,
        origin: location.origin,
        bannerBlocked: bannerHandled,
        bannerPresent: bannerHandled || detectBannerPresent(),
        trackers: detectTrackers(),
        policyUrl: findPolicyLink(),
        policyUrls: findPolicyLinks(),
      });
    }
  });
})();
