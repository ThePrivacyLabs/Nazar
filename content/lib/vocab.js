// Nazar, the words consent UIs use. Kept in one place so the cookie shield
// and the consent-prompt handler can never disagree about what "decline"
// means.
(() => {
  const N = (globalThis.Nazar = globalThis.Nazar || {});

  // The whole control label must match, so "Reject" matches and
  // "Reject this order" does not.
  const whole = (alternatives) => new RegExp('^(' + alternatives.join('|') + ')$', 'i');

  N.vocab = Object.freeze({
    // Refuses consent.
    DECLINE: whole([
      'reject( all| non.essential| unnecessary| optional)?( cookies)?',
      'decline( all| non.essential| unnecessary| optional)?( cookies)?',
      'refuse( all| non.essential| unnecessary| optional)?( cookies)?',
      'deny( all)?',
      'disagree',
      'i (do not|don.t) (accept|agree|consent)',
      'do not allow',
      'don.t allow',
      'only (strictly )?(necessary|essential)( cookies)?',
      '(strictly )?(necessary|essential)( cookies)? only',
      'use necessary cookies only',
      'continue without (agreeing|accepting)',
      'no,? thanks?',
      'not now',
      'maybe later',
      'अस्वीकार करें', // Hindi: decline
    ]),

    // Acknowledges a notice. Never a bulk grant: "Accept all" and
    // "Allow all" deliberately do not match.
    ACKNOWLEDGE: whole([
      'i agree',
      'agree',
      'i understand',
      'understood',
      'i acknowledge',
      'acknowledge',
      'ok',
      'okay',
      'got it',
      'accept',
      'मैं सहमत हूँ', // Hindi: I agree
    ]),

    // Grants consent. Checked only when the person's own click asked for
    // what the prompt is about; "Allow all" deliberately does not match.
    GRANT: whole([
      'allow',
      'accept',
      'agree',
      'i agree',
      'i consent',
      'give consent',
      'yes',
      'yes,? (i agree|continue|please)',
      'continue',
      'ok',
      'okay',
      'अनुमति दें', // Hindi: allow
      'मैं सहमत हूँ', // Hindi: I agree
    ]),

    // A purpose beyond the thing the person is doing: selling to them,
    // profiling them, or passing their data on. Read against the prompt's
    // question (its heading), not its fine print, where "we never share
    // with third parties" would read as sharing.
    EXTRA_PURPOSE: /market|promot|offers?\b|deals?\b|discount|newsletter|advertis|\bads?\b|personali[sz]|recommend|profil|third.part|partners?\b|affiliate|\bshar(e|ing)\b|\bsell|\bsale\b|analytic|research|survey/i,

    // Confirms a choice already made ("Are you sure?", "Confirm your
    // choice"). Pressed only when it appears right after Nazar's own click,
    // inside the prompt Nazar just answered.
    CONFIRM: whole([
      'confirm',
      'confirm (&|and) (submit|save|continue)',
      'confirm (my )?(choice|choices|selection|preferences)',
      'submit',
      'yes',
      'yes,? (confirm|submit|proceed|continue|i.m sure)',
      'proceed',
      'continue',
      'ok',
      'okay',
      'done',
    ]),

    // Where a consent tool's confirm step names the purposes a choice gives
    // or refuses ("Granting: Know Your Customer"), on its own line or
    // mid-sentence. Read from innerText; the purposes are group 2, up to
    // the end of the line or sentence.
    GIVING_LINE: /\b(granting|giving|allowing|accepting|consenting to)\s*:\s*([^\n.]+)/i,
    REFUSING_LINE: /\b(refusing|denying|declining|rejecting|withdrawing)\s*:\s*([^\n.]+)/i,

    // Deliberately not bare "settings" / "preferences" / "manage": those
    // appear all over normal app UIs and caused false clicks. Only
    // cookie/consent-qualified phrases count.
    CUSTOMIZE: /^(customi[sz]e( cookies?( settings| preferences| choices)?| choices| settings| preferences)?|manage cookies|manage (cookie )?(preferences|options|choices)|cookie (preferences|settings|choices)|allow selection)$/i,

    // Saves the current selection. On a consent chooser this is the way to
    // keep what is required and nothing else.
    SAVE: /^((save|confirm)( my)?( choices| preferences| selection| settings)?|save my choices|(accept|allow) (selected|selection|my selection))$/i,

    // Loose, unanchored forms, for vetting an AI-suggested element.
    ACCEPT_LIKE: /accept|agree|allow|enable|got it|ok(ay)?$/i,
    REJECT_LIKE: /reject|decline|refuse|deny|disagree|necessary|essential/i,

    // id/class/aria wording that marks a consent banner container.
    BANNER_HINT: /cookie|consent|gdpr|dpdp|cmp|privacy|banner|notice|policy/i,

    COOKIE: /cookie/i,

    // Visible wording that makes a popup a consent or data notice.
    CONSENT_HINT: /consent|agree|permission|purpose|personal (data|information)|your data|privacy|notice|सहमति/i,

    // The stricter test for a long notice or a whole frame, where "privacy"
    // or "notice" in a footer would prove nothing.
    CONSENT_WORD: /consent|सहमति/i,
  });
})();
