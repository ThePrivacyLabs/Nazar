// Nazar, popup

const $ = (id) => document.getElementById(id);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const { settings = {}, stats } = await chrome.storage.local.get(['settings', 'stats']);
  bindSetting(settings, 'promptsToggle', 'promptsEnabled');
  bindSetting(settings, 'toastToggle', 'toastEnabled');
  bindSetting(settings, 'aiToggle', 'aiEnabled');

  const total = (stats && stats.totalBanners) || 0;
  $('totalHandled').textContent = `${total} popup${total === 1 ? '' : 's'} handled`;
  $('historyBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/history.html') });
    window.close();
  });

  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    showUnavailable('Open a website to see its privacy report.');
    return;
  }

  const url = new URL(tab.url);
  $('siteName').textContent = url.hostname;
  bindSiteAllow(tab, url.hostname);

  // Ask the content script for the live page report
  let report = null;
  try {
    report = await chrome.tabs.sendMessage(tab.id, { action: 'getPageReport' });
  } catch {
    // Content script not injected (page loaded before install, or blocked)
  }
  if (!report) {
    showUnavailable('Reload this page to activate the shield.');
    return;
  }

  renderActivity(report.actions || []);
  bindReport(url.hostname, report.actions || []);
  renderBlockedTrackers(tab.id);
  renderDetectedTrackers(report.trackers || []);
  renderCookieCount(tab.url);
  renderAlternatives(url.hostname);

  // Text is fetched by the content script (page context: real cookies,
  // real referer), not the background worker, so WAF-protected sites see
  // an ordinary in-page request instead of a bot-like service-worker
  // fetch. If a fresh pageReady cycle already cached a result,
  // background.js's cache check short-circuits before this text is even
  // needed.
  async function fetchAndCheck(forceRefresh) {
    let fetched = { url: report.policyUrl, text: '' };
    try {
      fetched = await chrome.tabs.sendMessage(tab.id, {
        action: 'fetchPolicyText',
        policyUrls: report.policyUrls,
      }) || fetched;
    } catch { /* content script unavailable; cache lookup may still hit */ }
    return chrome.runtime.sendMessage({
      action: 'checkNotice',
      origin: report.origin,
      policyUrl: fetched.url || report.policyUrl,
      policyText: fetched.text,
      forceRefresh,
    });
  }

  renderNotice(await fetchAndCheck(false));

  $('refreshBtn').addEventListener('click', async () => {
    $('noticeStatus').hidden = false;
    $('noticeStatus').textContent = 'Re-checking…';
    renderNotice(await fetchAndCheck(true));
  });
}

// A checkbox bound to one boolean in settings. Every setting defaults to on.
function bindSetting(settings, inputId, key) {
  const input = $(inputId);
  input.checked = settings[key] !== false;
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    chrome.storage.local.set({ settings });
  });
}

// Per-site escape hatch: pause tracker blocking if a site misbehaves.
async function bindSiteAllow(tab, host) {
  const toggle = $('siteAllowToggle');
  try {
    toggle.checked = await chrome.runtime.sendMessage({ action: 'getSiteAllow', host });
  } catch { /* background unavailable */ }
  toggle.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ action: 'setSiteAllow', host, allow: toggle.checked });
    chrome.tabs.reload(tab.id); // rules apply on next load
    window.close();
  });
}

function renderActivity(actions) {
  const list = $('activityList');
  list.replaceChildren(...actions.slice().reverse().map((entry) => renderActivityItem(entry)));
  $('activityEmpty').hidden = actions.length > 0;
  $('activityCount').textContent = actions.length > 0 ? actions.length : '';
}

// The six things the DPDP Rules say a privacy notice must tell you, found or
// not found in this site's policy: read by AI, or by text match when AI was
// not available (background.js, getNoticeChecks). Found rows carry the
// policy's own words on hover, so a tick can be checked by eye.
const NOTICE_SOURCE_TEXT = {
  ai: { label: 'AI', title: 'Read by AI. Every tick quotes the policy; hover a line to see it.' },
  text: {
    label: 'AI not available',
    title: 'AI could not read this policy just now (it may be turned off in settings, or busy), so Nazar checked its wording instead. That can miss unusual phrasing; Re-check tries AI again.',
  },
};
const NOTICE_STATUS_TEXT = {
  'no-policy': 'No privacy policy link on this page.',
  unreadable: 'Could not read a privacy policy here: the link may lead to another page, or the policy may load in a way Nazar cannot read.',
};

function renderNotice(result) {
  const status = $('noticeStatus');
  const list = $('noticeList');
  const tally = $('noticeTally');
  const policyLink = $('policyLink');

  policyLink.hidden = !(result && result.policyUrl);
  if (result && result.policyUrl) policyLink.href = result.policyUrl;

  if (!result || result.status !== 'checked') {
    status.hidden = false;
    status.textContent = (result && NOTICE_STATUS_TEXT[result.status]) || 'Could not check the privacy policy.';
    list.replaceChildren();
    tally.textContent = '';
    $('noticeMeta').hidden = true;
    return;
  }

  status.hidden = true;
  tally.textContent = `${result.found} of ${result.total}`;
  tally.className = 'notice-tally ' + (result.found === result.total ? 'good' : 'bad');
  const source = NOTICE_SOURCE_TEXT[result.source] || NOTICE_SOURCE_TEXT.text;
  const sourceEl = $('noticeSource');
  sourceEl.textContent = source.label;
  sourceEl.title = source.title;
  sourceEl.className = 'notice-source ' + (result.source === 'ai' ? 'ai' : 'text');
  $('noticeMeta').hidden = false;
  const byKey = new Map(result.checks.map((check) => [check.key, check]));
  list.replaceChildren(...NazarNotice.CHECKS.map((check) => {
    const outcome = byKey.get(check.key) || { found: false, quote: '', note: '' };
    const li = document.createElement('li');
    li.className = 'notice-item ' + (outcome.found ? 'found' : 'missing');
    const said = outcome.found ? `"${outcome.quote}"` : 'Not found in the policy.';
    li.title = [`${check.rule}: ${said}`, outcome.note].filter(Boolean).join('\n');
    const icon = document.createElement('span');
    icon.className = 'notice-icon';
    icon.textContent = outcome.found ? '✓' : '✕';
    const label = document.createElement('span');
    label.textContent = check.label;
    li.append(icon, label);
    return li;
  }));
}

// "Report this site": tells Privacy Labs a popup here was handled wrong.
// Sends only on the person's click, and only the host name, what Nazar did
// on this page and their note (background.js, sendReport).
function bindReport(host, actions) {
  const form = $('reportForm');
  const open = $('reportOpen');
  const result = $('reportResult');

  open.addEventListener('click', () => {
    open.hidden = true;
    result.hidden = true;
    form.hidden = false;
  });
  $('reportCancel').addEventListener('click', () => {
    form.hidden = true;
    open.hidden = false;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const send = $('reportSend');
    send.disabled = true;
    send.textContent = 'Sending…';
    let sent = false;
    try {
      sent = await chrome.runtime.sendMessage({
        action: 'reportSite',
        host,
        problem: form.elements.problem.value,
        note: $('reportNote').value.trim(),
        actions,
      });
    } catch { /* background unavailable */ }
    send.disabled = false;
    send.textContent = 'Send report';
    if (!sent) {
      result.textContent = 'Could not send the report. Please try again in a moment.';
      result.className = 'report-result bad';
      result.hidden = false;
      return;
    }
    form.hidden = true;
    form.reset();
    result.textContent = 'Thanks, report sent. We look at every reported site.';
    result.className = 'report-result good';
    result.hidden = false;
  });
}

// Trackers are BLOCKED by declarativeNetRequest rules; this reads the
// engine's match log for the tab and names each blocked company.
async function renderBlockedTrackers(tabId) {
  const count = $('trackerCount');
  let blockedRequests = 0;
  const companies = new Set();
  try {
    const matched = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    for (const info of matched.rulesMatchedInfo || []) {
      const name = TRACKER_RULE_NAMES[info.rule.ruleId];
      if (!name) continue; // the GPC header rule matches everything; skip it
      blockedRequests++;
      companies.add(name);
    }
  } catch { /* feedback API unavailable */ }
  count.textContent = blockedRequests;
  count.className = 'fact-value ' + (blockedRequests > 0 ? 'good' : '');
  renderChips($('trackerList'), [...companies], 'blocked', (name) => name + ' ✕');
}

// Scripts detected on the page that we do NOT block (tag managers like GTM,
// and anything the blocklist doesn't cover). Shown for transparency, never
// held against the site: the checklist reads the privacy policy only.
function renderDetectedTrackers(detected) {
  const blockedNames = new Set(Object.values(TRACKER_RULE_NAMES));
  const unblocked = detected.filter((name) => !blockedNames.has(name));
  $('detectedRow').hidden = unblocked.length === 0;
  $('detectedCount').textContent = unblocked.length;
  renderChips($('detectedList'), unblocked, 'neutral', (name) => name,
    'Detected but not blocked. Tag managers load site functionality too, so blocking them breaks pages; the trackers they load are blocked individually.');
}

function renderChips(container, names, cls, label, title) {
  container.replaceChildren(...names.map((name) => {
    const chip = document.createElement('span');
    chip.className = 'chip ' + cls;
    chip.textContent = label(name);
    if (title) chip.title = title;
    return chip;
  }));
}

async function renderCookieCount(tabUrl) {
  const el = $('cookieCount');
  const btn = $('clearCookiesBtn');
  async function refresh() {
    try {
      const cookies = await chrome.cookies.getAll({ url: tabUrl });
      el.textContent = cookies.length;
      el.className = cookies.length > 15 ? 'bad' : '';
      btn.hidden = cookies.length === 0;
    } catch {
      el.textContent = '-';
      btn.hidden = true;
    }
  }
  await refresh();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    await clearCookiesForUrl(tabUrl);
    await refresh();
    btn.disabled = false;
    btn.textContent = 'Clear';
    el.textContent = '0, cleared ✓';
    el.className = 'good';
  });
}

// Removes every cookie readable for this URL. Cookies are set per-domain, so
// getAll+remove is precise and needs no permission beyond "cookies".
async function clearCookiesForUrl(tabUrl) {
  try {
    const cookies = await chrome.cookies.getAll({ url: tabUrl });
    await Promise.all(
      cookies.map((c) => {
        // Reconstruct the cookie's URL (a cookie's domain may differ from the page)
        const scheme = c.secure ? 'https://' : 'http://';
        const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        return chrome.cookies.remove({ url: scheme + host + c.path, name: c.name }).catch(() => {});
      })
    );
  } catch { /* ignore */ }
}

function renderAlternatives(hostname) {
  const alts = findAlternatives(hostname);
  if (!alts) return;
  $('altList').replaceChildren(...alts.map((alt) => {
    const a = document.createElement('a');
    a.className = 'alt-item';
    a.href = alt.url;
    a.target = '_blank';
    const name = document.createElement('span');
    name.className = 'alt-name';
    name.textContent = (alt.in ? '🇮🇳 ' : '') + alt.name;
    const note = document.createElement('span');
    note.className = 'alt-note';
    note.textContent = alt.note;
    a.append(name, note);
    return a;
  }));
  $('alternatives').hidden = false;
}

function showUnavailable(message) {
  $('pageReport').hidden = true;
  $('siteAllowRow').hidden = true;
  const notice = $('unavailable');
  notice.textContent = message;
  notice.hidden = false;
}

init();
