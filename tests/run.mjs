// Nazar end-to-end tests: loads the unpacked extension into Chromium and
// drives real popups at it.
//
//   npm test                 fixture cases only (local, no network writes)
//   npm test -- --live       also theprivacylabs.com/book-demo (the consent
//                            grant and the booking itself are intercepted,
//                            so no record or lead reaches the live site)
//   npm test -- --headed     watch it run
//   npm test -- --shots      save popup + history screenshots to tests/out

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '..');
const args = new Set(process.argv.slice(2));
// Long enough for a prompt Nazar answers to close, with the first retry
// (consent-prompts.js FOLLOW_UP_MS); a frame case waits for its own answer.
const SETTLE_MS = 1300;

// ---------------------------------------------------------------
// Harness
// ---------------------------------------------------------------
// Reports the extension sends to the fixture server's stand-in for
// theprivacylabs.com/api/nazar/report, in arrival order.
const receivedReports = [];

// The fixture server's stand-in for theprivacylabs.com/api/nazar/analyze:
// `aiBackend.reply` answers a policy read (null answers 500, as a down or
// over-budget backend does); every request is kept in `aiBackend.requests`.
const aiBackend = { reply: null, requests: [] };

function serveFixtures() {
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/nazar/analyze') {
      let body = '';
      for await (const chunk of req) body += chunk;
      aiBackend.requests.push(JSON.parse(body));
      if (!aiBackend.reply) {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"analysis_failed"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(aiBackend.reply));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/nazar/report') {
      let body = '';
      for await (const chunk of req) body += chunk;
      receivedReports.push(JSON.parse(body));
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"success":true,"data":{"id":"r1"}}');
      return;
    }
    try {
      const file = path.join(here, 'fixtures', path.basename(new URL(req.url, 'http://x').pathname));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const results = [];
const openPages = new Set();
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  } finally {
    await Promise.all([...openPages].map((page) => page.close()));
    openPages.clear();
  }
}

function expect(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

// What the content script says it did on the tab showing `url`.
const pageActions = (url) => worker.evaluate(async (u) => {
  const [tab] = await chrome.tabs.query({ url: u });
  return (await chrome.tabs.sendMessage(tab.id, { action: 'getPageReport' })).actions;
}, url);
const promptActions = async (url) =>
  (await pageActions(url)).filter((a) => a.kind === 'prompt').map((a) => [a.decision, a.reason]);
// What the popup's "Handled on this page" row is built from.
const promptRecords = async (url) => (await pageActions(url)).filter((a) => a.kind === 'prompt')
  .map(({ decision, trigger, gave, refused }) => ({ decision, trigger, gave, refused }));

const dataset = (page, key) => page.evaluate((k) => document.body.dataset[k] ?? null, key);
const overlayCount = (page) => page.locator('.overlay, .bar').count();

// ---------------------------------------------------------------
// Run
// ---------------------------------------------------------------
const server = await serveFixtures();
const fixtureUrl = `http://127.0.0.1:${server.address().port}/prompts.html`;
const profileDir = mkdtempSync(path.join(tmpdir(), 'nazar-test-'));

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chromium', // new headless mode, which can load extensions
  headless: !args.has('--headed'),
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    // A second hostname for the same server, so the consent-tool fixture
    // loads cross-origin, the way a real consent tool's frame does.
    '--host-resolver-rules=MAP consent.test 127.0.0.1, MAP shop.test 127.0.0.1, MAP ai.test 127.0.0.1, MAP down.test 127.0.0.1',
  ],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

// The AI banner fallback would call the live backend on a page that mentions
// cookies; the fixtures are about local behaviour only.
// Reports go to the fixture server (background.js derives the report URL
// from apiUrl), never to the live site.
await worker.evaluate((apiUrl) => chrome.storage.local.set({ settings: { aiEnabled: false, apiUrl } }),
  `http://127.0.0.1:${server.address().port}/api/nazar/analyze`);

// The popup, opened as if its toolbar button were clicked on `page`'s tab.
async function openPopupFor(page, { height = 760 } = {}) {
  const tab = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0], page.url());
  const popup = await newPage();
  await popup.addInitScript((t) => { chrome.tabs.query = async () => [t]; }, tab);
  await popup.setViewportSize({ width: 344, height });
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  return popup;
}

async function newPage() {
  const page = await context.newPage();
  openPages.add(page);
  return page;
}

async function fixture(trigger) {
  const page = await newPage();
  await page.goto(fixtureUrl);
  await page.click(trigger);
  await page.waitForTimeout(SETTLE_MS);
  return page;
}

console.log('\nConsent prompts, fixtures');

await test('optional extra purpose (marketing) is declined before paint', async () => {
  const page = await fixture('#open-optional');
  expect(await dataset(page, 'optional'), 'declined', 'answer');
  const ms = Number(await dataset(page, 'optionalMs'));
  if (!(ms < 50)) throw new Error(`took ${ms}ms from insertion to decline, want < 50ms`);
});

await test('required notice is acknowledged', async () => {
  const page = await fixture('#open-required');
  expect(await dataset(page, 'required'), 'accepted', 'answer');
});

await test('itemised purposes: optional off, required untouched, saved', async () => {
  const page = await fixture('#open-itemised');
  expect(JSON.parse(await dataset(page, 'itemised')), { essential: true, analytics: false, marketing: false }, 'saved state');
  expect(await promptRecords(fixtureUrl), [{
    decision: 'required-only', trigger: 'Itemised purposes',
    gave: ['Account security'], refused: ['Product analytics', 'Marketing'],
  }], 'recorded');
});

await test('native <dialog> opened with showModal is declined', async () => {
  const page = await fixture('#open-dialog');
  expect(await dataset(page, 'dialog'), 'declined', 'answer');
});

await test('late-bound handler is retried and declined', async () => {
  const page = await fixture('#open-late');
  expect(await dataset(page, 'late'), 'declined', 'answer');
});

await test('prompt asking for what the click asked for is accepted', async () => {
  const page = await fixture('#open-service');
  expect(await dataset(page, 'service'), 'allowed', 'answer');
  expect(await promptRecords(fixtureUrl), [{
    decision: 'accepted', trigger: 'Book a demo (asks for what you clicked)',
    gave: ['Can we use your details to book your demo?'], refused: [],
  }], 'recorded');
});

await test('same prompt raised with no click is declined', async () => {
  const page = await newPage();
  await page.goto(fixtureUrl + '?onload=1');
  await page.waitForTimeout(SETTLE_MS);
  expect(await dataset(page, 'onload'), 'declined', 'answer');
});

await test('prompt on the next page of a flow answers the click that led there', async () => {
  const page = await fixture('#next-step');
  expect(new URL(page.url()).search, '?onload=1', 'navigated');
  expect(await dataset(page, 'onload'), 'allowed', 'answer');
});

await test('gated extra purpose: declined once, left to the person when they ask again', async () => {
  const page = await fixture('#open-gate');
  expect(await dataset(page, 'gate'), 'declined:1', 'first answer');
  await page.click('#open-gate');
  await page.waitForTimeout(SETTLE_MS);
  expect(await dataset(page, 'gate'), 'declined:1', 'second answer');
  expect(await overlayCount(page), 1, 'prompt left open');
});

await test('consent tool iframe: keeps required only, confirms, flow moves on', async () => {
  const page = await fixture('#open-frame');
  await page.waitForFunction(() => document.body.dataset.frame, null, { timeout: 5000 }).catch(() => {});
  expect(await dataset(page, 'frame'), 'required-only', 'answer');
  await page.waitForTimeout(300); // the confirm step's purposes arrive as an amendment
  const actions = (await pageActions(fixtureUrl)).filter((a) => a.kind === 'prompt');
  expect(actions.map((a) => [a.decision, a.label, a.trigger, a.gave, a.host]),
    [['required-only', 'We Value Your Privacy', 'Consent tool in an iframe', ['Account Creation'], '127.0.0.1']],
    'recorded on the top page');
  expect(await page.locator('[data-nazar-ui]').count(), 1, 'note shown on the top page');
});

await test('site entry disclaimer: agrees, never follows the Disagree link', async () => {
  const page = await fixture('#open-entry');
  expect(new URL(page.url()).search, '', 'still on the page');
  expect(await dataset(page, 'entry'), 'agreed', 'answer');
  expect(await promptRecords(fixtureUrl), [{
    decision: 'accepted', trigger: 'Law firm disclaimer (agree to enter)', gave: [], refused: [],
  }], 'recorded');
});

await test('disclaimer whose only answer leaves the site is left alone', async () => {
  const page = await fixture('#open-exit-only');
  expect(new URL(page.url()).search, '', 'still on the page');
  expect(await overlayCount(page), 1, 'still open');
});

await test('fixed app shell with many controls is left alone', async () => {
  const page = await fixture('#open-shell');
  expect(await dataset(page, 'shell'), null, 'clicks');
});

await test('popup with a data-entry field is left alone', async () => {
  const page = await fixture('#open-form');
  expect(await dataset(page, 'form'), null, 'clicks');
  expect(await overlayCount(page), 1, 'still open');
});

await test('destructive confirm (Cancel / Delete) is left alone', async () => {
  const page = await fixture('#open-destructive');
  expect(await dataset(page, 'destructive'), null, 'clicks');
});

await test('accept-only cookie bar is never accepted', async () => {
  const page = await fixture('#open-cookie');
  expect(await dataset(page, 'cookie'), null, 'clicks');
});

await test('popup "Handled on this page" matches what happened', async () => {
  const page = await fixture('#open-optional');
  const actions = await pageActions(fixtureUrl);
  expect(actions.map((a) => [a.kind, a.decision, a.label, a.reason, a.trigger, a.refused]),
    [['prompt', 'declined', 'Marketing emails', 'Optional', 'Optional purpose', ['Marketing emails']]], 'page actions');
});

await test('history records every answer and stand-down', async () => {
  const { activity, stats } = await worker.evaluate(() => chrome.storage.local.get(['activity', 'stats']));
  const count = (decision) => activity.filter((a) => a.kind === 'prompt' && a.decision === decision).length;
  // declined: optional, dialog, late, no-click, gate, page-actions.
  // required-only: itemised, frame. accepted: required, service, next-page,
  // entry. left: the gate retry.
  expect([count('declined'), count('required-only'), count('accepted'), count('left')], [6, 2, 4, 1],
    'declined / required-only / accepted / left');
  expect(stats.totalBanners, 12, 'popups handled total');
  const frameEntry = activity.find((a) => a.decision === 'required-only' && a.label === 'We Value Your Privacy');
  expect(frameEntry && frameEntry.gave, ['Account Creation'], 'amendment stored in history');
});

console.log('\nPrivacy policy checklist');

await test('found and missing DPDP basics, from the policy the page links', async () => {
  const page = await newPage();
  await page.goto(fixtureUrl.replace('prompts.html', 'policy-site.html'));
  const popup = await openPopupFor(page);
  await popup.waitForFunction(() => document.querySelectorAll('.notice-item').length > 0, null, { timeout: 10000 });
  expect(await popup.textContent('#noticeTally'), '4 of 6', 'tally');
  expect(await popup.textContent('#noticeSource'), 'AI not available', 'read by');
  const missing = await popup.$$eval('.notice-item.missing', (rows) => rows.map((r) => r.textContent.slice(1)));
  expect(missing, ['Says how to complain to the Data Protection Board', 'Names a grievance or privacy officer with an email'], 'missing');
  const quote = await popup.getAttribute('.notice-item.found >> nth=2', 'title');
  if (!/withdraw your consent/.test(quote)) throw new Error(`found row carries no quote: ${quote}`);
});

// Turns the AI on for the tests that need it; everything else runs with it
// off, so no test reaches a model.
const setAi = (enabled) => worker.evaluate(async (on) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, aiEnabled: on } });
}, enabled);

await test('AI reads the policy: its answer wins, and an unproven tick falls back to text match', async () => {
  aiBackend.requests.length = 0;
  aiBackend.reply = {
    v: 1, isPolicy: true, truncated: false, source: 'ai', cached: false,
    items: [
      { key: 'data', found: true, quote: 'we collect your name, email address, mobile number and delivery address.', note: 'Name, email, phone, address' },
      { key: 'purposes', found: true, quote: 'We use your personal data to deliver your order', note: 'Orders, updates, returns' },
      // The text match finds "withdraw your consent"; the AI, reading for
      // meaning, says no, and the AI wins.
      { key: 'withdraw', found: false, quote: '', note: 'Withdrawing closes the account' },
      // Found, but the server could not find the quote in the policy: the
      // text match answers this one instead.
      { key: 'rights', found: true, quote: '', note: 'Access, correct, erase' },
      { key: 'board', found: false, quote: '', note: 'No mention of the Board' },
      { key: 'contact', found: false, quote: '', note: 'Only a support email' },
    ],
  };
  await setAi(true);
  try {
    const page = await newPage();
    await page.goto(fixtureUrl.replace('127.0.0.1', 'ai.test').replace('prompts.html', 'policy-site.html'));
    const popup = await openPopupFor(page);
    await popup.waitForFunction(() => document.querySelectorAll('.notice-item').length > 0, null, { timeout: 10000 });
    expect(await popup.textContent('#noticeSource'), 'AI', 'read by');
    expect(await popup.textContent('#noticeTally'), '3 of 6', 'tally');
    const rows = await popup.$$eval('.notice-item', (items) => items.map((li) => [li.classList.contains('found'), li.title]));
    expect(rows.map(([found]) => found), [true, true, false, true, false, false], 'ticks');
    if (!rows[2][1].includes('Withdrawing closes the account')) throw new Error(`no AI note on hover: ${rows[2][1]}`);
    if (!/right to access, correct and erase/.test(rows[3][1])) throw new Error(`rights row is not the text match: ${rows[3][1]}`);
    const [request] = aiBackend.requests.filter((r) => r.type === 'notice');
    expect([request.origin, request.policyUrl.endsWith('/policy.html')], [`http://ai.test:${server.address().port}`, true], 'request');
    if (!request.policyText.includes('withdraw your consent')) throw new Error('the policy text was not sent');
  } finally {
    await setAi(false);
    aiBackend.reply = null;
  }
});

await test('AI unavailable: the text match answers, and says so', async () => {
  aiBackend.requests.length = 0;
  aiBackend.reply = null; // the backend answers 500
  await setAi(true);
  try {
    const page = await newPage();
    await page.goto(fixtureUrl.replace('127.0.0.1', 'down.test').replace('prompts.html', 'policy-site.html'));
    const popup = await openPopupFor(page);
    await popup.waitForFunction(() => document.querySelectorAll('.notice-item').length > 0, null, { timeout: 15000 });
    expect(aiBackend.requests.some((r) => r.type === 'notice'), true, 'AI was asked');
    expect(await popup.textContent('#noticeSource'), 'AI not available', 'read by');
    expect(await popup.textContent('#noticeTally'), '4 of 6', 'tally');
  } finally {
    await setAi(false);
  }
});

await test('a page with no privacy policy link says so', async () => {
  // Another host: the checklist is cached per site, and the policy test
  // above already cached one for 127.0.0.1.
  const page = await newPage();
  await page.goto(fixtureUrl.replace('127.0.0.1', 'consent.test'));
  const popup = await openPopupFor(page);
  await popup.waitForFunction(() => !/Checking/.test(document.getElementById('noticeStatus').textContent), null, { timeout: 10000 });
  expect(await popup.textContent('#noticeStatus'), 'No privacy policy link on this page.', 'status');
});

await test('a privacy link that lands on a help page is not shown as a bad policy', async () => {
  const page = await newPage();
  await page.goto(fixtureUrl.replace('127.0.0.1', 'shop.test').replace('prompts.html', 'wrong-link-site.html'));
  const popup = await openPopupFor(page);
  await popup.waitForFunction(() => !/Checking/.test(document.getElementById('noticeStatus').textContent), null, { timeout: 10000 });
  expect(await popup.$$eval('.notice-item', (rows) => rows.length), 0, 'checklist rows');
  expect(await popup.textContent('#noticeTally'), '', 'tally');
  if (!/Could not read a privacy policy/.test(await popup.textContent('#noticeStatus'))) throw new Error('status does not say so');
});

console.log('\nReport this site');

await test('sends the host, the problem, the note and what Nazar did, nothing more', async () => {
  // consent.test maps to the fixture server: a real host name, as the
  // server's schema requires.
  const page = await newPage();
  await page.goto(fixtureUrl.replace('127.0.0.1', 'consent.test'));
  await page.click('#open-optional');
  await page.waitForTimeout(SETTLE_MS);
  const popup = await openPopupFor(page);
  await popup.click('#reportOpen');
  await popup.check('input[value="wrong-answer"]');
  await popup.fill('#reportNote', 'I wanted the marketing emails');
  receivedReports.length = 0;
  await popup.click('#reportSend');
  await popup.waitForFunction(() => !document.getElementById('reportResult').hidden, null, { timeout: 10000 });
  expect(await popup.textContent('#reportResult'), 'Thanks, report sent. We look at every reported site.', 'popup says');
  expect(receivedReports.length, 1, 'reports received');
  const [report] = receivedReports;
  expect(Object.keys(report).sort(), ['actions', 'extensionVersion', 'host', 'note', 'problem'], 'fields');
  expect([report.host, report.problem, report.note], ['consent.test', 'wrong-answer', 'I wanted the marketing emails'], 'report');
  expect(report.actions.map((a) => [a.kind, a.decision, a.label]), [['prompt', 'declined', 'Marketing emails']], 'actions');
  if (JSON.stringify(report).includes('prompts.html')) throw new Error('the page address was sent');
});

if (args.has('--shots')) {
  const out = path.join(here, 'out');
  await mkdir(out, { recursive: true });
  const page = await fixture('#open-optional');
  await page.click('#open-required');
  await page.waitForTimeout(SETTLE_MS);
  const tab = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0], fixtureUrl);
  const popup = await context.newPage();
  // Point the popup at the fixture tab instead of itself.
  await popup.addInitScript((t) => { chrome.tabs.query = async () => [t]; }, tab);
  await popup.setViewportSize({ width: 344, height: 760 });
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(1500);
  await popup.screenshot({ path: path.join(out, 'popup.png'), fullPage: true });
  const shop = await newPage();
  await shop.goto(fixtureUrl.replace('prompts.html', 'policy-site.html'));
  const shopPopup = await openPopupFor(shop, { height: 900 });
  await shopPopup.waitForTimeout(1500);
  await shopPopup.click('#reportOpen');
  await shopPopup.screenshot({ path: path.join(out, 'popup-checklist-report.png'), fullPage: true });
  const history = await context.newPage();
  await history.goto(`chrome-extension://${extensionId}/popup/history.html`);
  await history.screenshot({ path: path.join(out, 'history.png'), fullPage: true });
  console.log(`\n  screenshots in ${out}`);
}

if (args.has('--live')) {
  console.log('\nConsent prompts, theprivacylabs.com/book-demo');
  const page = await context.newPage();

  await test('cookie banner is rejected on load', async () => {
    await page.goto('https://theprivacylabs.com/book-demo', { waitUntil: 'networkidle' });
    await page.waitForTimeout(SETTLE_MS);
    const cookie = (await pageActions(page.url())).filter((a) => a.kind === 'cookie').map((a) => a.decision);
    expect(cookie, ['declined'], 'cookie banner');
  });

  await test('purpose prompt on submit is accepted and the booking goes ahead', async () => {
    // Stop the flow at the network: the grant and the booking reach no
    // server, but the page still behaves as if they had been sent.
    let consentGranted = false;
    let bookingSent = false;
    await page.route('**/api/public/consent/purpose-grant', (route) => {
      consentGranted = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    });
    await page.route('**/api/public/book-demo', (route) => {
      bookingSent = true;
      route.abort();
    });

    await page.fill('#name', 'Nazar Test');
    await page.fill('#company', 'Privacy Labs QA');
    await page.fill('#email', 'nazar-test@theprivacylabs.com');
    await page.fill('#website', 'theprivacylabs.com');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);

    expect(await page.locator('#dpdp-purpose-overlay').count(), 0, 'prompt gone');
    expect(await promptActions(page.url()), [['accepted', 'You asked for this']], 'what Nazar did');
    expect([consentGranted, bookingSent], [true, true], 'consent granted, booking sent');
  });

  if (args.has('--shots')) {
    await page.screenshot({ path: path.join(here, 'out', 'book-demo.png') });
  }
}

await context.close();
server.close();
await rm(profileDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
