// Nazar: background service worker
// Fetches privacy policies, scores them, caches results, and paints the tab badge.

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (regex results)
const AI_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (AI results)

// AI backend (holds the Anthropic key server-side; the extension never sees it).
// Override for local testing via settings.apiUrl (e.g. http://localhost:3000/...).
const NAZAR_API = 'https://theprivacylabs.com/api/nazar/analyze';
const AI_DAILY_CAP = 25; // client-side cap; the server enforces its own too

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'pageReady') {
    handlePageReady(msg, sender.tab).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.action === 'getScore') {
    // The grade reflects the site's PRIVACY POLICY only. Tracker behaviour is
    // shown separately in the popup as plain facts (blocked / also present),
    // never folded into the letter grade.
    getScore(msg.origin, msg.policyUrls || [msg.policyUrl], msg.forceRefresh)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse(null));
    return true;
  }
  if (msg.action === 'aiBannerRecipe') {
    getBannerRecipe(msg.origin, msg.candidates).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (msg.action === 'bannerBlocked') {
    bumpBannerStats(msg.host);
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
});

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
  // Grade = policy only. Trackers are a separate factual display in the popup.
  const result = await getScore(msg.origin, msg.policyUrls || [msg.policyUrl], false);
  setBadge(tab.id, result);
  return result;
}

// ------------------------------------------------------------------
// Policy text acquisition. Fetches happen HERE, in the user's browser,
// never on the server: browser requests carry a real UA and aren't bot-
// blocked the way datacenter requests are. If a fetched page turns out to
// be a nav menu or JS shell (barely any text), follow the privacy-looking
// links inside it, up to 4 fetches total, and keep the meatiest page.
// ------------------------------------------------------------------
const GOOD_POLICY_MIN_CHARS = 1500;

async function fetchPolicyPage(url) {
  try {
    const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12000) });
    const html = await res.text();
    return { url, html, text: htmlToText(html) };
  } catch {
    return null;
  }
}

function extractPolicyLinks(html, baseUrl) {
  const links = [];
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null && links.length < 10) {
    const raw = m[1];
    if (!/privacy|dpdp|data[-_]?protection|policy/i.test(raw)) continue;
    try {
      const abs = new URL(raw, baseUrl).href;
      if (/^https?:/.test(abs)) links.push(abs);
    } catch { /* ignore bad hrefs */ }
  }
  return links;
}

async function fetchBestPolicyText(policyUrls) {
  const queue = [...policyUrls];
  const tried = new Set();
  let best = { url: null, text: '' };
  while (queue.length > 0 && tried.size < 4) {
    const url = queue.shift();
    if (!url || tried.has(url)) continue;
    tried.add(url);
    const page = await fetchPolicyPage(url);
    if (!page) continue;
    if (page.text.length > best.text.length) best = { url: page.url, text: page.text };
    if (best.text.length >= GOOD_POLICY_MIN_CHARS) return best;
    // Thin page: it's probably a menu or hub, follow its policy-ish links
    for (const link of extractPolicyLinks(page.html, page.url)) {
      if (!tried.has(link)) queue.push(link);
    }
  }
  return best;
}

async function getScore(origin, policyUrls, forceRefresh) {
  if (!origin) return null;
  policyUrls = (policyUrls || []).filter(Boolean);
  const key = 'policy:' + origin;
  const cached = (await chrome.storage.local.get(key))[key];
  if (!forceRefresh && cached) {
    // Only results from the current AI prompt version get the long TTL;
    // regex results and old-prompt AI results are upgrade candidates.
    const isCurrentAi = cached.source === 'ai' && cached.v === 2;
    const ttl = isCurrentAi ? AI_CACHE_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - cached.ts < ttl) {
      const upgradable =
        !isCurrentAi &&
        Date.now() - (cached.aiTriedTs || 0) > 24 * 60 * 60 * 1000 &&
        (await aiAllowed());
      if (!upgradable) return cached;
    }
  }
  if (policyUrls.length === 0) {
    const result = { origin, grade: '?', score: null, good: [], bad: ['No privacy policy link found on this page'], policyUrl: null, ts: Date.now() };
    await chrome.storage.local.set({ [key]: result });
    return result;
  }

  const best = await fetchBestPolicyText(policyUrls);
  if (!best.text) {
    return { origin, grade: '?', score: null, good: [], bad: ['Could not fetch the privacy policy'], policyUrl: policyUrls[0], ts: Date.now() };
  }

  // AI path: the browser-fetched text goes to the backend, so the model
  // reads exactly what the user's browser sees. Any failure, cap, opt-out,
  // or "this is not actually a policy" verdict falls through to regex.
  if (await aiAllowed()) {
    // Pages often open with thousands of chars of nav/menu boilerplate.
    // Start the 24K window where the actual policy content begins so
    // truncation never eats the document itself.
    const startIdx = best.text.search(/privacy policy|personal (data|information)|information we collect|data we collect/i);
    const from = startIdx > 300 ? startIdx - 100 : 0;
    const ai = await callNazarApi({
      type: 'policy',
      origin,
      policyUrl: best.url,
      policyText: best.text.slice(from, from + 24000),
      forceRefresh: !!forceRefresh,
    });
    if (ai && ai.grade && ai.grade !== '?' && !ai.insufficient) {
      const result = { ...ai, ts: Date.now() };
      await chrome.storage.local.set({ [key]: result });
      return result;
    }
  }

  // aiTriedTs records that AI was attempted and failed, so the upgrade
  // check above retries at most once a day instead of on every page load.
  const result = { origin, policyUrl: best.url, ts: Date.now(), source: 'regex', aiTriedTs: Date.now(), ...scorePolicy(best.text) };
  await chrome.storage.local.set({ [key]: result });
  return result;
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

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    // Normalize smart quotes to straight quotes and drop other punctuation
    // marks entirely so a wrapped word like `don't "sell"` still matches
    // regexes that expect the word to sit right after whitespace.
    .replace(/[‘’“”«»]/g, "'")
    .replace(/['"]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// ------------------------------------------------------------------
// Heuristic policy scoring: start at 50, add/subtract weighted signals
// ------------------------------------------------------------------
const GOOD_SIGNALS = [
  { re: /(do(es)?\s+not|don.?t|doesn.?t|never|will not)\s+sell\s+(your\s+)?(personal\s+)?(data|information)|no\s+(sale|selling)\s+of\s+(your\s+)?(personal\s+)?(data|information)/, w: 12, label: 'States it does not sell your data' },
  { re: /right to (erasure|be forgotten|deletion|delete)|(request|requesting)\b.{0,40}(delet(e|ion)|erasure)/, w: 8, label: 'Grants right to delete your data' },
  { re: /digital personal data protection|dpdp act/, w: 8, label: 'References India’s DPDP Act' },
  { re: /grievance officer/, w: 6, label: 'Names a grievance officer (DPDP requirement)' },
  { re: /data protection officer/, w: 5, label: 'Has a data protection officer' },
  { re: /gdpr|general data protection regulation/, w: 4, label: 'References GDPR' },
  { re: /encrypt(ed|ion)/, w: 4, label: 'Mentions encryption of data' },
  { re: /opt[- ]?out/, w: 4, label: 'Provides opt-out mechanisms' },
  { re: /reten(tion period|tained? for)\s|retain(ed)?\s.{0,40}(days|months|years)/, w: 5, label: 'States a specific data retention period' },
  { re: /withdraw (your )?consent/, w: 4, label: 'Allows withdrawing consent' },
  { re: /(download|export|portability of) your (data|information)/, w: 3, label: 'Supports data export / portability' },
];

const BAD_SIGNALS = [
  { re: /(sell|sale of)\s+(your\s+)?(personal\s+)?(data|information)/, w: -15, label: 'May sell personal data', unlessGood: 0 },
  { re: /share\b.{0,80}(third[- ]?part(y|ies)|advertis|partner|affiliate)/, w: -10, label: 'Shares data with third parties / advertisers' },
  { re: /(retain|store|keep)\b.{0,60}(indefinitely|as long as (necessary|we))/, w: -8, label: 'Vague or indefinite data retention' },
  { re: /(targeted|interest[- ]based|personali[sz]ed)\s+advertis/, w: -8, label: 'Uses data for targeted advertising' },
  { re: /(change|update|modify)\b.{0,50}(policy|terms)\b.{0,80}without\s+(prior\s+)?notice/, w: -8, label: 'Can change the policy without notice' },
  { re: /fingerprint(ing)?|device identifiers?/, w: -5, label: 'Uses device fingerprinting / identifiers' },
  { re: /(cross[- ]site|third[- ]party)\s+(tracking|cookies)/, w: -6, label: 'Uses third-party tracking cookies' },
  { re: /transfer\b.{0,60}(outside|other countries|internationally)/, w: -4, label: 'Transfers data across borders' },
];

function scorePolicy(text) {
  const good = [];
  const bad = [];
  let score = 50;

  if (text.length < 1500) {
    bad.push('Policy is unusually short or could not be read properly');
    score -= 10;
  }

  for (const sig of GOOD_SIGNALS) {
    if (sig.re.test(text)) { good.push(sig.label); score += sig.w; }
  }
  for (const sig of BAD_SIGNALS) {
    // "does not sell" already matched as good, don't also penalize "sell"
    if (sig.unlessGood !== undefined && good.includes(GOOD_SIGNALS[sig.unlessGood].label)) continue;
    if (sig.re.test(text)) { bad.push(sig.label); score += sig.w; }
  }

  score = Math.max(0, Math.min(100, score));
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  return { score, grade, good, bad };
}

// ------------------------------------------------------------------
// Badge
// ------------------------------------------------------------------
const GRADE_COLORS = { A: '#16a34a', B: '#65a30d', C: '#d97706', D: '#dc2626', F: '#991b1b', '?': '#6b7280' };

function setBadge(tabId, result) {
  const grade = result && result.grade ? result.grade : '?';
  chrome.action.setBadgeText({ tabId, text: grade }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: GRADE_COLORS[grade] || '#6b7280' }).catch(() => {});
}

// ------------------------------------------------------------------
// Stats
// ------------------------------------------------------------------
async function bumpBannerStats(host) {
  const { stats = { totalBanners: 0, sites: {} } } = await chrome.storage.local.get('stats');
  stats.totalBanners += 1;
  stats.sites[host] = (stats.sites[host] || 0) + 1;
  await chrome.storage.local.set({ stats });
}
