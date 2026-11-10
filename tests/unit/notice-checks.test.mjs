// The DPDP notice checklist (shared/notice-checks.js), on short policy
// excerpts. Each check must find its obligation in plain wording and must
// not be fooled by the near-misses real policies are full of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../shared/notice-checks.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(source, { self: sandbox });
const { checkNotice, CHECKS, TOTAL } = sandbox.NazarNotice;

const found = (text) => Object.fromEntries(checkNotice(text).map((c) => [c.key, c.found]));

test('six checks, each tied to a rule', () => {
  assert.equal(TOTAL, 6);
  // Array.from builds the array in this realm; arrays from the vm sandbox
  // never deep-equal ones made here.
  assert.deepEqual(Array.from(CHECKS, (c) => c.key), ['data', 'purposes', 'withdraw', 'rights', 'board', 'contact']);
  for (const check of CHECKS) assert.match(check.rule, /^Rule \d/);
});

test('a DPDP-style policy passes every check', () => {
  const policy = `
    Information we collect: your name, email address and mobile number.
    How we use your information: to deliver your order and send OTPs.
    You may withdraw your consent at any time from Settings.
    You have the right to access, correct and erase your personal data.
    If you are not satisfied, you may complain to the Data Protection Board of India.
    Grievance Officer: Asha Rao, grievance@example.in, +91 22 4000 0000.`;
  assert.deepEqual(found(policy), { data: true, purposes: true, withdraw: true, rights: true, board: true, contact: true });
});

test('a GDPR-only policy misses the Board and the Indian contact', () => {
  const policy = `
    Categories of personal data: identifiers and usage data.
    We use your personal data to provide the service.
    You may lodge a complaint with your supervisory authority.
    Contact our privacy team at privacy@example.com.`;
  const result = found(policy);
  assert.equal(result.board, false, 'a supervisory authority is not the Data Protection Board');
  assert.equal(result.contact, false, 'an email with no named officer is not the Rule 9 contact');
  assert.equal(result.withdraw, false);
});

test('an officer named without an email does not count as a contact', () => {
  assert.equal(found('Our Grievance Officer will respond within 30 days.').contact, false);
});

test('an empty or missing text finds nothing', () => {
  assert.deepEqual(Object.values(found('')), Array(6).fill(false));
  assert.deepEqual(Object.values(found(undefined)), Array(6).fill(false));
});

test('each hit carries a short quote containing the match', () => {
  const filler = 'Lorem ipsum dolor sit amet. '.repeat(20);
  const [, , withdraw] = checkNotice(`${filler} You can withdraw your consent by writing to us. ${filler}`);
  assert.equal(withdraw.found, true);
  assert.match(withdraw.quote, /withdraw your consent/);
  assert.ok(withdraw.quote.length <= 200, `quote is ${withdraw.quote.length} chars`);
  assert.ok(withdraw.quote.startsWith('… ') && withdraw.quote.endsWith(' …'));
});
