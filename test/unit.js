'use strict';
//
// Offline unit tests for the parts of the funnel core and the reporting layer
// that can be checked without a browser, a proxy or a network. Run with:
//   npm run test:unit

const assert = require('assert');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  FAIL ' + name + ': ' + error.message);
  }
}

// The core reads --flags from process.argv; give it the values the tests need.
process.argv.push(
  '--dob', '07/09/1982', '--address', '88 Morgan St', '--fname', 'Dana',
  '--lname', 'TestLead', '--email', 'dana.testlead@example.com', '--phone', '5513326220',
);

const core = require('../scripts/lib/funnelCore');
const reporting = require('../scripts/lib/reporting');

console.log('funnelCore');

test('normalizeProxyToken strips separators, as IPRoyal requires', () => {
  assert.strictEqual(core.normalizeProxyToken('Los Angeles'), 'losangeles');
  assert.strictEqual(core.normalizeProxyToken('Jersey City'), 'jerseycity');
  assert.strictEqual(core.normalizeProxyToken('New-Jersey'), 'newjersey');
});

test('getZipTarget resolves 07302 to Jersey City, NJ', () => {
  const t = core.getZipTarget('07302');
  assert.strictEqual(t.zip, '07302');
  assert.strictEqual(t.city, 'Jersey City');
  assert.strictEqual(t.state, 'NJ');
  // zipcodes returns the state name upper-cased; normalizeProxyToken folds it
  // to the "newjersey" token IPRoyal expects, so the case never reaches IPRoyal.
  assert.strictEqual(t.stateName, 'NEW JERSEY');
});

test('getZipTarget truncates to five digits and rejects unknown ZIPs', () => {
  assert.strictEqual(core.getZipTarget('07302-1234').zip, '07302');
  assert.throws(() => core.getZipTarget('00000'), /could not be resolved/);
});

test('buildProxyPassword uses country+city by default and pins a session', () => {
  const location = core.getZipTarget('07302');
  assert.strictEqual(
    core.buildProxyPassword('secret', location, null),
    'secret_country-us_city-jerseycity',
  );
  assert.strictEqual(
    core.buildProxyPassword('secret', location, 'abc123'),
    'secret_country-us_city-jerseycity_session-abc123_lifetime-' + core.SESSION_LIFETIME_MINUTES + 'm',
  );
});

test('buildProxyPassword widens through the documented tiers', () => {
  const location = core.getZipTarget('07302');
  assert.strictEqual(
    core.buildProxyPassword('secret', location, null, core.TARGETING_TIERS[1]),
    'secret_country-us_state-newjersey',
  );
  assert.strictEqual(
    core.buildProxyPassword('secret', location, null, core.TARGETING_TIERS[2]),
    'secret_country-us',
  );
});

test('certIdFromUrl returns the bare id, and null for no certificate', () => {
  assert.strictEqual(
    core.certIdFromUrl('https://cert.trustedform.com/87e7cb576986a0df6540a8e6e44c473503442ad3'),
    '87e7cb576986a0df6540a8e6e44c473503442ad3',
  );
  assert.strictEqual(core.certIdFromUrl(null), null);
});

test('buildLead maps the CLI test data without hard-coding it', () => {
  const lead = core.buildLead(core.getZipTarget('07302'));
  assert.strictEqual(lead.zip, '07302');
  assert.strictEqual(lead.birthMonth, 7);
  assert.strictEqual(lead.birthDay, '09');
  assert.strictEqual(lead.birthYear, '1982');
  assert.strictEqual(lead.fname, 'Dana');
  assert.strictEqual(lead.email, 'dana.testlead@example.com');
});

test('planField maps the production funnel ids to lead values', () => {
  const lead = core.buildLead(core.getZipTarget('07302'));
  const plan = (field) => core.planField(field, lead);
  assert.deepStrictEqual(plan({ tag: 'input', id: 'zipCode', name: '' }), {
    kind: 'text', key: 'zipcode', selector: '[id="zipCode"]', value: '07302',
  });
  assert.strictEqual(plan({ tag: 'input', id: 'firstName', name: '' }).value, 'Dana');
  assert.strictEqual(plan({ tag: 'input', id: 'lastName', name: '' }).value, 'TestLead');
  assert.strictEqual(plan({ tag: 'input', id: 'phone', name: '' }).value, '5513326220');
  assert.strictEqual(plan({ tag: 'input', id: 'birthYear', name: '' }).value, '1982');
  assert.strictEqual(plan({ tag: 'input', id: '', name: 'address' }).selector, '[name="address"]');
  assert.strictEqual(plan({ tag: 'input', id: 'unrelated', name: '' }), null);
});

test('planField picks the zero-based Angular month and an available height', () => {
  const lead = core.buildLead(core.getZipTarget('07302'));
  const months = ['', 'string:0', 'string:1', 'string:2', 'string:3', 'string:4', 'string:5', 'string:6'];
  assert.strictEqual(
    core.planField({ tag: 'select', id: 'birthMonth', name: '', opts: months }, lead).value,
    'string:6', // July is month 7 -> index 6 of the non-empty options
  );
  assert.strictEqual(
    core.planField({ tag: 'select', id: 'height', name: '', opts: ['', '66', '70', '72'] }, lead).value,
    '70',
  );
  assert.strictEqual(
    core.planField({ tag: 'select', id: 'height', name: '', opts: ['', '66', '72'] }, lead).value,
    '66', // no exact match: falls back to the first real option
  );
  assert.strictEqual(core.planField({ tag: 'select', id: 'empty', name: '', opts: [''] }, lead), null);
});

test('isFinalStep only fires on the contact step', () => {
  assert.strictEqual(core.isFinalStep([{ id: 'zipCode', name: '' }]), false);
  assert.strictEqual(core.isFinalStep([{ id: 'email', name: '' }]), true);
  assert.strictEqual(core.isFinalStep([{ id: '', name: 'firstName' }]), true);
});

test('buildAnswers keys the production hash routes', () => {
  const answers = core.buildAnswers();
  assert.strictEqual(answers['#/gender'], 'Male');
  assert.strictEqual(answers['#/credit-score'], '700-640 Good');
  assert.strictEqual(answers['#/coverage-amount'], '$25,000 (Funeral Expenses)');
});

console.log('reporting');

test('parsePayload handles JSON, form encoding and neither', () => {
  assert.deepStrictEqual(reporting.parsePayload('{"wpm":12}'), { wpm: 12 });
  // Form-encoded values are JSON-parsed where they can be, so numeric signals
  // stay numeric instead of arriving in the report as strings.
  assert.deepStrictEqual(reporting.parsePayload('wpm=12&kpm=60'), { wpm: 12, kpm: 60 });
  assert.deepStrictEqual(reporting.parsePayload('data={"wpm":7}'), { data: { wpm: 7 } });
  assert.strictEqual(reporting.parsePayload(''), null);
  assert.strictEqual(reporting.parsePayload('<html>not a payload</html>'), null);
});

test('extractTrustedFormSignals reports what is present and null for what is not', () => {
  const { signals, observedKeys, sourceCount } = reporting.extractTrustedFormSignals([
    { dir: 'REQ', post: JSON.stringify({ kpm: 84, events: { keydown: 42 } }) },
    { dir: 'RES', body: JSON.stringify({ ok: true }) },
  ]);
  assert.strictEqual(signals.kpm, 84);
  assert.strictEqual(signals.wpm, null, 'wpm was absent, so it must be null - never 0');
  assert.strictEqual(signals.keydown, 42);
  assert.ok(observedKeys.includes('kpm'));
  assert.ok(observedKeys.includes('events.keydown'), 'the full path is reported too');
  assert.strictEqual(sourceCount, 2);
});

test('the LAST ping wins, because the first one always precedes any typing', () => {
  // TrustedForm-style scripts ping from page load onwards. Reporting the first
  // payload would report the pre-interaction zeros for every single run.
  const { signals, series, policy } = reporting.extractTrustedFormSignals([
    { dir: 'REQ', post: '{"wpm":0,"kpm":0}' },
    { dir: 'REQ', post: '{"wpm":11,"kpm":57}' },
    { dir: 'REQ', post: '{"wpm":19,"kpm":96}' },
  ]);
  assert.strictEqual(policy, 'last-observed');
  assert.strictEqual(signals.wpm, 19);
  assert.strictEqual(signals.kpm, 96);
  assert.deepStrictEqual(series.wpm, [0, 11, 19], 'the progression stays visible');
});

test('extractTrustedFormSignals returns nulls for an empty capture', () => {
  const { signals, sourceCount } = reporting.extractTrustedFormSignals([]);
  assert.deepStrictEqual(signals, { wpm: null, kpm: null });
  assert.strictEqual(sourceCount, 0);
});

test('a reported zero stays zero and is never confused with absent', () => {
  const { signals } = reporting.extractTrustedFormSignals([{ dir: 'REQ', post: '{"wpm":0,"kpm":0}' }]);
  assert.strictEqual(signals.wpm, 0);
  assert.strictEqual(signals.kpm, 0);
  assert.notStrictEqual(signals.wpm, null);
});

test('CSV has one row per run and never embeds the event array', () => {
  const record = {
    runId: 'r1', cohort: 'short', targetDurationSec: 27.4, actualDurationSec: 29.17,
    proxy: { ip: '1.2.3.4', city: 'Jersey City', state: 'New Jersey' },
    leadLocation: { zip: '07302', city: 'Jersey City', state: 'NJ' },
    trustedForm: { certificateUrl: 'https://cert.trustedform.com/abc', certificateId: 'abc', signals: { wpm: null, kpm: 12 } },
    interactionSummary: { interactionCount: 91, keystrokeCount: 44, focusCount: 6, blurCount: 6, scrollCount: 3, pauseCount: 20 },
    submission: { timestamp: '2026-09-01T00:00:00.000Z', success: true },
    events: [{ eventType: 'pause' }, { eventType: 'keydown' }],
  };
  const csv = reporting.toCsv([record]);
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], reporting.CSV_COLUMNS.join(','));
  assert.ok(lines[1].includes('https://cert.trustedform.com/abc'));
  assert.ok(lines[1].includes(',12,'), 'kpm should be present');
  assert.ok(!csv.includes('eventType'), 'events must stay out of the CSV');
});

test('CSV escapes commas and quotes', () => {
  assert.strictEqual(reporting.csvEscape('a,b'), '"a,b"');
  assert.strictEqual(reporting.csvEscape('say "hi"'), '"say ""hi"""');
  assert.strictEqual(reporting.csvEscape(null), '');
  assert.strictEqual(reporting.csvEscape(0), '0');
});

test('summarize reports min/max/mean/median per cohort', () => {
  const mk = (cohort, d, success, cert) => ({
    cohort, actualDurationSec: d,
    submission: { success }, trustedForm: { certificateUrl: cert, signals: { wpm: 0, kpm: 0 } },
  });
  const [short] = reporting.summarize([
    mk('short', 10, true, 'c1'), mk('short', 20, true, 'c2'), mk('short', 30, false, null),
  ].map((r, i) => ({ ...r, unpausedSec: 8 + i, targetUnreachable: i === 2 })));
  assert.strictEqual(short.runs, 3);
  assert.strictEqual(short.minDurationSec, 10);
  assert.strictEqual(short.maxDurationSec, 30);
  assert.strictEqual(short.meanDurationSec, 20);
  assert.strictEqual(short.medianDurationSec, 20);
  assert.strictEqual(short.successfulSubmissions, 2);
  assert.strictEqual(short.trustedFormCertificates, 2);
  assert.strictEqual(short.runsWithNonZeroWpm, 0);
  assert.strictEqual(short.meanFunnelFloorSec, 9);
  assert.strictEqual(short.runsWithUnreachableTarget, 1);
});

test('median averages the middle pair for even counts', () => {
  assert.strictEqual(reporting.median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(reporting.median([5]), 5);
  assert.strictEqual(reporting.median([]), null);
});

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.error('\n' + f.name + '\n' + f.error.stack);
  process.exitCode = 1;
}
