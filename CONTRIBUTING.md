# Contributing to Nazar

Thanks for helping make everyday privacy easier. Nazar has **no build step and
no dependencies** — you edit a file, reload the extension, and see the change.

## Getting set up

1. Clone the repo.
2. `chrome://extensions` → **Developer mode** on → **Load unpacked** → select the
   folder.
3. Edit any file, then click the **reload** icon on the Nazar card to apply
   changes. Reload the web page too (content scripts re-inject on page load).

To debug the background service worker, click **"service worker"** on the Nazar
card in `chrome://extensions` — it opens a console.

## The two highest-value contributions

### 1. Cookie-banner rules

New consent platforms show up all the time, and each is a small, self-contained
change in [`content/cookie-shield.js`](content/cookie-shield.js):

- **Known platform with a reject button:** add its reject-button selector to
  `CMP_REJECT_SELECTORS`.
- **Banner hidden by CSS:** add its container selector to
  [`content/cookie-shield.css`](content/cookie-shield.css).
- **Generic patterns:** the `DECLINE` and `CUSTOMIZE` regexes in
  [`content/lib/vocab.js`](content/lib/vocab.js) catch button wording. Both the
  cookie shield and the consent-popup handler read them, so phrasing added
  there works for both.

**How to find the selector:** open the banner, right-click the reject button →
Inspect, and note its `id`/`class`/`data-*` attribute or exact text. If the
banner lives in a shadow DOM (common now), Nazar already traverses open shadow
roots — you usually just need the button text or a stable attribute.

When you open a PR, please say which site you tested on.

### 2. Privacy-friendly alternatives

[`popup/alternatives.js`](popup/alternatives.js) maps a domain to better
options. To add one, add an entry:

```js
'example.com': [
  { name: 'Better Thing', url: 'https://betterthing.org', note: 'open source, no ads' },
  { name: 'Indian Option', url: 'https://…', note: '…', in: true }, // in: true flags Indian-built
],
```

Prefer open-source, end-to-end-encrypted, or India-built options.

### 3. Trackers to block

[`rules/trackers.json`](rules/trackers.json) is generated. To add a tracker
domain, edit the generator block at the top of the script that produced it (see
the comment in the file) or add a rule following the existing shape, then add its
rule-id → company-name mapping in [`popup/tracker-rules.js`](popup/tracker-rules.js).
Do **not** block domains that break sites (e.g. Google Tag Manager is
deliberately left out).

## Testing

[`tests/`](tests/) drives real popups at the unpacked extension in Chromium.
It is not part of the extension: leave `tests/` out of the store zip.

```
cd tests
npm install
npm test                  # local fixtures, one per popup type
npm run test:unit         # the privacy policy checklist
npm test -- --live        # also theprivacylabs.com/book-demo
npm test -- --headed      # watch it run
npm test -- --shots       # popup + history screenshots in tests/out
```

When a real site misbehaves, walk it with Nazar loaded and see what Nazar
did at each step, what is on screen, and what sits in iframes:

```
node probe.mjs https://site.example "Sign up" "fill:#email=a@b.co" "Continue" "frame:Accept selected"
```

Steps are button text to click, `fill:<selector>=<value>`, `type:<selector>=<keys>`
(for split OTP boxes), or `frame:<button text>` to click inside the first
iframe by hand. Screenshots of each step land in `tests/out`.

A new popup type, or a site Nazar gets wrong, starts as a case in
[`tests/fixtures/prompts.html`](tests/fixtures/prompts.html): the right answer
first, then the fix. Cases where Nazar must do nothing (a form, a destructive
confirm) matter as much as the ones where it acts.

## Code style

- Plain modern JavaScript, no framework, no transpiler. Match the surrounding
  style.
- Anything more than one content script needs goes in `content/lib/`, on the
  `globalThis.Nazar` namespace, and is listed before its users in
  `manifest.json`.
- Comments explain **why**, not what. The existing files are heavily commented —
  follow that density.
- Keep the extension usable with **zero permissions beyond what's declared**. New
  permissions are a hard sell for a privacy tool; justify them in the PR.

## The AI backend contract

If you're self-hosting the optional AI backend, the extension calls it as:

**`POST` (JSON) → your endpoint** (`NAZAR_API` in `background.js`)

Privacy policy check:
```json
{ "type": "notice", "origin": "https://site.com",
  "policyUrl": "https://site.com/privacy", "policyText": "…", "forceRefresh": false }
```
Response, one item per check in `shared/notice-checks.js`, each found item
quoting the policy word for word (the server drops any quote not in the text):
```json
{ "v": 1, "isPolicy": true, "truncated": false, "source": "ai", "cached": false,
  "items": [ { "key": "withdraw", "found": true, "quote": "…", "note": "…" }, … ] }
```
`{ "insufficient": true }` means the text was not a privacy policy.

Banner recipe (when heuristics fail):
```json
{ "type": "banner", "origin": "https://site.com",
  "candidates": [ { "selector": "#btn", "text": "Reject All" }, … ] }
```
Response:
```json
{ "found": true, "steps": [ { "selector": "#btn", "expectText": "Reject All" } ], "source": "ai" }
```

The backend must: keep the LLM API key server-side, validate that banner steps
never target accept-style buttons, and cap spend (per-day and per-IP). The
extension treats any error, timeout, or cap as "fall back to local heuristics."

"Report this site" posts to `/api/nazar/report` on the same server:
```json
{ "host": "site.com", "problem": "not-handled | wrong-answer | site-broke",
  "note": "…", "extensionVersion": "0.4.0",
  "actions": [ { "kind": "prompt", "decision": "declined", "label": "…", "reason": "…",
                 "trigger": "…", "gave": [], "refused": ["…"] } ] }
```
The host is a bare host name, never a URL. Answer `201` when stored.

The text-match fallback for the privacy policy check needs no backend: it is
[`shared/notice-checks.js`](shared/notice-checks.js), one pattern list per
check. A policy wording a check misses is a pattern to add there, with a case
in [`tests/unit/notice-checks.test.mjs`](tests/unit/notice-checks.test.mjs).

## Reporting bugs

Use **Report this site** in the popup, or open an issue with the **site URL**
and what went wrong (banner not detected, policy check wrong, page broke, etc.). A screenshot of the banner's HTML (right-click →
Inspect → Copy outerHTML) makes banner bugs fixable in minutes.

## License

By contributing, you agree your contributions are licensed under the project's
[GPL-3.0](LICENSE).
