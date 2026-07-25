// Global Privacy Control, JS half. The Sec-GPC request header is set by a
// declarativeNetRequest rule; this exposes the matching navigator signal
// that sites check client-side. Runs in the page's MAIN world.
try {
  Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
    get: () => true,
    configurable: true,
  });
} catch (e) {
  // Some pages lock Navigator; the header signal still applies
}
