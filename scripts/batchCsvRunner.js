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
const qualification = require('./lib/qualification');
const reporting = require('./lib/reporting');

// Loaded lazily, inside the submitting path only. Requiring it pulls in
// playwright-core, and --help and --dry-run have no business needing a browser
// library installed to tell you what they would do.
let runner = null;
const loadRunner = () => (runner || (runner = require('./behavioralTestRunner')));

const { arg, hasFlag, required } = core;

const BETWEEN_RUNS_MS = Number(process.env.BEHAVIOR_BETWEEN_RUNS_MS || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

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
    submitted: 0, certificates: 0, rejectedAtInput: errors.length, rows: [],
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

  // ---- run every record sequentially ---------------------------------------
  const records = [];
  const outputRows = [];
  const omitted = [];

  for (let i = 0; i < prepared.length; i += 1) {
    const { row, quals, cohort, answers } = prepared[i];
    const [lo, hi] = behavioral.COHORT_RANGES[cohort];
    const targetDurationSec = Math.round((lo + rng() * (hi - lo)) * 10) / 10;
    const runId = batchId + '-row' + String(row.lineNumber).padStart(3, '0') + '-' + cohort;

    console.log('[' + (i + 1) + '/' + prepared.length + '] ' + runId
      + '  ' + row.firstName + ' ' + row.lastName + '  ' + row.zip
      + '  ' + cohort + ' target ' + targetDurationSec + 's');

    // ZIP drives the residential proxy location, exactly as the proven runner does.
    let location;
    try {
      location = core.getZipTarget(row.zip);
    } catch (error) {
      console.log('    SKIPPED: ' + error.message);
      records.push({ runId, error: error.message, sourceRow: row, qualification: quals });
      continue;
    }

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

    let record;
    try {
      record = await behavioral.runOnce({
        runId, cohort, index: i + 1, lead, location, credentials, targetDurationSec,
        reportDir, batchId, offline, telemetryKeys, entryMode, answers, targetWpm,
      });
    } catch (error) {
      console.log('    ERROR: ' + error.message);
      record = { runId, cohort, error: error.message, submission: { success: false }, trustedForm: {}, proxy: {} };
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
    records.push(record);

    const cert = record.trustedForm && record.trustedForm.certificateUrl;
    const observedIp = record.proxy && record.proxy.ip;
    console.log('    ip ' + (observedIp || 'none')
      + '  cert ' + (record.trustedForm && record.trustedForm.certificateId || 'none')
      + '  actual ' + (record.actualDurationSec === undefined ? '?' : record.actualDurationSec) + 's'
      + '  weight ' + (record.weightSubmitted === undefined ? 'not set' : record.weightSubmitted)
      + '  success ' + !!(record.submission && record.submission.success));

    // Only a submission the funnel actually accepted belongs in the business
    // CSV. TrustedForm issues a certificate on page load, so a rejected row
    // still has one; writing it here would make a lead that does not exist
    // indistinguishable from one that does. Rejected rows stay in the forensic
    // record, which says exactly what happened.
    if (!(record.submission && record.submission.success)) {
      omitted.push({
        line: row.lineNumber,
        name: row.firstName + ' ' + row.lastName,
        reason: (record.error || (record.submission && record.submission.response) || 'submission not accepted')
          .toString().slice(0, 120),
        certificateStillIssued: !!cert,
      });
      console.log('');
      if (i < prepared.length - 1 && BETWEEN_RUNS_MS > 0) await sleep(BETWEEN_RUNS_MS);
      continue;
    }

    outputRows.push({
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
    });

    writeProgress(progressPath, {
      batchId,
      phase: 'running',
      total: prepared.length,
      completed: i + 1,
      submitted: outputRows.length,
      certificates: records.filter((r) => r.trustedForm && r.trustedForm.certificateUrl).length,
      rejectedAtInput: errors.length,
      current: row.firstName + ' ' + row.lastName,
      rows: records.map((r) => ({
        name: r.sourceRow ? r.sourceRow.firstName + ' ' + r.sourceRow.lastName : '?',
        zip: r.sourceRow ? r.sourceRow.zip : null,
        cohort: r.cohort,
        success: !!(r.submission && r.submission.success),
        certificateId: (r.trustedForm && r.trustedForm.certificateId) || null,
        ip: (r.proxy && r.proxy.ip) || null,
        durationSec: r.actualDurationSec === undefined ? null : r.actualDurationSec,
        error: r.error || null,
      })),
    });

    console.log('');
    if (i < prepared.length - 1 && BETWEEN_RUNS_MS > 0) await sleep(BETWEEN_RUNS_MS);
  }

  // ---- outputs -------------------------------------------------------------
  const outputPath = path.resolve(arg('output', path.join(reportDir, 'leads-' + batchId + '.csv')));
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
