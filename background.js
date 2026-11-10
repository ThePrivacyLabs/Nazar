// Nazar: background service worker
// Checks privacy policies against the DPDP notice checklist, caches the
// result, paints the tab badge, and keeps the activity history.

importScripts('shared/notice-checks.js');

const AI_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (AI policy reads, banner recipes)
// A text-match result is kept a day only, so a site checked while AI was
// off or out of budget is read by AI on a later visit.
const TEXT_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
// What the AI reads of a policy; the server reads the same amount.
const AI_POLICY_CHARS = 24000;
// Shorter than this, the policy link gave no readable text (a script-only
// shell, a block page), and every check would wrongly read as missing.
const MIN_POLICY_CHARS = 500;

// AI backend: reads privacy policies and finds reject buttons on unusual
// cookie banners (holds the Anthropic key server-side; the extension never
// sees it). Its answers are cached on the server per site, so a site is
// read once for everyone.
// Override for local testing via settings.apiUrl (e.g. http://localhost:3000/...).
const NAZAR_API = 'https://theprivacylabs.com/api/nazar/analyze';
const AI_DAILY_CAP = 100; // client-side cap; the server enforces its own too

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'pageReady') {
    handlePageReady(msg, sender.tab).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.action === 'checkNotice') {
    // policyText arrives pre-fetched from the content script (page context:
    // real cookies, real referer), not fetched here.
    getNoticeChecks(msg.origin, msg.policyUrl, msg.policyText, msg.forceRefresh)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse(null));
    return true;
  }
  if (msg.action === 'aiBannerRecipe') {
    getBannerRecipe(msg.origin, msg.candidates).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.action === 'controlClick') {
    rememberControlClick(sender.tab, msg.label);
  }
  if (msg.action === 'getLastControlClick') {
    lastControlClick(sender.tab).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.action === 'logActivity') {
    const entry = recordActivity(msg.entry, sender.tab);
    // Recorded inside a frame (a consent tool's iframe): the top frame owns
    // the page's list and the in-page note, so pass it on.
    if (entry && sender.frameId && sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, { action: 'frameActivity', entry, notice: msg.notice || null }, { frameId: 0 })
        .catch(() => {});
    }
  }
  if (msg.action === 'amendActivity') {
    const patch = amendActivity(msg.id, msg.patch);
    if (patch && sender.frameId && sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, { action: 'frameActivityAmend', id: msg.id, patch }, { frameId: 0 })
        .catch(() => {});
    }
  }
  if (msg.action === 'reportSite') {
    sendReport(msg).then(sendResponse).catch(() => sendResponse(false));
    return true;
  }
  if (msg.action === 'clearActivity') {
    clearActivity().then(() => sendResponse(true)).catch(() => sendResponse(false));
    return true;
  }
  if (msg.action === 'getSiteAllow') {
    isSiteAllowed(msg.host).then(sendResponse).catch(() => sendResponse(false));
    return true;
  }
  if (msg.action === 'setSiteAllow') {
    setSiteAllowed(msg.host, msg.allow).then(sendResponse).catch(() => sendResponse(false));
    return true;
  }
});

// ------------------------------------------------------------------
// Per-site escape hatch. Blocking happens inside Chrome's rule engine,
// so "don't block on this site" is expressed as a dynamic allow rule
// scoped to that domain, which overrides the static block rules.
// Rule IDs start high to avoid colliding with the static ruleset.
// ------------------------------------------------------------------
const ALLOW_RULE_BASE = 100000;

async function isSiteAllowed(host) {
  if (!host) return false;
  const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
  return allowedSites.includes(host);
}

async function setSiteAllowed(host, allow) {
  if (!host) return false;
  const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
  const next = allow
    ? (allowedSites.includes(host) ? allowedSites : [...allowedSites, host])
    : allowedSites.filter((h) => h !== host);
  await chrome.storage.local.set({ allowedSites: next });
  await syncAllowRules(next);
  return allow;
}

// Rebuild every allow rule from the stored list, so IDs always match.
async function syncAllowRules(allowList) {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing
      .filter((r) => r.id >= ALLOW_RULE_BASE)
      .map((r) => r.id);
    const addRules = allowList.map((host, i) => ({
      id: ALLOW_RULE_BASE + i,
      priority: 100, // must beat the static block rules (priority 1)
      action: { type: 'allow' },
      condition: {
        // Any request made while browsing this site is exempt
        initiatorDomains: [host.replace(/^www\./, '')],
        resourceTypes: [
          'script', 'image', 'xmlhttprequest', 'sub_frame', 'ping',
          'media', 'font', 'stylesheet', 'websocket', 'other',
        ],
      },
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn('Nazar: could not sync allow rules', e);
  }
}

// Re-apply allow rules on startup/update (dynamic rules persist, but this
// keeps them consistent if storage and rules ever drift apart).
chrome.runtime.onStartup.addListener(async () => {
  const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
  if (allowedSites.length) syncAllowRules(allowedSites);
});
chrome.runtime.onInstalled.addListener(async () => {
  const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
  if (allowedSites.length) syncAllowRules(allowedSites);
  dropLegacyGrades();
});

// The A-F grades cached by versions before the checklist ('policy:<origin>').
async function dropLegacyGrades() {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith('policy:'));
  if (stale.length) await chrome.storage.local.remove(stale);
}

// ------------------------------------------------------------------
// AI budget guards
// ------------------------------------------------------------------
async function aiAllowed() {
  const { settings = {}, aiBudget } = await chrome.storage.local.get(['settings', 'aiBudget']);
  if (settings.aiEnabled === false) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (aiBudget && aiBudget.date === today && aiBudget.count >= AI_DAILY_CAP) return false;
  return true;
}

async function spendAiBudget() {
  const { aiBudget } = await chrome.storage.local.get('aiBudget');
  const today = new Date().toISOString().slice(0, 10);
  const budget = aiBudget && aiBudget.date === today ? aiBudget : { date: today, count: 0 };
  budget.count += 1;
  await chrome.storage.local.set({ aiBudget: budget });
}

async function callNazarApi(payload) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const url = settings.apiUrl || NAZAR_API;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    // Only count against the daily cap when the server actually called the
    // model (server cache hits are free).
    if (!data.cached) await spendAiBudget();
    return data;
  } catch {
    return null;
  }
}

async function handlePageReady(msg, tab) {
  if (!tab || !tab.id) return null;
  const result = await getNoticeChecks(msg.origin, msg.policyUrl, msg.policyText, false);
  setBadge(tab.id, result);
  return result;
}

// ------------------------------------------------------------------
// The DPDP notice checklist for a site's privacy policy: the six things the
// DPDP Rules say a notice must tell you. The AI backend reads the policy
// first; the text match (shared/notice-checks.js) is the backup, and also
// answers any single item the AI could not back with a quote from the
// policy. The policy text is fetched by the content script, in the page's
// own JS context (real cookies, real Referer), so WAF-protected sites see
// an ordinary in-page request instead of a bot-like service-worker fetch.
//
// Results, by status:
//   checked     { source: 'ai' | 'text', checks: [{ key, found, quote,
//               note, by }], found, total, policyUrl }
//   no-policy   the page links no privacy policy
//   unreadable  the link gave no readable text; or the AI says it is not a
//               privacy policy; or, by text match alone, not one check is
//               found (a real policy at least says what it collects, so a
//               0/6 is almost always a link that landed on a home or help
//               page, and must not be shown as a bad policy)
// Only "checked" is cached: the other two may differ on the next page.
// ------------------------------------------------------------------
async function getNoticeChecks(origin, policyUrl, policyText, forceRefresh) {
  if (!origin) return null;
  const key = 'notice:' + origin;
  const cached = (await chrome.storage.local.get(key))[key];
  const ttl = cached && cached.source === 'ai' ? AI_CACHE_TTL_MS : TEXT_NOTICE_TTL_MS;
  if (!forceRefresh && cached && Date.now() - cached.ts < ttl) return cached;

  const base = { origin, policyUrl: policyUrl || null, ts: Date.now() };
  if (!policyUrl) return { ...base, status: 'no-policy' };
  if (!policyText || policyText.trim().length < MIN_POLICY_CHARS) return { ...base, status: 'unreadable' };

  const byText = NazarNotice.checkNotice(policyText).map((c) => ({ ...c, note: '', by: 'text' }));
  const ai = (await aiAllowed()) ? await readNoticeWithAi(origin, policyUrl, policyText, forceRefresh) : null;
  if (ai && ai.insufficient) return { ...base, status: 'unreadable' };

  const checks = ai ? mergeNoticeChecks(ai, byText) : byText;
  const found = checks.filter((c) => c.found).length;
  if (!ai && found === 0) return { ...base, status: 'unreadable' };
  const result = { ...base, status: 'checked', source: ai ? 'ai' : 'text', checks, found, total: NazarNotice.TOTAL };
  await chrome.storage.local.set({ [key]: result });
  return result;
}

// The AI's read of the policy, or null when it is off, over budget, down,
// or answered something other than the six items.
async function readNoticeWithAi(origin, policyUrl, policyText, forceRefresh) {
  // Pages often open with thousands of chars of navigation. Start the
  // window where the policy itself begins, so truncation never eats it.
  const start = policyText.search(/privacy policy|personal (data|information)|information we collect|data we collect/i);
  const from = start > 300 ? start - 100 : 0;
  const ai = await callNazarApi({
    type: 'notice',
    origin,
    policyUrl,
    policyText: policyText.slice(from, from + AI_POLICY_CHARS),
    forceRefresh: !!forceRefresh,
  });
  if (!ai) return null;
  if (ai.insufficient) return ai;
  const keys = new Set((Array.isArray(ai.items) ? ai.items : []).map((i) => i && i.key));
  return NazarNotice.CHECKS.every((c) => keys.has(c.key)) ? ai : null;
}

// One row per check, from the AI where it can stand behind its answer:
//   AI found it, with a quote the server found in the policy  -> AI
//   AI found it, but its quote is not in the policy           -> text match
//   AI did not find it, but only read part of a long policy,
//     and the text match finds it in the rest                 -> text match
//   AI did not find it                                        -> not found
function mergeNoticeChecks(ai, byText) {
  const aiByKey = new Map(ai.items.map((item) => [item.key, item]));
  return byText.map((text) => {
    const item = aiByKey.get(text.key);
    const note = clipText(item.note, 90);
    if (item.found && item.quote) return { key: text.key, found: true, quote: clipText(item.quote, 200), note, by: 'ai' };
    if (item.found || (ai.truncated && text.found)) return text;
    return { key: text.key, found: false, quote: '', note, by: 'ai' };
  });
}

// ------------------------------------------------------------------
// AI banner recipes: when local heuristics failed on a page that still
// shows a cookie banner, ask the backend which element rejects consent.
// Cached per origin (including "no banner found") for 30 days.
// ------------------------------------------------------------------
async function getBannerRecipe(origin, candidates) {
  if (!origin || !Array.isArray(candidates) || candidates.length === 0) return null;
  const key = 'recipe:' + origin;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && Date.now() - cached.ts < AI_CACHE_TTL_MS) return cached;
  if (!(await aiAllowed())) return null;

  const recipe = await callNazarApi({ type: 'banner', origin, candidates });
  if (!recipe) return null;
  const result = { ...recipe, ts: Date.now() };
  await chrome.storage.local.set({ [key]: result });
  return result;
}

// ------------------------------------------------------------------
// Badge: the checklist tally, "4/6". Green only when nothing is missing.
// ------------------------------------------------------------------
const BADGE_COLORS = { complete: '#16a34a', gaps: '#dc2626', unknown: '#6b7280' };

function setBadge(tabId, result) {
  const checked = !!result && result.status === 'checked';
  const text = checked ? `${result.found}/${result.total}` : '?';
  const color = !checked ? BADGE_COLORS.unknown
    : result.found === result.total ? BADGE_COLORS.complete : BADGE_COLORS.gaps;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ------------------------------------------------------------------
// The last button the person clicked in each tab. A multi-step flow often
// loads a new page per step, and the consent prompt on step 5 answers the
// click that ended step 4, which the old page's content script saw and the
// new one did not. Consent tools also open their notice in their own
// frame, which never saw the click that opened it. Both ask here.
// Recorded against the tab's page, not the frame clicked in, and handed
// back only while the tab is still on the same site. Session storage:
// gone when the browser closes.
// ------------------------------------------------------------------
const clickKey = (tabId) => 'click:' + tabId;

function tabHost(tab) {
  try { return new URL(tab.url).hostname; } catch { return ''; }
}

// Equal hosts, or one a subdomain of the other: site.com -> app.site.com
// is the same site, www.site.com -> app.site.com is not.
function sameSite(a, b) {
  const strip = (h) => h.replace(/^www\./, '');
  a = strip(a);
  b = strip(b);
  return !!a && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a));
}

function rememberControlClick(tab, label) {
  if (!tab || !tab.id) return;
  const click = { host: tabHost(tab), ts: Date.now(), label: clipText(label, 60) };
  chrome.storage.session.set({ [clickKey(tab.id)]: click }).catch(() => {});
}

async function lastControlClick(tab) {
  if (!tab || !tab.id) return null;
  const key = clickKey(tab.id);
  const click = (await chrome.storage.session.get(key))[key];
  return click && sameSite(click.host, tabHost(tab)) ? click : null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(clickKey(tabId)).catch(() => {});
});

// ------------------------------------------------------------------
// Activity: what Nazar did, per popup. The content scripts report; this
// worker is the only writer, so tabs logging at the same moment cannot
// overwrite each other. Stored on this device only, newest first.
// ------------------------------------------------------------------
const ACTIVITY_CAP = 300;
const ACTIVITY_KINDS = new Set(['cookie', 'prompt']);
const ACTIVITY_DECISIONS = new Set(['declined', 'accepted', 'required-only', 'left', 'flagged']);
// Decisions where Nazar actually answered a popup (the running total).
const ACTED_DECISIONS = new Set(['declined', 'accepted', 'required-only']);

const clipText = (value, max) => String(value || '').slice(0, max);
const clipPurposes = (list) => (Array.isArray(list) ? list : []).slice(0, 8).map((p) => clipText(p, 60));

let activityWrites = Promise.resolve();
function serialized(task) {
  activityWrites = activityWrites.then(task, task);
  return activityWrites;
}

// Returns the stored entry, or null if it was not a valid one. The site is
// the tab's page, which for a consent tool's frame is the site the person
// is actually using, not the tool's domain.
function recordActivity(entry, tab) {
  if (!entry || !ACTIVITY_KINDS.has(entry.kind) || !ACTIVITY_DECISIONS.has(entry.decision)) return null;
  const clean = {
    id: clipText(entry.id, 32),
    kind: entry.kind,
    decision: entry.decision,
    label: clipText(entry.label, 80),
    reason: clipText(entry.reason, 80),
    trigger: clipText(entry.trigger, 80),
    gave: clipPurposes(entry.gave),
    refused: clipPurposes(entry.refused),
    host: (tab && tabHost(tab)) || clipText(entry.host, 253),
    ts: Number(entry.ts) || Date.now(),
  };
  serialized(async () => {
    const { activity = [], stats = { totalBanners: 0, sites: {} } } =
      await chrome.storage.local.get(['activity', 'stats']);
    activity.unshift(clean);
    activity.length = Math.min(activity.length, ACTIVITY_CAP);
    // stats.totalBanners predates consent prompts; it now counts every
    // popup Nazar answered, and keeps its name so existing totals carry on.
    if (ACTED_DECISIONS.has(clean.decision)) {
      stats.totalBanners += 1;
      stats.sites[clean.host] = (stats.sites[clean.host] || 0) + 1;
    }
    await chrome.storage.local.set({ activity, stats });
  });
  return clean;
}

// Purposes a consent tool named after the entry was written (its confirm
// step). Returns the clean patch.
function amendActivity(id, patch) {
  if (!id || !patch) return null;
  const clean = { gave: clipPurposes(patch.gave), refused: clipPurposes(patch.refused) };
  serialized(async () => {
    const { activity = [] } = await chrome.storage.local.get('activity');
    const entry = activity.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, clean);
    await chrome.storage.local.set({ activity });
  });
  return clean;
}

function clearActivity() {
  return serialized(() => chrome.storage.local.set({ activity: [] }));
}

// ------------------------------------------------------------------
// "Report this site", from the popup, sent only on the person's click.
// The host name, not the page address (which can carry tokens or ids),
// what Nazar did on the page, and the person's note. Same server as the
// AI backend, so settings.apiUrl redirects both for local testing.
// Resolves true when the server stored it.
// ------------------------------------------------------------------
const REPORT_PROBLEMS = new Set(['not-handled', 'wrong-answer', 'site-broke']);

async function sendReport(msg) {
  if (typeof msg.host !== 'string' || !REPORT_PROBLEMS.has(msg.problem)) return false;
  const { settings = {} } = await chrome.storage.local.get('settings');
  const url = new URL('/api/nazar/report', settings.apiUrl || NAZAR_API);
  const actions = (Array.isArray(msg.actions) ? msg.actions : []).slice(-20).map((a) => ({
    kind: a.kind,
    decision: a.decision,
    label: clipText(a.label, 80),
    reason: clipText(a.reason, 80),
    trigger: clipText(a.trigger, 80),
    gave: clipPurposes(a.gave),
    refused: clipPurposes(a.refused),
  }));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: msg.host,
        problem: msg.problem,
        note: clipText(msg.note, 500),
        actions,
        extensionVersion: chrome.runtime.getManifest().version,
      }),
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
