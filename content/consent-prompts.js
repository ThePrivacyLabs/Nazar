// Nazar, consent prompts at the point of collection.
//
// DPDP asks for consent one purpose at a time, at the moment data is
// collected, so a single signup can raise several prompts. This watches for
// them for the whole life of the page and answers each one the moment it is
// inserted, inside the same task, so it is gone before the browser paints it:
//
//   itemised  purposes to pick, and a "save my selection" button
//                                                        -> switch optional off, save
//   optional  the prompt offers a way to say no
//             ... and it answers the person's own click  -> accept
//             ... otherwise                              -> decline
//   required  acknowledging is the only way on           -> acknowledge
//   entry     a notice you must agree to before entering a site, its
//             "Disagree" a link that takes you away      -> agree
//   anything else                                        -> leave it to the person
//
// A "no" that is a link to another page is not a refusal: it takes the
// person off the site they chose to visit (law firms show a Bar Council
// disclaimer this way: Agree, or Disagree and leave). Nazar never presses
// one. With an agree beside it, the notice is the site's entry condition
// and Nazar agrees; without one, the person decides.
//
// Itemised comes first because "Reject all" on a notice that also lists
// required purposes can refuse those too, and the flow stalls (seen on a
// live 9-step loan onboarding: "Reject all" left the person on step 2,
// "Accept selected" with only the required purposes moved them to step 3).
//
// "Optional" is read from the prompt's structure, never its wording: our own
// SDK badges an optional purpose "Consent required", and a site that offers
// Decline has already said the answer may be no.
//
// Optional is not the same as unwanted. A prompt that appears right after
// the person clicks "Book demo", asking to use their details to book the
// demo, is them asking for exactly that; declining it would undo their own
// click, and in a long onboarding flow could cost them the flow. So a prompt
// counts as answering the person's click when it appears within
// CLICK_WINDOW_MS of them pressing a button or submitting a form (on this
// page, the previous page of the same site, or the page embedding this
// frame), and its question is not about an extra purpose (marketing,
// profiling, sharing: vocab.EXTRA_PURPOSE).
//
// Consent tools often render their notice in their own iframe, on their own
// domain, so this runs in every frame. Inside such a frame the whole
// document is the prompt. What Nazar does there is reported to the top
// frame, which owns the page's record and the in-page note.
//
// Two stand-downs keep Nazar from getting in the way of what the person is
// doing. If a declined prompt comes straight back after the person clicks
// again, the site will not let them continue without it, so that one is
// theirs to answer. And a prompt the site keeps re-raising on its own is
// answered at most MAX_REPEATS times.
//
// Cookie banners are cookie-shield.js's job and are skipped here.
(() => {
  const { dom, vocab, ext, activity, toast } = globalThis.Nazar;
  const { KIND, DECISION } = activity;

  const IN_FRAME = window.top !== window;

  const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  // A popup that asks for typed input is a form, not a consent prompt.
  const DATA_ENTRY_SELECTOR = 'textarea, input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="password"], input[type="number"], input[type="date"], input[type="search"], input[type="url"]';
  const ON_TOGGLE_SELECTOR = 'input[type="checkbox"]:checked:not(:disabled), [role="switch"][aria-checked="true"]:not([aria-disabled="true"])';
  // Switched on and locked: a purpose the prompt says is required.
  const LOCKED_TOGGLE_SELECTOR = 'input[type="checkbox"]:checked:disabled, [role="switch"][aria-checked="true"][aria-disabled="true"]';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);

  // A DPDP notice is long by law (Rule 3 wants each purpose itemised), so
  // length alone cannot tell a prompt from a page section. Past
  // SHORT_PROMPT_CHARS a prompt must say "consent" outright, and no prompt
  // carries more controls than MAX_PROMPT_CONTROLS; an app shell with a
  // position:fixed layout fails both.
  const SHORT_PROMPT_CHARS = 3000;
  const MAX_PROMPT_CHARS = 20000;
  const MAX_PROMPT_CONTROLS = 30;
  // A cookie banner is short or says so in its heading; a long notice that
  // mentions cookies in its fine print is still a consent prompt.
  const SHORT_COOKIE_BANNER_CHARS = 1000;
  // Smaller than this, a frame is a tracking pixel or a widget, not a notice.
  const MIN_FRAME_WIDTH = 200;
  const MIN_FRAME_HEIGHT = 150;

  const MAX_WALK_UP = 10;
  const MAX_ACTIONS_PER_PAGE = 20;
  const MAX_REPEATS = 3;
  const RETRY_WINDOW_MS = 4000;     // "came straight back after a click"
  const CLICK_WINDOW_MS = 8000;     // covers a slow next-page load in a flow
  // After the first click: look again at these gaps (3s in all), retrying
  // the click at most MAX_RETRIES times, which spans the first second, as
  // long as a slow page takes to wire its buttons up.
  const FOLLOW_UP_MS = [250, 250, 500, 1000, 1000];
  const MAX_RETRIES = 3;
  const RESCAN_AFTER_GESTURE_MS = [300, 1200];

  const handled = new WeakSet();     // prompt elements already dealt with
  const answeredTimes = new Map();   // prompt text -> times Nazar answered it
  let actionsTaken = 0;
  let lastGestureAt = 0;             // any click or key press
  let lastControlClickAt = 0;        // a button pressed or a form submitted
  let lastControlLabel = '';         // ... and what that button said
  let settings = null;               // null until the context below loads

  // The background worker answers with the tab's last button press only
  // when it was on the same site as the tab's page, so a click that
  // opened this frame, or ended the previous step, counts here.
  const contextReady = Promise.all([
    ext.getSettings(),
    ext.request({ action: 'getLastControlClick' }),
  ]).then(([loaded, click]) => {
    if (click && click.ts > lastControlClickAt) {
      lastControlClickAt = click.ts;
      lastControlLabel = click.label || '';
    }
    settings = loaded;
  });

  // ---------------------------------------------------------------
  // Finding prompts
  // ---------------------------------------------------------------
  function isPromptShaped(el) {
    return el.matches(DIALOG_SELECTOR) || getComputedStyle(el).position === 'fixed';
  }

  const frameIsViewable = () => window.innerWidth >= MIN_FRAME_WIDTH && window.innerHeight >= MIN_FRAME_HEIGHT;

  function promptRootOf(node) {
    let el = node;
    for (let i = 0; el && i < MAX_WALK_UP && el !== document.body; i++) {
      if (el.nodeType === 1 && isPromptShaped(el)) return el;
      el = dom.parentThroughShadow(el);
    }
    // Inside a consent tool's frame, the document itself is the prompt.
    return IN_FRAME && document.body && frameIsViewable() ? document.body : null;
  }

  // textContent, not innerText: this runs on every inserted subtree and
  // must not force layout. Visible wording is checked later, on the few
  // candidates that pass.
  function mightBePrompt(node) {
    const text = node.textContent || '';
    return text.length <= MAX_PROMPT_CHARS && vocab.CONSENT_HINT.test(text);
  }

  function collectFrom(node, into) {
    if (SKIP_TAGS.has(node.tagName)) return;
    if (mightBePrompt(node)) {
      const root = promptRootOf(node);
      if (root) into.add(root);
    }
    if (node.firstElementChild) {
      for (const dialog of node.querySelectorAll(DIALOG_SELECTOR)) into.add(dialog);
    }
  }

  // ---------------------------------------------------------------
  // Classifying a prompt. Returns a plan, or null to leave it alone.
  // ---------------------------------------------------------------
  function isCookieBanner(label, text) {
    return vocab.COOKIE.test(label) || (text.length < SHORT_COOKIE_BANNER_CHARS && vocab.COOKIE.test(text));
  }

  function classify(root) {
    if (root.closest(`[${toast.OWN_UI_ATTR}]`)) return null;
    if (!dom.isVisible(root)) return null;
    const text = dom.textOf(root);
    if (!text || text.length > MAX_PROMPT_CHARS || !vocab.CONSENT_HINT.test(text)) return null;
    const long = text.length > SHORT_PROMPT_CHARS || root === document.body;
    if (long && !vocab.CONSENT_WORD.test(text)) return null;
    if (isCookieBanner(dom.titleOf(root), text)) return null;
    if (root.querySelector(DATA_ENTRY_SELECTOR)) return null;

    const controls = dom.controlsIn(root).filter((c) => !dom.isUnsafeHref(c));
    if (controls.length > MAX_PROMPT_CONTROLS) return null;
    const labelled = (re) => controls.find((c) => re.test(dom.textOf(c)));

    const declineControl = labelled(vocab.DECLINE);
    const acknowledge = labelled(vocab.ACKNOWLEDGE);
    if (declineControl && dom.leavesPage(declineControl)) {
      return acknowledge ? { type: 'entry', control: acknowledge } : null;
    }
    const decline = declineControl;
    const save = labelled(vocab.SAVE);
    const toggles = [...root.querySelectorAll(ON_TOGGLE_SELECTOR)].filter(dom.isVisible);
    // A save button counts only beside a way to say no or purposes to
    // switch off; alone, "Save" could be anything.
    if (save && (toggles.length > 0 || decline)) return { type: 'itemised', control: save, toggles };

    if (decline) return { type: 'optional', control: decline, grant: labelled(vocab.GRANT) };

    if (acknowledge) return { type: 'required', control: acknowledge };

    return null;
  }

  // ---------------------------------------------------------------
  // Deciding: which control to press, and how to report it
  // ---------------------------------------------------------------
  const RETRY_HINT = 'Need it after all? Do it again and Nazar will leave it to you.';

  const answersPersonsClick = () => Date.now() - lastControlClickAt < CLICK_WINDOW_MS;

  // The button the person pressed that this prompt answers, in their words.
  const trigger = () => (answersPersonsClick() ? lastControlLabel : '');

  // Purposes named in a "Granting: ..." / "Refusing: ..." line.
  function purposesIn(line) {
    return line ? line.split(/,|;|\band\b/i).map((p) => p.trim()).filter(Boolean) : [];
  }

  // What a confirm step says the choice gives and refuses. innerText, not
  // textOf: the line breaks are what separate the purposes from the text
  // around them.
  function spelledOut(root) {
    const text = root.innerText || '';
    const giving = text.match(vocab.GIVING_LINE);
    const refusing = text.match(vocab.REFUSING_LINE);
    return { gave: purposesIn(giving && giving[2]), refused: purposesIn(refusing && refusing[2]) };
  }

  function decide(plan, label, root) {
    if (plan.type === 'itemised') {
      const n = plan.toggles.length;
      const locked = [...root.querySelectorAll(LOCKED_TOGGLE_SELECTOR)].filter(dom.isVisible);
      return {
        control: plan.control,
        toggles: plan.toggles,
        decision: DECISION.REQUIRED_ONLY,
        reason: 'Kept only what is required',
        gave: locked.map(dom.nameOf),
        refused: plan.toggles.map(dom.nameOf),
        line: n > 0
          ? `Switched off ${n} optional purpose${n === 1 ? '' : 's'} and kept the required ones: "${label}"`
          : `Kept only the required consents: "${label}"`,
        hint: RETRY_HINT,
      };
    }
    if (plan.type === 'optional' && plan.grant && answersPersonsClick() && !vocab.EXTRA_PURPOSE.test(label)) {
      return {
        control: plan.grant,
        decision: DECISION.ACCEPTED,
        reason: 'You asked for this',
        gave: [label],
        line: `Accepted "${label}", which your click asked for`,
        hint: 'Nazar still declines anything extra, like marketing or sharing.',
      };
    }
    if (plan.type === 'optional') {
      return {
        control: plan.control,
        decision: DECISION.DECLINED,
        reason: 'Optional',
        refused: [label],
        line: `Declined an optional consent: "${label}"`,
        hint: RETRY_HINT,
      };
    }
    if (plan.type === 'entry') {
      // A disclaimer gives the site no data, so nothing is listed as given.
      return {
        control: plan.control,
        decision: DECISION.ACCEPTED,
        reason: 'Site notice, needed to enter',
        line: 'Agreed to the site\'s entry notice; disagreeing would have taken you off the site',
      };
    }
    return {
      control: plan.control,
      decision: DECISION.ACCEPTED,
      reason: 'Required to continue',
      gave: [label],
      line: `Accepted a required notice: "${label}"`,
    };
  }

  // ---------------------------------------------------------------
  // Acting
  // ---------------------------------------------------------------
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isClosed = (root) => !root.isConnected || !dom.isVisible(root);

  // A confirm button that was not there before Nazar's click: the page
  // asking to confirm the choice Nazar just made.
  function newConfirmControl(root, before) {
    return dom.controlsIn(root).find((c) => !before.has(c) && vocab.CONFIRM.test(dom.textOf(c)));
  }

  // Everything before the first await runs synchronously, so the toggles
  // and the first click land before paint. While the prompt stays up after
  // that, one of two things is happening. The page asked to confirm the
  // choice ("Confirm your choice: Back / Confirm & Submit"), which Nazar
  // finishes, once. Or the click did nothing because the page wires its
  // buttons up after showing them (server-rendered pages do, until their
  // code loads), so the click is tried again, up to MAX_RETRIES times.
  //
  // `onPurposes` hears what a confirm step says the choice gives and
  // refuses, before Nazar confirms: confirming often removes the prompt,
  // and inside a frame that ends this script. Resolves to whether the
  // prompt closed.
  async function execute(action, root, onPurposes) {
    const before = new Set(dom.controlsIn(root));
    if (action.toggles.length > 0) {
      for (const toggle of action.toggles) toggle.click();
      await wait(0); // let the page's state catch up before saving
    }
    action.control.click();
    let retries = 0;
    let confirmed = false;
    for (const gap of FOLLOW_UP_MS) {
      await wait(gap);
      if (isClosed(root)) return true;
      if (confirmed) continue;
      const confirm = newConfirmControl(root, before);
      if (confirm) {
        const named = spelledOut(root);
        if (named.gave.length || named.refused.length) onPurposes(named);
        confirm.click();
        confirmed = true;
      } else if (retries < MAX_RETRIES && action.control.isConnected && dom.isVisible(action.control)) {
        action.control.click();
        retries++;
      }
    }
    return isClosed(root);
  }

  async function handle(root) {
    if (handled.has(root) || !root.isConnected) return;
    if (!settings) {
      contextReady.then(() => handle(root));
      return;
    }
    if (settings.promptsEnabled === false || actionsTaken >= MAX_ACTIONS_PER_PAGE) return;

    const plan = classify(root);
    if (!plan) return; // may be half-rendered; a later insertion re-checks it
    handled.add(root);

    const label = dom.titleOf(root);
    const key = dom.textOf(root).slice(0, 160);
    const times = answeredTimes.get(key) || 0;
    const record = (decision, reason, extra = {}, notice = null) =>
      activity.record({ kind: KIND.PROMPT, decision, label, reason, trigger: trigger(), ...extra }, notice);

    if (times > 0 && plan.type !== 'required' && Date.now() - lastGestureAt < RETRY_WINDOW_MS) {
      record(DECISION.LEFT, 'You asked for it again');
      return;
    }
    if (times >= MAX_REPEATS) {
      if (times === MAX_REPEATS) record(DECISION.LEFT, 'Keeps reappearing');
      answeredTimes.set(key, times + 1);
      return;
    }

    const action = { toggles: [], gave: [], refused: [], ...decide(plan, label, root) };
    actionsTaken++;
    answeredTimes.set(key, times + 1);
    const notice = settings.toastEnabled !== false
      ? { lines: [action.line], hint: action.hint, durationMs: 6000 }
      : null;

    const purposes = { gave: action.gave, refused: action.refused };
    if (IN_FRAME) {
      // The embedding page usually removes a consent frame the moment it is
      // answered, which ends this script before any check could run, so
      // report on the click, and add what a confirm step names as soon as
      // it names it. The top frame shows the note.
      let entry = null;
      execute(action, root, (named) => entry && activity.amend(entry, named)); // clicks now
      entry = record(action.decision, action.reason, purposes, notice);
      return;
    }
    const named = { gave: [], refused: [] };
    const closed = await execute(action, root, (found) => Object.assign(named, found));
    if (!closed) {
      record(DECISION.LEFT, 'Could not close it');
      return;
    }
    record(action.decision, action.reason, {
      gave: [...purposes.gave, ...named.gave],
      refused: [...purposes.refused, ...named.refused],
    });
    if (notice) toast.show(notice);
  }

  // ---------------------------------------------------------------
  // Watching
  // ---------------------------------------------------------------
  function onMutations(mutations) {
    const roots = new Set();
    for (const m of mutations) {
      if (m.type === 'attributes') {
        collectFrom(m.target, roots);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) collectFrom(node, roots);
      }
    }
    for (const root of roots) handle(root);
  }

  // Popups shown by toggling a class, rather than by insertion, produce no
  // mutation this observer listens for. They almost always open in response
  // to a click, so look again shortly after each one. Overlays render as
  // dialogs or as direct children of <body> (portals).
  function rescan() {
    const roots = new Set(document.querySelectorAll(DIALOG_SELECTOR));
    for (const child of document.body ? document.body.children : []) {
      if (!SKIP_TAGS.has(child.tagName) && mightBePrompt(child) && isPromptShaped(child)) roots.add(child);
    }
    if (IN_FRAME && document.body && frameIsViewable()) roots.add(document.body);
    for (const root of roots) handle(root);
  }

  // A button pressed, or Enter in a form: the person moving their task on,
  // as opposed to a click on blank page or a key typed into a field.
  function isControlAction(e) {
    const target = e.composedPath()[0];
    if (!(target instanceof Element) || target.closest(`[${toast.OWN_UI_ATTR}]`)) return false;
    if (e.type === 'keydown' && e.key === 'Enter') return !!target.closest('form, ' + dom.CONTROL_SELECTOR);
    return !!target.closest(dom.CONTROL_SELECTOR); // a click, or Space on a button
  }

  // What the pressed button said; for Enter in a form, its submit button.
  function controlLabel(e) {
    const target = e.composedPath()[0];
    const control = target.closest(dom.CONTROL_SELECTOR)
      || target.closest('form')?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (!control) return '';
    return (dom.textOf(control) || control.getAttribute('aria-label') || '').slice(0, 60);
  }

  function onGesture(e) {
    if (!e.isTrusted) return; // Nazar's own clicks are not the person's
    lastGestureAt = Date.now();
    if (isControlAction(e)) {
      lastControlClickAt = lastGestureAt;
      lastControlLabel = controlLabel(e);
      // For the next page, or a consent frame this click opens.
      ext.send({ action: 'controlClick', label: lastControlLabel });
    }
    for (const ms of RESCAN_AFTER_GESTURE_MS) setTimeout(rescan, ms);
  }

  // The top frame keeps the page's record and shows the note for what
  // Nazar did inside a consent tool's frame (relayed by background.js).
  function listenForFrames() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'frameActivity') {
        activity.adopt(msg.entry);
        if (msg.notice) toast.show(msg.notice);
      }
      if (msg.action === 'frameActivityAmend') activity.adoptAmendment(msg.id, msg.patch);
    });
  }

  function start() {
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'role', 'aria-modal'],
    });
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onGesture(e);
    }, true);
    if (!IN_FRAME && ext.alive()) listenForFrames();
    if (document.body) rescan();
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
