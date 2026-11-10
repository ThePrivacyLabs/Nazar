// Nazar, the record of what Nazar did on this page.
//
// Every automatic action is recorded twice: in memory here, which the popup
// reads as "Handled on this page", and in the background worker's history,
// which is the only writer of persistent storage.
//
// An entry answers the person's question, "what did I agree to?": the
// decision, the click that led to it (their own words for what they were
// doing), and the purposes given and refused, where the prompt names them.
(() => {
  const N = (globalThis.Nazar = globalThis.Nazar || {});

  const KIND = Object.freeze({ COOKIE: 'cookie', PROMPT: 'prompt' });

  const DECISION = Object.freeze({
    DECLINED: 'declined',           // consent refused
    ACCEPTED: 'accepted',           // consent given
    REQUIRED_ONLY: 'required-only', // the required purposes given, the rest refused
    LEFT: 'left',                   // Nazar stood down; the person answers
    FLAGGED: 'flagged',             // no way to refuse was offered
  });

  const MAX_TEXT = 80;
  const MAX_PURPOSES = 8;
  const MAX_PURPOSE_TEXT = 60;

  const clip = (value, max) => String(value || '').trim().slice(0, max);
  const purposes = (list) => [...new Set((list || []).map((p) => clip(p, MAX_PURPOSE_TEXT)).filter(Boolean))]
    .slice(0, MAX_PURPOSES);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const pageLog = [];

  // `notice` travels with the entry when this runs in a subframe, so the
  // top frame can show it (see background.js, frameActivity).
  function record({ kind, decision, label, reason, trigger, gave, refused }, notice) {
    const entry = {
      id: newId(),
      kind,
      decision,
      label: clip(label, MAX_TEXT),
      reason: clip(reason, MAX_TEXT),
      trigger: clip(trigger, MAX_TEXT),
      gave: purposes(gave),
      refused: purposes(refused),
      host: location.hostname,
      ts: Date.now(),
    };
    pageLog.push(entry);
    N.ext.send({ action: 'logActivity', entry, notice: notice || null });
    return entry;
  }

  // Purposes learnt after the entry was written: a consent tool's "Confirm
  // your choice" step names what is being granted only once it opens.
  function amend(entry, { gave, refused }) {
    const patch = {
      gave: purposes([...entry.gave, ...(gave || [])]),
      refused: purposes([...entry.refused, ...(refused || [])]),
    };
    Object.assign(entry, patch);
    N.ext.send({ action: 'amendActivity', id: entry.id, patch });
  }

  // An entry recorded, or amended, in one of this page's frames, relayed
  // here so the page's list is complete. Already stored by the background.
  function adopt(entry) {
    pageLog.push(entry);
  }

  function adoptAmendment(id, patch) {
    const entry = pageLog.find((e) => e.id === id);
    if (entry) Object.assign(entry, { gave: purposes(patch.gave), refused: purposes(patch.refused) });
  }

  function list() {
    return pageLog.map((entry) => ({ ...entry }));
  }

  N.activity = Object.freeze({ KIND, DECISION, record, amend, adopt, adoptAmendment, list });
})();
