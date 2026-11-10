// Nazar, the DPDP notice checklist: the six things India's DPDP Rules say a
// privacy notice must tell you, looked for in a site's privacy policy.
//
// The AI backend reads policies first (api/nazar/analyze, type "notice", in
// the Privacy Labs repo, src/lib/nazar/notice-ai.ts, which must keep these
// same six keys). This text match is the fallback when AI is off, over
// budget or down, and answers any single item the AI could not back with a
// quote. It runs locally, offline: the background worker loads it with
// importScripts, the popup with a <script> tag for the labels. Each result
// keeps a short quote from the policy, so a "found" can be checked by eye.
//
// A pattern match is evidence, not a legal opinion: a policy can name its
// grievance officer and still be a poor notice. The popup says "found" and
// "not found", never "compliant".
(function (root) {
  // Rule 3 lists what a notice must give; Rule 9 adds the contact.
  const CHECKS = [
    {
      key: 'data',
      label: 'Lists the personal data it collects',
      rule: 'Rule 3(b)(i)',
      patterns: [
        /(personal )?(data|information) (we|that we|which we) (may )?(collect|process|gather|obtain|hold)/i,
        /(categories|types|kinds) of (personal )?(data|information)/i,
        /we (may )?collect (the following|your (name|e-?mail|phone|mobile|address|contact))/i,
        /(information|data) (we collect|collected)( from you)?\s*:/i,
      ],
    },
    {
      key: 'purposes',
      label: 'Says what it uses your data for',
      rule: 'Rule 3(b)(ii)',
      patterns: [
        /purposes? (of|for) (the )?(processing|collection|which we)/i,
        /(how|why) (do )?we use (your )?(personal )?(data|information)/i,
        /we (may )?(use|process) (your |the )?(personal )?(data|information)( we collect)? (to|for)\b/i,
        /use of (your )?(personal )?(data|information)/i,
      ],
    },
    {
      key: 'withdraw',
      label: 'Explains how to withdraw consent',
      rule: 'Rule 3(c)(i)',
      patterns: [
        /withdraw(al of|ing)? (your |the |such )?consent/i,
        /(revoke|revoking|revocation of) (your |the )?(consent|permission)/i,
      ],
    },
    {
      key: 'rights',
      label: 'Explains how to use your rights (access, correct, erase)',
      rule: 'Rule 3(c)(ii)',
      patterns: [
        /right(s)? to (access|obtain|correct|rectif|update|complete|erase|erasure|delet|be forgotten|nominate)/i,
        /(exercise|exercising) (any of )?(your|these|such|the above) rights/i,
        /data principal('s)? rights/i,
      ],
    },
    {
      key: 'board',
      label: 'Says how to complain to the Data Protection Board',
      rule: 'Rule 3(c)(iii)',
      patterns: [
        /data protection board/i,
        /\bdpbi?\b/i,
      ],
    },
    {
      key: 'contact',
      label: 'Names a grievance or privacy officer with an email',
      rule: 'Rule 9',
      patterns: [
        /(grievance officer|data protection officer|privacy officer|\bdpo\b)[\s\S]{0,300}?[\w.+-]+@[\w-]+(\.[\w-]+)+/i,
      ],
    },
  ];

  const QUOTE_CHARS = 160;

  // The sentence-ish stretch around a match, cut at word boundaries.
  function quoteAround(text, index, length) {
    const pad = Math.max(0, Math.floor((QUOTE_CHARS - length) / 2));
    let start = Math.max(0, index - pad);
    let end = Math.min(text.length, index + length + pad);
    if (start > 0) {
      const cut = text.indexOf(' ', start);
      if (cut !== -1 && cut < index) start = cut + 1;
    }
    if (end < text.length) {
      const cut = text.lastIndexOf(' ', end);
      if (cut > index + length) end = cut;
    }
    return (start > 0 ? '… ' : '') + text.slice(start, end).trim() + (end < text.length ? ' …' : '');
  }

  // [{ key, found, quote }] in CHECKS order.
  function checkNotice(policyText) {
    const text = String(policyText || '').replace(/\s+/g, ' ');
    return CHECKS.map((check) => {
      for (const pattern of check.patterns) {
        const match = pattern.exec(text);
        if (match) return { key: check.key, found: true, quote: quoteAround(text, match.index, match[0].length) };
      }
      return { key: check.key, found: false, quote: '' };
    });
  }

  root.NazarNotice = Object.freeze({
    CHECKS: CHECKS.map(({ key, label, rule }) => Object.freeze({ key, label, rule })),
    TOTAL: CHECKS.length,
    checkNotice,
  });
})(typeof self !== 'undefined' ? self : globalThis);
