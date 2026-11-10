# 🧿 Nazar - privacy guardian for your browser

![status: beta](https://img.shields.io/badge/status-beta-orange) ![license: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)

> **Beta.** Nazar works and is safe to use, but it's early. Cookie-banner and
> tracker coverage keep improving, expect the occasional missed banner, and
> please [report issues](../../issues) when you find them.

**Nazar** (नज़र, "the gaze"; _buri nazar_ is the evil eye) is an open-source Chrome
extension that wards off tracking. It rejects non-essential cookies before you
even see the banner, blocks known trackers at the network level, sends a
"do-not-sell" signal to every site, and checks each website's privacy policy for
the basics India's DPDP Rules require, so you know who to trust.

Built by [Privacy Labs](https://theprivacylabs.com) to make everyday privacy
easy, with a focus on Indian users and India's DPDP Act.

> **Nazar works fully on its own, in your browser.** AI, which reads privacy
> policies and unusual cookie banners, is an optional extra that talks to a small
> backend (see [The optional AI backend](#the-optional-ai-backend)). Without it,
> Nazar checks policies by matching their wording.

---

## What it does

| Feature | How |
|---|---|
| **Answers consent popups for you** | India's DPDP Act asks for consent one purpose at a time, at the moment data is collected, so one signup can raise several popups. Nazar answers each one as it appears, before it paints. If the popup comes up right after you click something and asks for exactly that (say, using your details to book the demo you just requested), it accepts, because your click already said yes. If it asks for anything extra (marketing, offers, personalisation, sharing with partners, analytics), or turns up on its own, it declines. If acknowledging is the only way forward, it accepts. When a notice lists purposes to pick from, it keeps only the required ones and saves, rather than "Reject all", which on some consent tools also refuses what the service needs and stalls the flow. It works inside consent tools' own iframes, and finishes their "Confirm your choice" step. Anything else (a form, a "Delete account?" confirm) it leaves alone, and if you ask for something again after Nazar declined it, that one is yours. All of this is local rules, no AI. |
| **Shows what it did** | A short in-page note each time it answers a popup. In the popup and on the history page, each answer says what you gave and what was refused ("Gave: Know Your Customer"), after which of your clicks ("after you clicked Grant Consent"), grouped by site. It is your own copy of what you agreed to, and it stays on your device. |
| **Auto-rejects cookie banners** | Clicks "reject"/"necessary only" on ~20 known consent platforms (OneTrust, Cookiebot, Didomi, CookieYes, Usercentrics, GoTrust, …), plus a generic detector that works across shadow DOM and opt-out banners (opens preferences, turns every toggle off, saves). |
| **Blocks trackers** | 38 ad-tech / analytics domains (Meta Pixel, Google Ads, Hotjar, Criteo, session recorders, ad exchanges) are blocked at the network layer via `declarativeNetRequest`, before they load. |
| **Sends Global Privacy Control** | Every request carries `Sec-GPC: 1` and every page sees `navigator.globalPrivacyControl = true`. This is a legally recognized "do not sell my data" signal (enforceable under CCPA and several US state laws). |
| **Checks privacy policies** | Finds the site's policy and looks for the six things India's DPDP Rules say a notice must tell you: what data is collected, what it is used for, how to withdraw consent, how to use your rights, how to complain to the Data Protection Board, and who to contact (Rule 3 and Rule 9). The badge shows how many it found, like 4/6, and each found item carries the policy's own words. AI reads the policy, and each site's answer is cached and shared, so a site is read once for everyone; when AI is off or unavailable, Nazar matches the policy's wording instead, and the popup says which one answered. |
| **Report a site** | When a popup is handled wrong, "Report this site" in the popup sends the site's name, what Nazar did there and an optional note, so it can be fixed. Only when you press Send. |
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
│  content/lib/*.js           ← shared helpers, loaded first          │
│  content/cookie-shield.js   ← runs on every page                    │
│    • finds & rejects cookie banners (CMP rules, generic, shadow DOM)│
│    • detects banners it can't reject                                │
│    • detects trackers and the privacy-policy link                   │
│  content/consent-prompts.js ← watches for consent popups all along  │
│    • declines optional, accepts required, leaves the rest           │
│                                                                     │
│  content/gpc.js             ← sets navigator.globalPrivacyControl   │
│  rules/trackers.json        ← declarativeNetRequest block + GPC hdr │
│                                                                     │
│  background.js (service worker)                                     │
│    • checks the policy: AI first, text match (shared/) as backup    │
│    • caches results locally                                         │
│    • keeps the activity history (the only writer of it)             │
│                                                                     │
│  popup/                     ← the report you see when you click 🧿  │
└─────────────────────────────────────────────────────────────────────┘
                                   │  (optional, only for AI grading)
                                   ▼
                    a small backend you host (see below)
```

The core is [`content/cookie-shield.js`](content/cookie-shield.js) (banner +
tracker + policy detection), [`content/consent-prompts.js`](content/consent-prompts.js)
(consent popups), [`background.js`](background.js) (scoring, caching, history),
and [`popup/`](popup/) (the UI). The helpers both content scripts share (DOM
reading, the words consent UIs use, the activity record, the toast) live in
[`content/lib/`](content/lib/). Rules for blocking live in
[`rules/trackers.json`](rules/trackers.json).

---

## The optional AI backend

The extension talks to an HTTP endpoint for three things: an AI read of each
site's privacy policy, AI hints for cookie banners its local rules cannot read,
and "Report this site". **The AI part is optional**: without it, Nazar matches
policy wording and uses its local rules for every banner.

- The endpoint URL is `NAZAR_API` in [`background.js`](background.js). Point it
  at your own backend, or set `settings.apiUrl` in extension storage for local
  testing.
- For the policy check the extension sends the site's **domain** and the
  **public text of its privacy policy** (fetched by your own browser); for
  banner help, the **visible text and CSS selectors** of buttons. It never sends
  other page content or anything personal.
- A report sends the site's **host name** (never the page address), **what
  Nazar did on the page**, and **your note**, and only when you press Send.
- The API key lives **only** on the backend, never in the extension.

A reference backend (Next.js + Anthropic + MongoDB cache) is not included in this
repo. The request/response contract is documented in
[CONTRIBUTING.md](CONTRIBUTING.md) so you can self-host one.

---

## Privacy

Full policy: [theprivacylabs.com/legal/nazar-privacy](https://theprivacylabs.com/legal/nazar-privacy)

**Nazar analyzes _websites_, never _you_.** There is no user-level tracking of
any kind: no analytics, no accounts, no device or user ID, no browsing-history
collection, no cross-site profile, nothing that identifies who you are.

- **Cookie rejection, consent-popup answering, tracker blocking, GPC, and
  cookie clearing are 100% local** to your browser. Nothing about them ever
  leaves your device.
- **The activity history** (which popups Nazar answered, on which site, and
  how) is kept in your browser's local storage, capped at the latest 300
  entries, and you can clear it from the history page. It is never sent
  anywhere.
- **AI** (only if you leave it on) sends the **public domain** of the site, the
  **public text of its privacy policy**, and for unusual cookie banners the
  **visible text of their buttons**: public information about the _website_. It
  never sends your identity, your history, the pages you view, form data, or
  anything personal. Answers are cached per site and shared, so a site read for
  one person is not sent again for the next. With AI off, the policy check runs
  on your device and nothing is sent.
- **"Report this site"** sends, only when you press Send, the site's **host
  name** (never the page address), **what Nazar did on that page**, and **your
  note**. Reports are kept for 180 days, then deleted.
- The backend attaches **no user identifier** to requests, does **not** store IP
  addresses (beyond a short-lived rate-limit counter), and builds **no
  profile**. It caches answers keyed only by the website's domain.
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
