# Publishing Nazar to the stores

Current as of 2026. Fees and flows do change — verify on each store's dashboard.

## Before you submit (needed by every store)

- **A privacy policy URL.** All stores now require one. Nazar's privacy stance
  (see the README) is your content: "analyzes websites, not users; no user-level
  tracking." Host a page at e.g. `theprivacylabs.com/nazar/privacy`.
- **A single-purpose statement.** One sentence: _"Nazar rejects non-essential
  cookies, blocks trackers, and grades website privacy policies."_
- **Permission justifications** (they ask per permission):
  - `storage` — cache grades and settings locally.
  - `activeTab` / `<all_urls>` — read cookie banners and policy links on the
    sites you visit, to reject and grade them.
  - `cookies` — show and clear cookies a site stored.
  - `declarativeNetRequest` — block known tracker domains.
- **Remote-code disclosure:** declare that the extension bundles no remote code
  (it doesn't — it only calls your JSON API). This is required and Nazar passes.
- **Assets:** 128×128 icon (have it), at least one screenshot (1280×800 or
  640×400), and a short + long description.
- **Zip the extension folder** (the folder containing `manifest.json`), excluding
  `node_modules`, `.git`, and docs. That zip is what you upload.

## Chrome Web Store  → also covers Brave

- **Fee:** $5 USD, one-time, covers up to 20 extensions on the account.
- **Where:** https://chrome.google.com/webstore/devconsole → register → "New item"
  → upload zip → fill the listing + privacy fields → submit.
- **Review:** usually a few days. Broad host permissions (`<all_urls>`) can add
  scrutiny; the justification above is what they want.
- **Brave:** Brave has **no separate store** — it installs from the Chrome Web
  Store directly. Publishing to Chrome automatically makes Nazar installable in
  Brave. Nothing extra to do.

## Microsoft Edge Add-ons

- **Fee:** free.
- **Where:** register a Microsoft Partner Center account →
  https://partner.microsoft.com/dashboard/microsoftedge → "New extension" →
  upload the **same zip** (Edge is Chromium, the MV3 extension works unchanged).
- **Note:** Edge's 2026 flow has a dedicated privacy/compliance step (single-
  purpose statement, permission justifications, data-use certification, privacy
  policy) — the same material you prepared above.

## Safari (macOS + iOS)  — most work, real caveats

Safari doesn't take a raw extension folder; it must be wrapped in an app.

- **Fee:** Apple Developer Program, $99 USD/year.
- **Convert:** on a Mac with Xcode, run
  `xcrun safari-web-extension-converter /path/to/Chrome-extension` — it produces
  an Xcode project wrapping the extension. (Apple also now lets you upload a zip
  to App Store Connect for conversion without a Mac.)
- **Submit** the resulting app through App Store Connect like any iOS/macOS app.

**Caveats to test before committing to Safari:**
- Content-script features (cookie rejection, banner detection, policy grading,
  GPC's JS half) port cleanly — they're standard WebExtension APIs.
- **Tracker blocking via `declarativeNetRequest` is the risk.** Safari's support
  for network blocking is limited on macOS and weakest on iOS. Verify the
  `rules/trackers.json` blocking actually fires on Safari; on iOS you may need to
  reimplement blocking via Safari's native Content Blocker mechanism, or ship
  Safari without tracker blocking and keep the rest.
- The `Sec-GPC` request header (set via a DNR `modifyHeaders` rule) has the same
  Safari limitation; the `navigator.globalPrivacyControl` JS signal still works.

## Recommended order

1. **Chrome** first (cheapest, biggest reach, and unlocks Brave for free).
2. **Edge** next (free, same zip, minutes of work).
3. **Safari** only when you have a Mac and time to handle the blocking caveats —
   it's the highest-effort, lowest-overlap target.
