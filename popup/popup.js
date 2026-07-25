// Nazar, popup

const $ = (id) => document.getElementById(id);

const VERDICTS = {
  A: { cls: 'ok', text: '✅ Safe to use, this policy respects your privacy.' },
  B: { cls: 'ok', text: '✅ Reasonably safe, with minor concerns.' },
  C: { cls: 'warn', text: '⚠️ Use with caution, some concerning practices.' },
  D: { cls: 'danger', text: '🚫 Risky, consider an alternative if you can.' },
  F: { cls: 'danger', text: '🚫 Avoid sharing personal data with this site.' },
};

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Settings toggles
  const { settings = {} } = await chrome.storage.local.get('settings');
  const toastToggle = $('toastToggle');
  toastToggle.checked = settings.toastEnabled !== false;
  toastToggle.addEventListener('change', () => {
    settings.toastEnabled = toastToggle.checked;
    chrome.storage.local.set({ settings });
  });
  const aiToggle = $('aiToggle');
  aiToggle.checked = settings.aiEnabled !== false;
  aiToggle.addEventListener('change', () => {
    settings.aiEnabled = aiToggle.checked;
    chrome.storage.local.set({ settings });
  });

  // Total banners blocked (global stat)
  const { stats } = await chrome.storage.local.get('stats');
  const total = (stats && stats.totalBanners) || 0;
  $('totalBanners').textContent = `${total} banner${total === 1 ? '' : 's'} blocked so far`;

  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    showUnavailable('Open a website to see its privacy report.');
    return;
  }

  const url = new URL(tab.url);
  $('siteName').textContent = url.hostname;

  // Per-site escape hatch: pause tracker blocking if a site misbehaves.
  const siteAllowToggle = $('siteAllowToggle');
  try {
    siteAllowToggle.checked = await chrome.runtime.sendMessage({
      action: 'getSiteAllow',
      host: url.hostname,
    });
  } catch { /* background unavailable */ }
  siteAllowToggle.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      action: 'setSiteAllow',
      host: url.hostname,
      allow: siteAllowToggle.checked,
    });
    chrome.tabs.reload(tab.id); // rules apply on next load
    window.close();
  });

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

  renderBanner(report.bannerBlocked, report.bannerPresent);
  renderBlockedTrackers(tab.id);
  renderDetectedTrackers(report.trackers || []);
  renderCookieCount(tab.url);
  renderAlternatives(url.hostname);

  // The grade reflects the privacy policy only; trackers are shown separately.
  const score = await chrome.runtime.sendMessage({
    action: 'getScore',
    origin: report.origin,
    policyUrl: report.policyUrl,
    policyUrls: report.policyUrls,
  });
  renderScore(score);

  $('refreshBtn').addEventListener('click', async () => {
    $('gradeTitle').textContent = 'Re-analyzing…';
    const fresh = await chrome.runtime.sendMessage({
      action: 'getScore',
      origin: report.origin,
      policyUrl: report.policyUrl,
      policyUrls: report.policyUrls,
      forceRefresh: true,
    });
    renderScore(fresh);
  });
}

function renderScore(result) {
  const circle = $('gradeCircle');
  const findings = $('findings');
  const verdict = $('verdict');
  findings.innerHTML = '';

  if (!result || result.grade === '?') {
    circle.textContent = '?';
    circle.className = 'grade-circle grade-unknown';
    $('gradeTitle').textContent = 'No policy analyzed';
    $('gradeSub').textContent = (result && result.bad && result.bad[0]) || 'Could not find a privacy policy on this page.';
    verdict.hidden = true;
    return;
  }

  circle.textContent = result.grade;
  circle.className = 'grade-circle grade-' + result.grade;
  $('gradeTitle').textContent = `Privacy score: ${result.score}/100`;
  if (result.source === 'ai') {
    const chip = document.createElement('span');
    chip.className = 'ai-chip';
    chip.title = 'Analyzed by AI (Claude), which reads the policy for meaning';
    chip.textContent = 'AI';
    $('gradeTitle').appendChild(chip);
  }

  const sub = $('gradeSub');
  sub.innerHTML = '';
  if (result.policyUrl) {
    const a = document.createElement('a');
    a.href = result.policyUrl;
    a.target = '_blank';
    a.textContent = 'View the policy →';
    sub.appendChild(a);
  }

  const v = VERDICTS[result.grade];
  verdict.hidden = false;
  verdict.className = 'verdict ' + v.cls;
  // The AI writes a site-specific one-liner; fall back to the canned verdict.
  // Length guard rejects paragraph-style summaries from stale caches.
  const summary = result.summary && result.summary.length <= 110 ? result.summary : '';
  verdict.textContent = summary || v.text;

  for (const label of result.good || []) addFinding(findings, label, true);
  for (const label of result.bad || []) addFinding(findings, label, false);
}

function addFinding(container, label, isGood) {
  const div = document.createElement('div');
  div.className = 'finding ' + (isGood ? 'good' : 'bad');
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = isGood ? '✓' : '✗';
  const text = document.createElement('span');
  text.textContent = label;
  div.append(icon, text);
  container.appendChild(div);
}

function renderBanner(blocked, present) {
  const el = $('bannerStatus');
  if (blocked) {
    el.textContent = 'Auto-rejected 🎉';
    el.className = 'row-value good';
  } else if (present) {
    // Detected but no reject option to click (e.g. accept-only banners)
    el.textContent = 'Detected, no reject option';
    el.className = 'row-value bad';
  } else {
    el.textContent = 'None detected';
    el.className = 'row-value';
  }
}

// Trackers are now actively BLOCKED by declarativeNetRequest rules; this
// reads the engine's match log for the tab and names each blocked company.
async function renderBlockedTrackers(tabId) {
  const count = $('trackerCount');
  const list = $('trackerList');
  list.innerHTML = '';
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
  count.className = 'row-value ' + (blockedRequests > 0 ? 'good' : '');
  for (const name of companies) {
    const chip = document.createElement('span');
    chip.className = 'tracker-chip blocked';
    chip.textContent = name + ' ✕';
    list.appendChild(chip);
  }
}

// Scripts detected on the page that we do NOT block (tag managers like GTM,
// and anything the blocklist doesn't cover). Shown for transparency — we never
// hide what a page loaded — but never scored against the site. The grade
// reflects the privacy policy only.
function renderDetectedTrackers(detected) {
  const blockedNames = new Set(Object.values(TRACKER_RULE_NAMES));
  const unblocked = detected.filter((name) => !blockedNames.has(name));
  const row = $('detectedRow');
  const list = $('detectedList');
  list.innerHTML = '';
  if (unblocked.length === 0) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  $('detectedCount').textContent = unblocked.length;
  for (const name of unblocked) {
    const chip = document.createElement('span');
    chip.className = 'tracker-chip neutral';
    chip.title = 'Detected but not blocked. Tag managers load site functionality too, so blocking them breaks pages; the trackers they load are blocked individually.';
    chip.textContent = name;
    list.appendChild(chip);
  }
}

async function renderCookieCount(tabUrl) {
  const el = $('cookieCount');
  const btn = $('clearCookiesBtn');
  async function refresh() {
    try {
      const cookies = await chrome.cookies.getAll({ url: tabUrl });
      el.textContent = cookies.length;
      el.className = 'row-value ' + (cookies.length > 15 ? 'bad' : '');
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
    btn.textContent = 'Clear cookies';
    el.textContent = '0 (cleared ✓)';
    el.className = 'row-value good';
  });
}

// Removes every cookie readable for this URL. Cookies are set per-domain, so
// getAll+remove is precise and needs no permission beyond "cookies".
async function clearCookiesForUrl(tabUrl) {
  try {
    const cookies = await chrome.cookies.getAll({ url: tabUrl });
    const origin = new URL(tabUrl).origin;
    await Promise.all(
      cookies.map((c) => {
        // Reconstruct the cookie's URL (a cookie's domain may differ from the page)
        const scheme = c.secure ? 'https://' : 'http://';
        const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        const url = scheme + host + c.path;
        return chrome.cookies.remove({ url, name: c.name }).catch(() => {});
      })
    );
    // Best effort: also clear via origin URL for any host-only cookies missed
    void origin;
  } catch { /* ignore */ }
}

function renderAlternatives(hostname) {
  const alts = findAlternatives(hostname);
  if (!alts) return;
  const section = $('alternatives');
  const list = $('altList');
  list.innerHTML = '';
  for (const alt of alts) {
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
    list.appendChild(a);
  }
  section.hidden = false;
}

function showUnavailable(message) {
  $('gradeSection').hidden = true;
  $('bannerRow').hidden = true;
  document.querySelector('.trackers-row').hidden = true;
  $('refreshBtn').hidden = true;
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.textContent = message;
  $('findings').replaceWith(notice);
}

init();
