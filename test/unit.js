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

// The worker pool is the one thing here that cannot be checked synchronously.
// Async cases are queued and drained at the end rather than making this whole
// file async, so every existing test keeps running exactly as it did.
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

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

test('a series past the cap keeps both ends, so it cannot contradict the signal', () => {
  // A 194-second session pings TrustedForm far more than a hundred times. When
  // the series kept the FIRST hundred, its last entry was some early, smaller
  // number while `signals` reported the true last value - two pieces of the
  // same evidence disagreeing. Head and tail are kept instead.
  const pings = Array.from({ length: 342 }, (_, i) => ({ dir: 'REQ', post: JSON.stringify({ kpm: i }) }));
  const { signals, series, seriesElided, seriesLimit } = reporting.extractTrustedFormSignals(pings);

  assert.strictEqual(series.kpm.length, seriesLimit, 'the series must stay bounded');
  assert.strictEqual(series.kpm[0], 0, 'the pre-interaction zero must survive');
  assert.strictEqual(series.kpm[series.kpm.length - 1], signals.kpm,
    'the series must end on the value the report claims');
  assert.strictEqual(signals.kpm, 341);

  // What fell out of the middle is counted, not passed over in silence.
  assert.deepStrictEqual(seriesElided.kpm, {
    observed: 342, kept: seriesLimit, elided: 342 - seriesLimit, gapIndex: series.kpm.indexOf(292),
  });
});

test('a series inside the cap is complete, and reports no elision at all', () => {
  const pings = Array.from({ length: 40 }, (_, i) => ({ dir: 'REQ', post: JSON.stringify({ kpm: i }) }));
  const { series, seriesElided } = reporting.extractTrustedFormSignals(pings);
  assert.strictEqual(series.kpm.length, 40);
  assert.deepStrictEqual(series.kpm, Array.from({ length: 40 }, (_, i) => i));
  assert.strictEqual(seriesElided.kpm, undefined, 'nothing was dropped, so nothing may be claimed');
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

// ---------------------------------------------------------------------------
// Batch CSV harness: sanitization, and the qualification distributions.
// ---------------------------------------------------------------------------

const leadCsv = require('../scripts/lib/leadCsv');
const qual = require('../scripts/lib/qualification');

test('CSV parsing handles quotes, embedded commas and embedded newlines', () => {
  const rows = leadCsv.parseCsv('a,b,c\n1,"x, y",3\n4,"he said ""hi""",6\n7,"two\nlines",9\n');
  assert.deepStrictEqual(rows[0], ['a', 'b', 'c']);
  assert.deepStrictEqual(rows[1], ['1', 'x, y', '3']);
  assert.deepStrictEqual(rows[2], ['4', 'he said "hi"', '6']);
  assert.deepStrictEqual(rows[3], ['7', 'two\nlines', '9']);
  assert.strictEqual(rows.length, 4);
});

test('DOB standardizes to MM/DD/YYYY with zero padding', () => {
  assert.strictEqual(leadCsv.normalizeDob('4/15/1985'), '04/15/1985');
  assert.strictEqual(leadCsv.normalizeDob('04/15/1985'), '04/15/1985');
  assert.strictEqual(leadCsv.normalizeDob('1985-04-15'), '04/15/1985');
  assert.strictEqual(leadCsv.normalizeDob('4-5-1985'), '04/05/1985');
  assert.strictEqual(leadCsv.normalizeDob('12/31/1999'), '12/31/1999');
});

test('DOB rejects ambiguous and impossible dates instead of guessing', () => {
  assert.throws(() => leadCsv.normalizeDob('4/15/85'), /ambiguous/);
  assert.throws(() => leadCsv.normalizeDob('02/30/1985'), /not a real date/);
  assert.throws(() => leadCsv.normalizeDob('13/01/1985'), /month 13/);
  assert.throws(() => leadCsv.normalizeDob(''), /empty/);
});

test('phone reduces to 10 digits and refuses to truncate', () => {
  assert.strictEqual(leadCsv.normalizePhone('(551) 332-6220'), '5513326220');
  assert.strictEqual(leadCsv.normalizePhone('551.332.6220'), '5513326220');
  assert.strictEqual(leadCsv.normalizePhone('1-551-332-6220'), '5513326220');
  assert.throws(() => leadCsv.normalizePhone('551332'), /has 6 digits/);
  assert.throws(() => leadCsv.normalizePhone('12345678901234'), /digits/);
});

test('gender normalizes to lowercase male/female', () => {
  assert.strictEqual(leadCsv.normalizeGender('Male'), 'male');
  assert.strictEqual(leadCsv.normalizeGender('F'), 'female');
  assert.strictEqual(leadCsv.normalizeGender('WOMAN'), 'female');
  assert.strictEqual(leadCsv.normalizeGender('Non-Binary'), 'non-binary');
});

test('test-record detection recognizes reserved domains and test markers', () => {
  assert.ok(leadCsv.looksLikeTestRecord({ email: 'a@example.com', lastName: 'Smith' }).isTest);
  assert.ok(leadCsv.looksLikeTestRecord({ email: 'a@sub.example.org', lastName: 'Smith' }).isTest);
  assert.ok(leadCsv.looksLikeTestRecord({ email: 'a@foo.test', lastName: 'Smith' }).isTest);
  assert.ok(leadCsv.looksLikeTestRecord({ email: 'real@gmail.com', lastName: 'TestLead' }).isTest);
  assert.ok(!leadCsv.looksLikeTestRecord({ email: 'real@gmail.com', lastName: 'Smith' }).isTest);
});

test('datePosted is MM/DD/YYYY', () => {
  assert.strictEqual(leadCsv.datePosted(new Date(2026, 8, 1)), '09/01/2026');
  assert.strictEqual(leadCsv.datePosted(new Date(2026, 0, 5)), '01/05/2026');
});

test('header matching ignores case, spaces, underscores and dashes', () => {
  const { index, missing } = leadCsv.resolveHeaders([
    'first name', 'LAST-NAME', 'Sex', 'age', 'Street Address',
    'city', 'State', 'Zip Code', 'Phone Number', 'Email Address', 'birthDate',
  ]);
  assert.deepStrictEqual(missing, []);
  assert.strictEqual(index.First_Name, 0);
  assert.strictEqual(index.Zip, 7);
  assert.strictEqual(index.DOB, 10);
});

test('header matching reports the columns it could not find', () => {
  const { missing } = leadCsv.resolveHeaders(['First_Name', 'Last_Name']);
  assert.ok(missing.includes('DOB'));
  assert.ok(!missing.includes('First_Name'));
});

test('a repeated column resolves to its leftmost occurrence', () => {
  const { index } = leadCsv.resolveHeaders([
    'Email', 'First_Name', 'Last_Name', 'Gender', 'Age', 'Address',
    'City', 'State', 'Zip', 'Phone', 'email_address', 'DOB',
  ]);
  assert.strictEqual(index.Email, 0);
});

test('output CSV has the 13 specified headers in order', () => {
  assert.deepStrictEqual(leadCsv.OUTPUT_HEADERS, [
    'firstName', 'lastName', 'phone', 'email', 'address', 'city', 'state',
    'zipCode', 'birthdate', 'gender', 'ipAddress', 'trustedFormURL', 'datePosted',
  ]);
});

// --- distributions ---------------------------------------------------------

function sample(n, gender) {
  const rng = qual.mulberry32(12345);
  const counts = {};
  for (let i = 0; i < n; i += 1) {
    const q = qual.generateQualification(gender, rng);
    for (const key of ['currentlyInsured', 'married', 'homeowner', 'tobacco', 'creditScore', 'heightInches']) {
      counts[key] = counts[key] || {};
      counts[key][q[key]] = (counts[key][q[key]] || 0) + 1;
    }
    counts.weights = counts.weights || [];
    counts.weights.push(Number(q.weightLbs));
  }
  return counts;
}

const N = 40000;
const near = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    label + ': got ' + actual.toFixed(2) + '%, expected ~' + expected + '% (±' + tolerance + ')');
};

test('weighted fields match the specified distributions over 40k samples', () => {
  const c = sample(N, 'male');
  const pct = (group, key) => ((c[group][key] || 0) / N) * 100;
  near(pct('currentlyInsured', 'No'), 90, 1, 'currentlyInsured No');
  near(pct('currentlyInsured', 'Yes'), 10, 1, 'currentlyInsured Yes');
  near(pct('married', 'No'), 50, 1, 'married No');
  near(pct('homeowner', 'Yes'), 70, 1, 'homeowner Yes');
  near(pct('homeowner', 'No'), 30, 1, 'homeowner No');
  near(pct('tobacco', 'No'), 95, 1, 'tobacco No');
  near(pct('tobacco', 'Yes'), 5, 1, 'tobacco Yes');
});

test('credit tiers are uniform over the four values the live form offers', () => {
  const c = sample(N, 'male');
  assert.deepStrictEqual(Object.keys(c.creditScore).sort(), [...qual.CREDIT_TIERS].sort());
  for (const tier of qual.CREDIT_TIERS) {
    near((c.creditScore[tier] / N) * 100, 25, 1.5, 'credit ' + tier);
  }
});

test('male height distribution matches the specification exactly', () => {
  const c = sample(N, 'male');
  // 5'10" = 70in at 25%, 6'0" = 72in at 20%, 5'7" = 67in at 2%
  near((c.heightInches['70'] / N) * 100, 25, 1, "male 5'10\"");
  near((c.heightInches['72'] / N) * 100, 20, 1, "male 6'0\"");
  near((c.heightInches['71'] / N) * 100, 20, 1, "male 5'11\"");
  near((c.heightInches['69'] / N) * 100, 17, 1, "male 5'9\"");
  near((c.heightInches['68'] / N) * 100, 11, 1, "male 5'8\"");
  near((c.heightInches['67'] / N) * 100, 2, 1, "male 5'7\"");
});

test('female height weights sum to 110 and are normalized, preserving every ratio', () => {
  const total = qual.HEIGHT_FEMALE.reduce((s, [, w]) => s + w, 0);
  assert.strictEqual(total, 110, 'the specified female weights sum to 110, not 100');
  const c = sample(N, 'female');
  // Each specified weight w becomes w/110 of the population.
  near((c.heightInches['64'] / N) * 100, (15 / 110) * 100, 1, "female 5'4\"");
  near((c.heightInches['63'] / N) * 100, (15 / 110) * 100, 1, "female 5'3\"");
  near((c.heightInches['62'] / N) * 100, (12 / 110) * 100, 1, "female 5'2\"");
  near((c.heightInches['60'] / N) * 100, (8 / 110) * 100, 1, "female 5'0\"");
  // Ratios from the specification survive normalization: 5'4" is 15/8 of 5'0".
  const ratio = c.heightInches['64'] / c.heightInches['60'];
  assert.ok(Math.abs(ratio - 15 / 8) < 0.15, "5'4\":5'0\" ratio was " + ratio.toFixed(3));
});

test('height is submitted as inches, which is what the live select contains', () => {
  const q = qual.generateQualification('male', qual.mulberry32(7));
  assert.ok(/^\d{2}$/.test(q.heightInches), 'heightInches was ' + q.heightInches);
  const inches = Number(q.heightInches);
  assert.ok(inches >= 55 && inches <= 83, 'outside the form range: ' + inches);
  assert.strictEqual(q.heightLabel, Math.floor(inches / 12) + "'" + (inches % 12) + '"');
});

test('weight stays inside the gendered bounds', () => {
  const male = sample(4000, 'male').weights;
  assert.ok(Math.min(...male) >= 155, 'male min was ' + Math.min(...male));
  assert.ok(Math.max(...male) <= 275, 'male max was ' + Math.max(...male));
  const female = sample(4000, 'female').weights;
  assert.ok(Math.min(...female) >= 120, 'female min was ' + Math.min(...female));
  assert.ok(Math.max(...female) <= 210, 'female max was ' + Math.max(...female));
  assert.ok(male.every(Number.isInteger), 'weights must be integers');
});

test('static fields are constant on every record', () => {
  const rng = qual.mulberry32(99);
  for (let i = 0; i < 200; i += 1) {
    const q = qual.generateQualification(i % 2 ? 'male' : 'female', rng);
    assert.strictEqual(q.military, 'No');
    assert.strictEqual(q.cancer, 'No');
    assert.strictEqual(q.heartDisease, 'No');
    assert.strictEqual(q.coverageAmount, '$25,000 (Funeral Expenses)');
  }
});

test('a seed reproduces a batch exactly', () => {
  const a = qual.generateQualification('female', qual.mulberry32(4242));
  const b = qual.generateQualification('female', qual.mulberry32(4242));
  assert.deepStrictEqual(a, b);
});

test('funnel answers use the live form vocabulary for every hash route', () => {
  const q = qual.generateQualification('female', qual.mulberry32(3));
  const a = qual.toFunnelAnswers(q, 'female');
  assert.strictEqual(a['#/gender'], 'Female');
  assert.strictEqual(a['#/va-loan'], 'No');
  assert.strictEqual(a['#/coverage-amount'], '$25,000 (Funeral Expenses)');
  assert.ok(qual.CREDIT_TIERS.includes(a['#/credit-score']));
  for (const route of ['#/currently-insured', '#/marriage-status', '#/homeowner', '#/tobacco-use']) {
    assert.ok(['Yes', 'No'].includes(a[route]), route + ' was ' + a[route]);
  }
  // Every route the answer map covers must exist in the runner's own default map.
  const defaults = core.buildAnswers();
  assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(defaults).sort());
});

test('an unspecified gender still gets a height and weight, and is flagged', () => {
  const q = qual.generateQualification('non-binary', qual.mulberry32(11));
  assert.ok(/unspecified/.test(q.genderBasis), 'genderBasis was ' + q.genderBasis);
  assert.ok(Number(q.heightInches) >= 55);
  assert.ok(Number(q.weightLbs) >= 120 && Number(q.weightLbs) <= 275);
  assert.strictEqual(qual.toFunnelAnswers(q, 'non-binary')['#/gender'], 'Non-Binary');
});

// ---------------------------------------------------------------------------
console.log('');
console.log('pool');

const pool = require('../scripts/lib/pool');

test('clampConcurrency floors, bounds and falls back rather than throwing', () => {
  assert.strictEqual(pool.clampConcurrency(3), 3);
  assert.strictEqual(pool.clampConcurrency('4'), 4);
  assert.strictEqual(pool.clampConcurrency(2.9), 2);
  assert.strictEqual(pool.clampConcurrency(0), 1);
  assert.strictEqual(pool.clampConcurrency(-5), 1);
  assert.strictEqual(pool.clampConcurrency(999), pool.MAX_CONCURRENCY);
  assert.strictEqual(pool.clampConcurrency(8, { max: 4 }), 4);
  // A blank env var or an absent JSON field must not stop a batch starting.
  assert.strictEqual(pool.clampConcurrency(undefined, { fallback: 3 }), 3);
  assert.strictEqual(pool.clampConcurrency('', { fallback: 3 }), 3);
  assert.strictEqual(pool.clampConcurrency('nonsense', { fallback: 3 }), 3);
  // Even a fallback is bounded by the caller's ceiling.
  assert.strictEqual(pool.clampConcurrency(null, { fallback: 9, max: 4 }), 4);
});

testAsync('runPool never exceeds its concurrency, and does use it', async () => {
  let inFlight = 0;
  let peak = 0;
  await pool.runPool({
    items: Array.from({ length: 12 }, (_, i) => i),
    concurrency: 4,
    run: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
    },
  });
  assert.strictEqual(peak, 4, 'peak in flight was ' + peak);
  assert.strictEqual(inFlight, 0);
});

testAsync('runPool returns results in INPUT order however they finish', async () => {
  // Reverse-ordered delays, so the last item finishes first. The output CSV and
  // the forensic record are specified to be in input order regardless.
  const items = [0, 1, 2, 3, 4, 5];
  const results = await pool.runPool({
    items,
    concurrency: 6,
    run: async (item) => {
      await new Promise((r) => setTimeout(r, (items.length - item) * 8));
      return 'row' + item;
    },
  });
  assert.deepStrictEqual(results.map((r) => r.value), ['row0', 'row1', 'row2', 'row3', 'row4', 'row5']);
  assert.deepStrictEqual(results.map((r) => r.index), [0, 1, 2, 3, 4, 5]);
});

testAsync('one row throwing is recorded, and the rest of the batch still runs', async () => {
  const results = await pool.runPool({
    items: [1, 2, 3],
    concurrency: 2,
    run: async (item) => {
      if (item === 2) throw new Error('funnel stalled');
      return item * 10;
    },
  });
  assert.strictEqual(results[0].value, 10);
  assert.strictEqual(results[1].value, null);
  assert.strictEqual(results[1].error.message, 'funnel stalled');
  assert.strictEqual(results[2].value, 30);
});

testAsync('onSettled sees every row that has landed, as it lands', async () => {
  const seen = [];
  await pool.runPool({
    items: ['a', 'b', 'c', 'd'],
    concurrency: 2,
    run: async (item) => item.toUpperCase(),
    // Whatever has completed must already be readable here: this is what lets
    // the CSV and the progress file be written while a batch is still running.
    onSettled: (settled, all) => { seen.push(all.filter(Boolean).length); },
  });
  assert.deepStrictEqual(seen, [1, 2, 3, 4]);
});

testAsync('starts are staggered, so N browsers do not open the funnel on one tick', async () => {
  const startedAt = [];
  const t0 = Date.now();
  await pool.runPool({
    items: [0, 1, 2],
    concurrency: 3,
    staggerMs: 40,
    run: async () => { startedAt.push(Date.now() - t0); },
  });
  assert.strictEqual(startedAt.length, 3);
  // Three starts 40ms apart puts the last at ~80ms. Compared against a floor
  // rather than an exact value: a timer only ever promises "not before".
  assert.ok(startedAt[2] >= 70, 'third start was at ' + startedAt[2] + 'ms');
});

// ---------------------------------------------------------------------------
// Drain the queued async cases, then report. Everything above this line has
// already run synchronously, exactly as it did before the queue existed.
(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      passed += 1;
      console.log('  ok  ' + name);
    } catch (error) {
      failures.push({ name, error });
      console.log('  FAIL ' + name + ': ' + error.message);
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n' + f.error.stack);
    process.exitCode = 1;
  }
})();
