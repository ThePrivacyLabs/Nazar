# 🧿 Nazar — privacy guardian for your browser

![status: beta](https://img.shields.io/badge/status-beta-orange) ![license: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)

> **Beta.** Nazar works and is safe to use, but it's early. Cookie-banner and
> tracker coverage keep improving, expect the occasional missed banner, and
> please [report issues](../../issues) when you find them.

**Nazar** (नज़र, "the gaze"; _buri nazar_ is the evil eye) is an open-source Chrome
extension that wards off tracking. It rejects non-essential cookies before you
even see the banner, blocks known trackers at the network level, sends a
"do-not-sell" signal to every site, and grades each website's privacy policy so
you know who to trust.

Built by [Privacy Labs](https://theprivacylabs.com) to make everyday privacy
easy, with a focus on Indian users and India's DPDP Act.

> **Nazar works fully on its own using local heuristics.** The AI-powered policy
> grading is an optional enhancement that talks to a small backend (see
> [The optional AI backend](#the-optional-ai-backend)). Everything else runs
> entirely in your browser.

---

## What it does

| Feature | How |
|---|---|
| **Auto-rejects cookie banners** | Clicks "reject"/"necessary only" on ~20 known consent platforms (OneTrust, Cookiebot, Didomi, CookieYes, Usercentrics, GoTrust, …), plus a generic detector that works across shadow DOM and opt-out banners (opens preferences, turns every toggle off, saves). |
| **Blocks trackers** | 38 ad-tech / analytics domains (Meta Pixel, Google Ads, Hotjar, Criteo, session recorders, ad exchanges) are blocked at the network layer via `declarativeNetRequest`, before they load. |
| **Sends Global Privacy Control** | Every request carries `Sec-GPC: 1` and every page sees `navigator.globalPrivacyControl = true`. This is a legally recognized "do not sell my data" signal (enforceable under CCPA and several US state laws). |
| **Grades privacy policies** | Finds the site's policy, reads it, and scores it A–F on things that matter: does it sell data, deletion rights, retention periods, DPDP Act compliance, encryption, opt-outs. Offline this uses keyword heuristics; with the optional backend it uses an LLM that reads for meaning. |
| **Detects accept-only banners** | Even when a banner has no reject option (a DPDP red flag), Nazar detects and flags it rather than silently ignoring it. |
| **Shows & clears cookies** | See how many cookies a site stored, and wipe them with one click. |
| **Suggests alternatives** | On ~40 popular services, suggests privacy-friendly and open-source alternatives, flagging Indian-built ones (Ente, Zoho, Chatwoot, …). |

Nazar collects **no telemetry**. Everything about your browsing stays on your
device. See [Privacy](#privacy).

---

## Install (from source)

No build step, no dependencies. It runs as-is.

1. Download or clone this repo.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.
5. The 🧿 icon appears in your toolbar. Visit any site to see it work.

---

## How it works

```
┌─────────────────────────── your browser ───────────────────────────┐
│                                                                     │
│  content/cookie-shield.js   ← runs on every page                    │
│    • finds & rejects cookie banners (CMP rules, generic, shadow DOM)│
│    • detects banners it can't reject                                │
│    • detects trackers and the privacy-policy link                   │
│                                                                     │
│  content/gpc.js             ← sets navigator.globalPrivacyControl   │
│  rules/trackers.json        ← declarativeNetRequest block + GPC hdr │
│                                                                     │
│  background.js (service worker)                                     │
│    • fetches the policy text (in-browser, so it isn't bot-blocked)  │
│    • scores it with local heuristics, OR calls the AI backend       │
│    • caches results locally                                         │
│                                                                     │
│  popup/                     ← the report you see when you click 🧿  │
└─────────────────────────────────────────────────────────────────────┘
                                   │  (optional, only for AI grading)
                                   ▼
                    a small backend you host (see below)
```

The core is three files: [`content/cookie-shield.js`](content/cookie-shield.js)
(banner + tracker + policy detection), [`background.js`](background.js) (scoring,
caching), and [`popup/`](popup/) (the UI). Rules for blocking live in
[`rules/trackers.json`](rules/trackers.json).

---

## The optional AI backend

The extension talks to an HTTP endpoint for LLM-based policy grading and
banner-recipe hints. **This is optional** — without it, Nazar falls back to
local keyword heuristics for everything.

- The endpoint URL is `NAZAR_API` in [`background.js`](background.js). Point it
  at your own backend, or set `settings.apiUrl` in extension storage for local
  testing.
- The extension sends only: the site's **domain**, the **policy text** (fetched
  by your own browser), and, for banner help, the **visible text and CSS
  selectors** of buttons. It never sends page content or anything personal.
- The API key lives **only** on the backend, never in the extension.

A reference backend (Next.js + Anthropic + MongoDB cache) is not included in this
repo. The request/response contract is documented in
[CONTRIBUTING.md](CONTRIBUTING.md) so you can self-host one.

---

## Privacy

**Nazar analyzes _websites_, never _you_.** There is no user-level tracking of
any kind: no analytics, no accounts, no device or user ID, no browsing-history
collection, no cross-site profile, nothing that identifies who you are.

- **Cookie rejection, tracker blocking, GPC, and cookie clearing are 100% local**
  to your browser. Nothing about them ever leaves your device.
- **Policy grading** (only if you enable the optional AI backend) sends just two
  things: the **public domain** of the site being graded (e.g. `example.com`)
  and the **public text of that site's privacy policy** — both are public
  information about the _website_. It never sends your identity, your history,
  the pages you view, form data, or anything personal.
- The backend attaches **no user identifier** to requests, does **not** log IP
  addresses (beyond a transient in-memory counter for abuse rate-limiting that
  is never stored), and builds **no profile**. It caches results keyed only by
  the website's domain, so the same site graded once is reused for everyone.
- All results are cached in **your browser's own local storage**.

In short: the only data captured is about the websites you visit, so we can tell
you whether _they_ respect your privacy — and even that is minimized, anonymous,
and never tied back to you.

---

## Contributing

The two things that most need community help are **cookie-banner rules** (new
consent platforms appear constantly) and the **alternatives list**. Both are
one-line changes anyone can make. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[GNU General Public License v3.0](LICENSE). You're free to use, study, modify,
and share Nazar; derivative works must stay open source under the same license.

The Privacy Labs name and logo are trademarks of Privacy Labs; if you fork
Nazar, please replace the branding in [`assets/brand/`](assets/brand/) and the
popup with your own.
