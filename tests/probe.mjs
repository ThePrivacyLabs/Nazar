// Scratch probe: walk a page with Nazar loaded, one click per step,
// and report what Nazar did and what is on screen. Not a test.
//   node probe.mjs <url> "<button text>" "<button text>" ...
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [url, ...steps] = process.argv.slice(2);
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'nazar-probe-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${path.resolve(here, '..')}`,
    `--load-extension=${path.resolve(here, '..')}`,
    '--host-resolver-rules=MAP consent.test 127.0.0.1', // for the local fixtures
  ],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
await worker.evaluate(() => chrome.storage.local.set({ settings: { aiEnabled: false } }));

const page = await context.newPage();
page.on('console', (m) => { if (/nazar|error/i.test(m.text()) || m.type() === 'error') console.log('  [console]', m.type(), m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

async function report(tag) {
  await page.screenshot({ path: path.join(out, `probe-${tag}.png`) });
  const actions = await worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u + '*' });
    try { return (await chrome.tabs.sendMessage(tab.id, { action: 'getPageReport' })).actions; } catch (e) { return String(e); }
  }, new URL(url).origin + '/');
  const buttons = await page.evaluate(() => [...document.querySelectorAll('button, a, [role="button"]')]
    .filter((b) => b.getClientRects().length > 0).map((b) => (b.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 40));
  console.log(`\n== ${tag}: ${page.url()}`);
  console.log('  nazar did:', JSON.stringify(actions));
  console.log('  buttons  :', JSON.stringify(buttons));
  console.log('  frames   :', JSON.stringify(page.frames().map((f) => f.url())));
  console.log('  dataset  :', JSON.stringify(await page.evaluate(() => ({ ...document.body.dataset }))));
  const hosts = await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => el.shadowRoot)
    .map((el) => {
      const cs = getComputedStyle(el);
      return { tag: el.tagName, id: el.id, mode: el.shadowRoot.mode, pos: cs.position,
        textLen: el.shadowRoot.textContent.length,
        controls: [...el.shadowRoot.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean).slice(-8) };
    }));
  console.log('  shadow   :', JSON.stringify(hosts));
  for (const frame of page.frames().slice(1)) {
    const chain = await frame.evaluate(() => {
      const btn = [...document.querySelectorAll('button, [role="button"]')].find((b) => /reject all/i.test(b.innerText || ''));
      const rows = [];
      for (let el = btn; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        rows.push(`${el.tagName} role=${el.getAttribute('role')} modal=${el.getAttribute('aria-modal')} pos=${cs.position} text=${(el.textContent || '').length}`);
      }
      const inputs = [...document.querySelectorAll('input, textarea, select, [role="switch"], [role="checkbox"]')]
        .map((i) => `${i.tagName}:${i.type || i.getAttribute('role')}:${i.checked ?? i.getAttribute('aria-checked')}:${i.disabled ?? i.getAttribute('aria-disabled')}`);
      const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((b) => b.getClientRects().length).map((b) => b.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean);
      return { chain: rows, inputs, buttons, bodyText: document.body.innerText.length };
    }).catch((e) => String(e));
    console.log('  frame    :', frame.url(), JSON.stringify(chain, null, 1));
  }
}

await report('0-load');
let i = 1;
for (const step of steps) {
  const fill = step.match(/^fill:(.+)=(.*)$/); // fill:<selector>=<value>, split on the last =
  if (fill) {
    await page.fill(fill[1], fill[2]);
    continue;
  }
  const typed = step.match(/^type:(.+)=(.*)$/); // type:<selector>=<keys>, for split OTP boxes
  if (typed) {
    await page.click(typed[1]);
    await page.keyboard.type(typed[2], { delay: 50 });
    continue;
  }
  const inFrame = step.match(/^frame:(.+)$/); // frame:<button text>, clicked in the first iframe
  if (inFrame) {
    await page.frames()[1].getByText(inFrame[1], { exact: true }).first().click();
    await page.waitForTimeout(2500);
    await report(`${i++}-frame-${inFrame[1].replace(/\W+/g, '_')}`);
    continue;
  }
  await page.getByText(step, { exact: true }).first().click();
  await page.waitForTimeout(2500);
  await report(`${i++}-${step.replace(/\W+/g, '_')}`);
}

// The popup as the person would see it on this tab.
const tab = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0], new URL(url).origin + '/');
const popup = await context.newPage();
await popup.addInitScript((t) => { chrome.tabs.query = async () => [t]; }, tab);
await popup.setViewportSize({ width: 344, height: 900 });
await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
await popup.waitForTimeout(1500);
await popup.screenshot({ path: path.join(out, 'probe-popup.png'), fullPage: true });
await context.close();
