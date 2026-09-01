#!/usr/bin/env node
'use strict';

//
// Batch CSV test harness for the authorized ActiveProspect experiment.
//
// Takes a CSV of authorized test records, and for each row runs the PROVEN
// browser path already in this repository:
//
//   fresh browser context
//     -> IPRoyal residential proxy, geo-selected from the record's ZIP
//     -> the real quote funnel at quotes.nationallifecoverage.org
//     -> TrustedForm initializes normally
//     -> the real form is completed with real browser events
//     -> the real form is submitted
//     -> the actual TrustedForm certificate and the actual observed IP recorded
//
// It does not replace that path: it calls behavioralTestRunner.runOnce(), which
// is the same code the behavioural harness uses. This file only adds the batch
// layer - CSV in, qualification variables, CSV + forensic reports out - and the
// full behavioural experiment (duration cohorts, field order, pauses, scrolling,
// keystroke telemetry) is preserved for every row.
//
// Two outputs per batch:
//   1. the business CSV, one row per record, with the 13 specified headers
//   2. the forensic record: per-run JSON, TrustedForm captures, full timeline
//
// Nothing is fabricated. The IP is the one the application actually observed,
// the certificate is the one the browser session actually produced, and if
// either is missing the field is left empty rather than filled in.
//
// Requires --test-mode. By default it also requires every record to look like a
// synthetic/authorized test record; see --allow-non-test-records.
//

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('./lib/funnelCore');
const leadCsv = require('./lib/leadCsv');
const pool = require('./lib/pool');
const qualification = require('./lib/qualification');
const reporting = require('./lib/reporting');

// Loaded lazily, inside the submitting path only. Requiring it pulls in
// playwright-core, and --help and --dry-run have no business needing a browser
// library installed to tell you what they would do.
let runner = null;
const loadRunner = () => (runner || (runner = require('./behavioralTestRunner')));

const { arg, hasFlag, required } = core;

// With rows running one at a time this was the gap between them; with a pool it
// is the minimum gap between two STARTS, which is the same spacing seen from
// the funnel's side and stops N browsers opening it on the same tick.
const BETWEEN_RUNS_MS = Number(process.env.BEHAVIOR_BETWEEN_RUNS_MS || 3000);
const DEFAULT_CONCURRENCY = pool.clampConcurrency(process.env.BATCH_CONCURRENCY, { fallback: 3 });

function usage() {
  return [
    'Authorized batch CSV test harness (requires --test-mode).',
    '',
    'Usage:',
    '  node scripts/batchCsvRunner.js --test-mode --input leads.csv',
    '',
    'Options:',
    '  --test-mode                Required. Without it the harness refuses to run.',
    '  --input <file>             Input CSV. Required. Columns:',
    '                             ' + leadCsv.REQUIRED_HEADERS.join(', '),
    '                             Matched on letters and digits only, so case, spaces,',
    '                             underscores and dashes are ignored and the usual',
    '                             variants are accepted (birthDate satisfies DOB).',
    '  --output <file>            Final CSV (default: <report-dir>/leads-<batchId>.csv)',
    '  --report-dir <path>        Forensic output (default: test-reports/)',
    '  --cohort <name>            short | medium | long | mixed   (default: mixed)',
    '  --concurrency <n>          Rows to run at once, 1-' + pool.MAX_CONCURRENCY
      + ' (default: ' + DEFAULT_CONCURRENCY + ').',
    '                             Each row is a separate browser, proxy session and',
    '                             certificate, so they overlap without interfering;',
    '                             n is bounded by RAM, not by the funnel. Budget',
    '                             ~600MB per concurrent row.',
    '  --limit <n>                Only process the first n rows',
    '  --seed <n>                 Seed the qualification generator for reproducibility',
    '  --telemetry-keys <mode>    redacted (default) | raw',
    '  --entry-mode <mode>        type (default) | fill',
    '  --target-wpm <n>           Type at the rate that makes TrustedForm report ~n wpm.',
    '  --dry-run                  Sanitize, generate and report. Submits nothing.',
    '  --offline-selftest         Drive the loopback mock funnel. No proxy, no live submit.',
    '  --allow-non-test-records   Permit rows that do not look like test records.',
    '',
    'Distributions in force:',
    qualification.describeDistributions().split('\n').map((l) => '  ' + l).join('\n'),
  ].join('\n');
}

/**
 * Write machine-readable progress for a supervising process (the dashboard).
 *
 * A file rather than stdout: parsing log lines to drive a UI breaks the moment
 * the wording changes, and this is written atomically so a poller never reads a
 * half-written object.
 */
function writeProgress(progressPath, state) {
  if (!progressPath) return;
  try {
    const tmp = progressPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, progressPath);
  } catch { /* progress is advisory; never fail a batch over it */ }
}

/** Cohort per row. "mixed" rotates so a batch spans all three ranges. */
function cohortFor(mode, index) {
  if (mode !== 'mixed') return mode;
  return ['short', 'medium', 'long'][index % 3];
}

async function main() {
  if (hasFlag('help')) { console.log(usage()); return; }

  if (!hasFlag('test-mode')) {
    console.error('Refusing to run: the batch harness requires --test-mode.');
    console.error('It submits to the live quote funnel and must never run as production traffic.');
    console.error('');
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const inputPath = required('--input', arg('input', process.env.BATCH_INPUT_CSV));
  const cohortMode = String(arg('cohort', 'mixed')).toLowerCase();
  if (!['short', 'medium', 'long', 'mixed'].includes(cohortMode)) {
    throw new Error('--cohort must be short, medium, long or mixed');
  }
  const concurrencyArg = arg('concurrency', null);
  if (concurrencyArg !== null && !(Number(concurrencyArg) >= 1)) {
    throw new Error('--concurrency must be a positive integer (1-' + pool.MAX_CONCURRENCY + ')');
  }
  const concurrency = pool.clampConcurrency(concurrencyArg, { fallback: DEFAULT_CONCURRENCY });
  const telemetryKeys = String(arg('telemetry-keys', 'redacted')).toLowerCase();
  if (!['redacted', 'raw'].includes(telemetryKeys)) {
    throw new Error('--telemetry-keys must be "redacted" or "raw"');
  }
  const entryMode = String(arg('entry-mode', 'type')).toLowerCase();
  if (!['type', 'fill'].includes(entryMode)) {
    throw new Error('--entry-mode must be "type" or "fill"');
  }
  const targetWpmArg = arg('target-wpm', null);
  const targetWpm = targetWpmArg === null ? null : Number(targetWpmArg);
  if (targetWpm !== null && !(targetWpm > 0 && targetWpm < 1000)) {
    throw new Error('--target-wpm must be a positive number below 1000');
  }
  const dryRun = hasFlag('dry-run');
  const allowNonTest = hasFlag('allow-non-test-records');

  // Offline mode drives the loopback mock funnel with no proxy, so the whole
  // pipeline can be exercised without submitting anything anywhere. Refuses a
  // non-loopback target, so it can never quietly become a live run.
  const offline = hasFlag('offline-selftest');
  if (offline) {
    const { hostname } = new URL(core.TARGET_URL);
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
      throw new Error('--offline-selftest requires PRODUCTION_FUNNEL_URL to be loopback; got ' + core.TARGET_URL);
    }
  }

  const reportDir = path.resolve(arg('report-dir', process.env.BEHAVIOR_REPORT_DIR || 'test-reports'));
  fs.mkdirSync(reportDir, { recursive: true });

  const batchId = arg('batch-id', null)
    || (new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
      + '-' + Math.random().toString(36).slice(2, 8));
  const progressPath = arg('progress-file', null);
  const seed = Number(arg('seed', (Math.random() * 1e9) | 0));
  const rng = qualification.mulberry32(seed);

  // ---- load + sanitize -----------------------------------------------------
  const { rows, errors } = leadCsv.loadLeadCsv(inputPath);
  const limit = arg('limit', null);
  const selected = limit ? rows.slice(0, Number(limit)) : rows;

  console.log('===== BATCH CSV TEST HARNESS (AUTHORIZED TEST) =====');
  console.log('batch:        ' + batchId);
  console.log('input:        ' + inputPath);
  console.log('rows:         ' + rows.length + ' usable, ' + errors.length + ' rejected'
    + (limit ? ', processing first ' + selected.length : ''));
  console.log('cohort:       ' + cohortMode);
  console.log('concurrency:  ' + concurrency + (concurrency === 1 ? '  (one row at a time)'
    : '  (' + concurrency + ' rows in flight, each its own browser and proxy session)'));
  console.log('entry mode:   ' + entryMode + (entryMode === 'type' ? '  (real key events)' : '  (value assignment)'));
  console.log('seed:         ' + seed);
  console.log('report dir:   ' + reportDir);
  console.log('target:       ' + core.TARGET_URL);
  console.log('');
  console.log(qualification.describeDistributions());
  console.log('');

  if (errors.length) {
    console.log('REJECTED ROWS (not submitted):');
    for (const e of errors) console.log('  line ' + e.lineNumber + ': ' + e.error);
    console.log('');
  }
  if (!selected.length) throw new Error('No usable rows in ' + inputPath);
  writeProgress(progressPath, {
    batchId, phase: 'starting', total: selected.length, completed: 0,
    submitted: 0, certificates: 0, rejectedAtInput: errors.length, concurrency, rows: [],
  });

  // ---- test-record gate ----------------------------------------------------
  const nonTest = selected.filter((r) => !r.testRecord.isTest);
  if (nonTest.length) {
    console.log('WARNING: ' + nonTest.length + ' of ' + selected.length
      + ' row(s) do not look like synthetic/authorized test records.');
    console.log('A record is recognized as test data by a reserved email domain'
      + ' (example.com/.test/.invalid) or a test marker in the name.');
    for (const r of nonTest.slice(0, 10)) {
      console.log('  line ' + r.lineNumber + ': ' + r.firstName + ' ' + r.lastName + ' <' + r.email + '>');
    }
    if (nonTest.length > 10) console.log('  ... and ' + (nonTest.length - 10) + ' more');
    console.log('');
    if (!allowNonTest) {
      console.error('Refusing to submit. Each submission generates a real TrustedForm certificate,');
      console.error('which is consent evidence about the person it names, so the default is to');
      console.error('submit only records that are self-evidently test data.');
      console.error('Re-run with --allow-non-test-records if these are authorized.');
      process.exitCode = 3;
      return;
    }
    console.log('--allow-non-test-records given; proceeding.');
    console.log('');
  }

  // ---- generate qualification variables for every row ----------------------
  const prepared = selected.map((row, i) => {
    const quals = qualification.generateQualification(row.gender, rng);
    return {
      row,
      quals,
      cohort: cohortFor(cohortMode, i),
      answers: qualification.toFunnelAnswers(quals, row.gender),
    };
  });

  if (dryRun) {
    console.log('--dry-run: showing what would be submitted; nothing is sent.');
    console.log('');
    for (const p of prepared) {
      console.log(p.row.firstName + ' ' + p.row.lastName + '  [' + p.cohort + ']  '
        + p.row.city + ', ' + p.row.state + ' ' + p.row.zip
        + '  dob=' + p.row.dob + '  phone=' + p.row.phone);
      console.log('    ' + JSON.stringify({
        gender: p.answers['#/gender'],
        currentlyInsured: p.quals.currentlyInsured,
        married: p.quals.married,
        homeowner: p.quals.homeowner,
        tobacco: p.quals.tobacco,
        credit: p.quals.creditScore,
        height: p.quals.heightLabel + ' (' + p.quals.heightInches + 'in)',
        weight: p.quals.weightLbs,
      }));
    }
    const outPath = path.join(reportDir, 'dry-run-' + batchId + '.json');
    fs.writeFileSync(outPath, JSON.stringify({ batchId, seed, prepared }, null, 2));
    console.log('');
    console.log('dry-run detail: ' + outPath);
    return;
  }

  // ---- credentials + proxy preflight, once ---------------------------------
  const behavioral = loadRunner();

  // Draw every row's duration target here, in input order, rather than as each
  // row starts. With rows overlapping, "as each row starts" is whatever order
  // the pool happens to schedule them in, and the same --seed would stop
  // reproducing the same batch. Done up front it still does.
  for (const p of prepared) {
    const [lo, hi] = behavioral.COHORT_RANGES[p.cohort];
    p.targetDurationSec = Math.round((lo + rng() * (hi - lo)) * 10) / 10;
    p.runId = batchId + '-row' + String(p.row.lineNumber).padStart(3, '0') + '-' + p.cohort;
  }

  let credentials = { username: null, basePassword: null };
  if (offline) {
    console.log('--offline-selftest: loopback mock funnel, no proxy, nothing submitted anywhere.');
    console.log('');
  } else {
    credentials = {
      username: required('IPROYAL_PROXY_USERNAME', process.env.IPROYAL_PROXY_USERNAME),
      basePassword: required('IPROYAL_PROXY_PASSWORD', process.env.IPROYAL_PROXY_PASSWORD),
    };
    const firstLocation = core.getZipTarget(prepared[0].row.zip);
    const probe = await core.preflightProxy({
      host: core.PROXY_HOST, port: core.PROXY_PORT,
      username: credentials.username, basePassword: credentials.basePassword,
      location: firstLocation, ipCheckUrl: core.IP_CHECK_URL,
    });
    console.log('IPRoyal CONNECT preflight: HTTP ' + probe.statusCode + ' (tunnel established)');
    console.log('');
  }

  // ---- run the records, `concurrency` at a time ----------------------------
  //
  // Rows never depended on one another: each launches its own browser process,
  // selects its own residential session, and produces its own certificate. The
  // only thing that made a batch take the sum of every row's session was the
  // loop that ran them. They overlap now, and everything downstream still works
  // in input order, so the CSV and the forensic record read exactly as before.
  const slots = new Array(prepared.length).fill(null);  // one per input row, input order
  const inFlight = new Map();                           // index -> name, for the progress file

  // Resolved before the run, not after it. A 383-row batch runs for a long
  // time, and holding every accepted row in memory until the end meant an
  // interrupted run - or simply one still in progress - had no CSV at all,
  // even though most of the work was done. The file is rewritten as rows land
  // instead, so whatever has completed is always downloadable.
  const outputPath = path.resolve(arg('output', path.join(reportDir, 'leads-' + batchId + '.csv')));

  // Ordered views over whatever has finished so far. Rebuilt on demand rather
  // than appended to: rows now finish out of order, and both the CSV and the
  // forensic record are specified to be in input order.
  const settled = () => slots.filter(Boolean);
  const acceptedRows = () => settled().filter((s) => s.outputRow).map((s) => s.outputRow);

  /**
   * Rewrite the CSV and the progress file from what has completed.
   *
   * Called after every row, accepted or not. Rewriting rather than appending
   * costs nothing next to the 30-60s a row takes, and it is what lets a batch
   * be read while it is still running - including one whose rows are landing
   * out of order.
   */
  function publish(phase) {
    const done = settled();
    leadCsv.writeOutputCsv(outputPath, acceptedRows());
    writeProgress(progressPath, {
      batchId,
      phase,
      total: prepared.length,
      completed: done.length,
      submitted: done.filter((s) => s.outputRow).length,
      certificates: done.filter((s) => s.record.trustedForm && s.record.trustedForm.certificateUrl).length,
      rejectedAtInput: errors.length,
      concurrency,
      // There is no single current row any more; name every one in flight.
      current: [...inFlight.values()].join(', ') || null,
      rows: done.map((s) => ({
        name: s.record.sourceRow
          ? s.record.sourceRow.firstName + ' ' + s.record.sourceRow.lastName : '?',
        zip: s.record.sourceRow ? s.record.sourceRow.zip : null,
        cohort: s.record.cohort,
        success: !!(s.record.submission && s.record.submission.success),
        certificateId: (s.record.trustedForm && s.record.trustedForm.certificateId) || null,
        ip: (s.record.proxy && s.record.proxy.ip) || null,
        durationSec: s.record.actualDurationSec === undefined ? null : s.record.actualDurationSec,
        error: s.record.error || null,
      })),
    });
  }

  /**
   * One row, start to finish. Never throws: a row that fails is a recorded
   * outcome, not an event that should take the rest of the batch with it.
   *
   * Every line it prints carries the row's own prefix, because with a pool the
   * log is interleaved and an unattributed "run failed" belongs to nobody.
   */
  async function runRow(prep, i) {
    const { row, quals, cohort, answers, targetDurationSec, runId } = prep;
    const prefix = '[' + (i + 1) + '/' + prepared.length + '] ';
    const name = row.firstName + ' ' + row.lastName;
    inFlight.set(i, name);

    console.log(prefix + runId + '  ' + name + '  ' + row.zip
      + '  ' + cohort + ' target ' + targetDurationSec + 's');

    let record = null;

    // ZIP drives the residential proxy location, exactly as the proven runner does.
    let location = null;
    try {
      location = core.getZipTarget(row.zip);
    } catch (error) {
      console.log(prefix + '    SKIPPED: ' + error.message);
      record = {
        runId, cohort, error: error.message,
        submission: { success: false }, trustedForm: {}, proxy: {},
      };
    }

    if (location) {
      const dobParts = row.dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const lead = {
        zip: location.zip,
        birthMonth: Number(dobParts[1]),
        birthDay: dobParts[2],
        birthYear: dobParts[3],
        height: quals.heightInches,
        weight: Number(quals.weightLbs),
        address: row.address,
        fname: row.firstName,
        lname: row.lastName,
        email: row.email,
        phone: row.phone,
      };

      try {
        record = await behavioral.runOnce({
          runId, cohort, index: i + 1, lead, location, credentials, targetDurationSec,
          reportDir, batchId, offline, telemetryKeys, entryMode, answers, targetWpm,
          logPrefix: prefix,
        });
      } catch (error) {
        console.log(prefix + '    ERROR: ' + error.message);
        record = {
          runId, cohort, error: error.message,
          submission: { success: false }, trustedForm: {}, proxy: {},
        };
      }
    }

    // Attach the experiment's inputs to the forensic record.
    record.sourceRow = {
      lineNumber: row.lineNumber,
      firstName: row.firstName, lastName: row.lastName, gender: row.gender,
      age: row.age, address: row.address, city: row.city, state: row.state,
      zip: row.zip, phone: row.phone, email: row.email, dob: row.dob,
      recognizedAsTestRecord: row.testRecord.isTest,
      testRecordReasons: row.testRecord.reasons,
    };
    record.qualification = quals;
    record.qualificationAnswers = answers;
    record.qualificationNote = 'Generated experimental input variables. '
      + 'They are not assertions about a real person.';

    const cert = record.trustedForm && record.trustedForm.certificateUrl;
    const observedIp = record.proxy && record.proxy.ip;
    const accepted = !!(record.submission && record.submission.success);

    console.log(prefix + '    ip ' + (observedIp || 'none')
      + '  cert ' + (record.trustedForm && record.trustedForm.certificateId || 'none')
      + '  actual ' + (record.actualDurationSec === undefined ? '?' : record.actualDurationSec) + 's'
      + '  weight ' + (record.weightSubmitted === undefined ? 'not set' : record.weightSubmitted)
      + '  success ' + accepted);

    // Only a submission the funnel actually accepted belongs in the business
    // CSV. TrustedForm issues a certificate on page load, so a rejected row
    // still has one; writing it here would make a lead that does not exist
    // indistinguishable from one that does. Rejected rows stay in the forensic
    // record, which says exactly what happened.
    slots[i] = {
      record,
      outputRow: accepted ? {
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone,
        email: row.email,
        address: row.address,
        city: row.city,
        state: row.state,
        zipCode: row.zip,
        birthdate: row.dob,
        gender: row.gender,
        // Observed, never fabricated. Empty when the run did not produce one.
        ipAddress: observedIp || '',
        trustedFormURL: cert || '',
        datePosted: leadCsv.datePosted(),
      } : null,
      omitted: accepted ? null : {
        line: row.lineNumber,
        name,
        reason: (record.error || (record.submission && record.submission.response) || 'submission not accepted')
          .toString().slice(0, 120),
        certificateStillIssued: !!cert,
      },
    };
    inFlight.delete(i);
    return record;
  }

  await pool.runPool({
    items: prepared,
    concurrency,
    staggerMs: BETWEEN_RUNS_MS,
    run: runRow,
    onSettled: () => publish('running'),
  });

  const records = settled().map((s) => s.record);
  const outputRows = acceptedRows();
  const omitted = settled().map((s) => s.omitted).filter(Boolean);

  // ---- outputs -------------------------------------------------------------
  // The file has been kept current throughout the loop; this is the final flush,
  // and it also covers a batch where no row was ever accepted.
  leadCsv.writeOutputCsv(outputPath, outputRows);

  const { jsonPath, runsDir } = reporting.writeReports({ reportDir, batchId, records });

  const submitted = records.filter((r) => r.submission && r.submission.success).length;
  const certs = records.filter((r) => r.trustedForm && r.trustedForm.certificateUrl).length;

  console.log('===== BATCH SUMMARY =====');
  console.log('records processed:        ' + records.length);
  console.log('successful submissions:   ' + submitted + '/' + records.length);
  console.log('TrustedForm certificates: ' + certs + '/' + records.length);
  console.log('rows rejected at input:   ' + errors.length);
  console.log('rows in the final CSV:    ' + outputRows.length);
  if (omitted.length) {
    console.log('');
    console.log('OMITTED FROM THE FINAL CSV (' + omitted.length + ') - the funnel did not accept these:');
    for (const o of omitted) {
      console.log('  line ' + o.line + '  ' + o.name + ': ' + o.reason);
      if (o.certificateStillIssued) {
        console.log('    (a certificate was issued on page load, but no lead was submitted,'
          + ' so the row is not in the CSV. See the forensic record.)');
      }
    }
  }
  console.log('');
  console.log('FINAL CSV:        ' + outputPath);
  console.log('Batch JSON:       ' + jsonPath);
  console.log('Per-run JSON:     ' + runsDir);
  console.log('TrustedForm caps: ' + path.join(reportDir, 'captures'));
  console.log('');
  console.log('Browser contexts still open: ' + behavioral.liveBrowsers.size);
  if (os.platform() === 'linux') {
    console.log('(check for orphans with: pgrep -fa "' + path.basename(core.resolveBrowserPath()) + '")');
  }

  writeProgress(progressPath, {
    batchId,
    phase: 'done',
    total: records.length,
    completed: records.length,
    submitted,
    certificates: certs,
    rejectedAtInput: errors.length,
    concurrency,
    omitted,
    outputCsv: outputPath,
    batchJson: jsonPath,
    rows: records.map((r) => ({
      name: r.sourceRow ? r.sourceRow.firstName + ' ' + r.sourceRow.lastName : '?',
      zip: r.sourceRow ? r.sourceRow.zip : null,
      cohort: r.cohort,
      success: !!(r.submission && r.submission.success),
      certificateId: (r.trustedForm && r.trustedForm.certificateId) || null,
      certificateUrl: (r.trustedForm && r.trustedForm.certificateUrl) || null,
      ip: (r.proxy && r.proxy.ip) || null,
      durationSec: r.actualDurationSec === undefined ? null : r.actualDurationSec,
      error: r.error || null,
    })),
  });

  if (submitted !== records.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exitCode = 1;
});
