'use strict';
//
// End-to-end exercise of the behavioral harness against a loopback mock funnel.
//
// This verifies the machinery -- step walking, randomized field order, real key
// events, pauses, scrolling, the merged event timeline, per-run TrustedForm
// capture files, signal extraction, JSON/CSV reports and clean browser shutdown
// -- with no proxy, no production traffic and no real TrustedForm. It does NOT
// verify anything about real TrustedForm behavior; only a proxied run against
// the live funnel can do that.
//
//   npm run test:offline

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');

const mock = require('./mock-funnel/server');

const HARNESS = path.join(__dirname, '..', 'scripts', 'behavioralTestRunner.js');

function chromiumPath() {
  const configured = process.env.CHROME_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  // Playwright's own download root, if this machine has one.
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(pwRoot)) {
    for (const entry of fs.readdirSync(pwRoot)) {
      candidates.push(path.join(pwRoot, entry, 'chrome-linux', 'chrome'));
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HARNESS, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function countChromium(executablePath) {
  if (os.platform() !== 'linux') return null;
  try {
    const out = execFileSync('pgrep', ['-fc', executablePath], { encoding: 'utf8' });
    return Number(out.trim());
  } catch {
    return 0; // pgrep exits non-zero when nothing matches
  }
}

const LEAD = [
  '--zip', '07302',
  '--dob', '07/09/1982',
  '--address', '88 Morgan St',
  '--fname', 'Dana',
  '--lname', 'TestLead',
  '--email', 'dana.testlead@example.com',
  '--phone', '5513326220',
];

async function main() {
  const executablePath = chromiumPath();
  if (!executablePath) {
    console.error('No Chromium found. Set CHROME_EXECUTABLE_PATH.');
    process.exitCode = 1;
    return;
  }

  const { server, url } = await mock.start(0);
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-selftest-'));
  const env = {
    PRODUCTION_FUNNEL_URL: url,
    CHROME_EXECUTABLE_PATH: executablePath,
    HEADLESS: 'true',
    BEHAVIOR_BETWEEN_RUNS_MS: '0',
    BEHAVIOR_REPORT_DIR: reportDir,
  };

  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, error });
    }
  };

  try {
    // 1. The --test-mode gate.
    const gated = await run(['--cohort', 'short', ...LEAD], env);
    check('refuses to run without --test-mode', () => {
      assert.strictEqual(gated.code, 2);
      assert.ok(/requires --test-mode/.test(gated.stderr));
    });

    // 2. --offline-selftest refuses a non-loopback target.
    const nonLoopback = await run(['--test-mode', '--offline-selftest', '--cohort', 'short', ...LEAD], {
      ...env, PRODUCTION_FUNNEL_URL: 'https://quotes.nationallifecoverage.org/',
    });
    check('offline self-test refuses a non-loopback funnel URL', () => {
      assert.notStrictEqual(nonLoopback.code, 0);
      assert.ok(/loopback/.test(nonLoopback.stderr));
    });

    const before = countChromium(executablePath);

    // 3. One run in each cohort, sequentially, through the whole harness.
    const result = await run([
      '--test-mode', '--offline-selftest', '--cohort', 'all', '--count', '1', ...LEAD,
    ], env);
    check('the batch completes with exit code 0', () => {
      assert.strictEqual(result.code, 0, 'harness exited ' + result.code);
    });

    const jsonReport = fs.readdirSync(reportDir).find((f) => f.startsWith('behavioral-') && f.endsWith('.json'));
    const csvReport = fs.readdirSync(reportDir).find((f) => f.startsWith('behavioral-') && f.endsWith('.csv'));
    check('a JSON report and a CSV report were written', () => {
      assert.ok(jsonReport, 'no JSON report in ' + reportDir);
      assert.ok(csvReport, 'no CSV report in ' + reportDir);
    });

    const report = JSON.parse(fs.readFileSync(path.join(reportDir, jsonReport), 'utf8'));
    const runs = report.runs;

    check('one record per cohort, all stamped as an authorized offline test', () => {
      assert.strictEqual(runs.length, 3);
      assert.deepStrictEqual(runs.map((r) => r.cohort), ['short', 'medium', 'long']);
      for (const r of runs) {
        assert.strictEqual(r.automatedTest, true);
        assert.strictEqual(r.offlineSelfTest, true);
        assert.ok(r.test_run_id, 'missing test_run_id');
        assert.strictEqual(r.test_run_id, r.runId);
      }
    });

    check('every run submitted and reached the thank-you page', () => {
      for (const r of runs) {
        assert.strictEqual(r.error, null, r.cohort + ' errored: ' + r.error);
        assert.strictEqual(r.submission.success, true, r.cohort + ' did not succeed');
        assert.ok(/thank-you/.test(r.submission.finalUrl), r.cohort + ' final url ' + r.submission.finalUrl);
      }
    });

    check('each run drew its own target duration inside its cohort range', () => {
      for (const r of runs) {
        const [lo, hi] = r.durationRangeSec;
        assert.ok(r.targetDurationSec >= lo && r.targetDurationSec <= hi,
          r.cohort + ' target ' + r.targetDurationSec + ' outside ' + lo + '-' + hi);
      }
      const targets = runs.map((r) => r.targetDurationSec);
      assert.strictEqual(new Set(targets).size, targets.length, 'targets were not independently drawn');
    });

    check('cohorts with reachable targets run monotonically longer', () => {
      // A cohort whose upper bound is below the funnel's own floor cannot run
      // shorter than that floor, so only reachable targets are ordered.
      const reachable = runs.filter((r) => !r.targetUnreachable);
      for (let i = 1; i < reachable.length; i += 1) {
        assert.ok(reachable[i].actualDurationSec > reachable[i - 1].actualDurationSec,
          reachable[i - 1].cohort + ' ' + reachable[i - 1].actualDurationSec
          + ' !< ' + reachable[i].cohort + ' ' + reachable[i].actualDurationSec);
      }
      assert.ok(reachable.length >= 2, 'expected at least two reachable cohorts');
    });

    check('actual duration is measured, not assumed', () => {
      for (const r of runs) {
        assert.strictEqual(typeof r.actualDurationSec, 'number');
        assert.ok(r.actualDurationSec > 0);
        assert.notStrictEqual(r.actualDurationSec, r.targetDurationSec);
      }
    });

    check('real key events were produced for every typed field', () => {
      for (const r of runs) {
        assert.ok(r.interactionSummary.keystrokeCount > 0, r.cohort + ' recorded no keystrokes');
        assert.ok(r.interactionSummary.focusCount > 0, r.cohort + ' recorded no focus events');
        assert.ok(r.interactionSummary.blurCount > 0, r.cohort + ' recorded no blur events');
        assert.ok(r.interactionSummary.inputCount > 0, r.cohort + ' recorded no input events');
        assert.ok(r.interactionSummary.pauseCount > 0, r.cohort + ' recorded no pauses');
      }
    });

    check('keystroke telemetry is redacted by default', () => {
      const keys = runs.flatMap((r) => r.events.filter((e) => e.eventType === 'keydown').map((e) => e.key));
      assert.ok(keys.length > 0);
      const leaked = keys.filter((k) => k && k.length === 1);
      assert.strictEqual(leaked.length, 0, 'literal characters leaked into telemetry: ' + leaked.slice(0, 5));
      assert.ok(keys.some((k) => k === '<alpha>' || k === '<digit>' || k === '<punct>'));
    });

    check('no field value appears anywhere in a report', () => {
      const serialized = JSON.stringify(report);
      for (const secret of ['dana.testlead@example.com', '5513326220', '88 Morgan St', 'TestLead']) {
        assert.ok(!serialized.includes(secret), 'report leaked ' + secret);
      }
    });

    check('every event carries a timestamp, elapsedMs and eventType', () => {
      for (const r of runs) {
        assert.ok(r.events.length > 20, r.cohort + ' only had ' + r.events.length + ' events');
        for (const e of r.events) {
          assert.ok(typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp)));
          assert.strictEqual(typeof e.elapsedMs, 'number');
          assert.ok(typeof e.eventType === 'string' && e.eventType.length > 0);
        }
      }
    });

    check('the timeline is chronological and covers the whole session', () => {
      for (const r of runs) {
        for (let i = 1; i < r.events.length; i += 1) {
          assert.ok(r.events[i].elapsedMs >= r.events[i - 1].elapsedMs, 'timeline out of order');
        }
        const types = new Set(r.events.map((e) => e.eventType));
        for (const required of ['page-load', 'first-interaction', 'focus', 'blur', 'input', 'keydown',
          'pause', 'field-complete', 'final-review', 'submit', 'response', 'context-close']) {
          assert.ok(types.has(required), r.cohort + ' timeline is missing "' + required + '"');
        }
      }
    });

    check('scrolling happened and was bounded', () => {
      const scrolls = runs.flatMap((r) => r.events.filter((e) => e.eventType === 'scroll-action'));
      assert.ok(scrolls.length > 0, 'no scrolling was recorded across three runs');
      for (const s of scrolls) {
        assert.ok(s.amount > 0 && s.amount <= 700, 'unbounded scroll: ' + s.amount);
        assert.ok(['up', 'down'].includes(s.direction));
      }
    });

    check('field order varies and every run records the order it used', () => {
      for (const r of runs) {
        assert.ok(Array.isArray(r.fieldOrder) && r.fieldOrder.length >= 9,
          r.cohort + ' fieldOrder: ' + JSON.stringify(r.fieldOrder));
        assert.ok(r.interactionModel.fieldOrderProfile, 'no field-order profile recorded');
      }
    });

    check('each run has its own TrustedForm capture file, none overwritten', () => {
      const files = new Set();
      for (const r of runs) {
        assert.ok(r.trustedForm.captureFile, r.cohort + ' has no capture file');
        assert.ok(fs.existsSync(r.trustedForm.captureFile), 'missing ' + r.trustedForm.captureFile);
        assert.ok(!files.has(r.trustedForm.captureFile), 'capture file reused: ' + r.trustedForm.captureFile);
        files.add(r.trustedForm.captureFile);
        assert.ok(r.trustedForm.captureEventCount > 0, r.cohort + ' captured no TrustedForm traffic');
      }
      assert.strictEqual(fs.readdirSync(path.join(reportDir, 'captures')).length, 3);
    });

    check('each run is associated with exactly one distinct certificate', () => {
      const ids = runs.map((r) => r.trustedForm.certificateId);
      for (const id of ids) assert.ok(id && /^[0-9a-f]{40}$/.test(id), 'bad certificate id ' + id);
      assert.strictEqual(new Set(ids).size, 3, 'certificates were not distinct: ' + ids);
    });

    check('signals come out of the capture, with null for anything absent', () => {
      for (const r of runs) {
        assert.ok(Object.prototype.hasOwnProperty.call(r.trustedForm.signals, 'wpm'));
        assert.ok(Object.prototype.hasOwnProperty.call(r.trustedForm.signals, 'kpm'));
        assert.ok(r.trustedForm.observedSignalKeys.length > 0, 'no signal keys observed');
        assert.notStrictEqual(r.trustedForm.signals.kpm, null, 'the mock reported kpm; it should be extracted');
      }
    });

    check('typing produces a non-zero keystroke rate at the page level', () => {
      // The mock TrustedForm script counts the same keydown events a real
      // listener would. Zero here would mean no key events reached the page --
      // which is exactly what locator.fill() produces, and what this harness
      // exists to measure against.
      for (const r of runs) {
        assert.ok(Number(r.trustedForm.signals.kpm) > 0,
          r.cohort + ' page-side kpm was ' + r.trustedForm.signals.kpm);
        assert.ok(Number(r.trustedForm.signals.wpm) > 0,
          r.cohort + ' page-side wpm was ' + r.trustedForm.signals.wpm);
      }
    });

    check('the signal series keeps the pre-interaction zeros visible', () => {
      for (const r of runs) {
        const series = r.trustedForm.signalSeries.kpm;
        assert.ok(Array.isArray(series) && series.length >= 2, r.cohort + ' has no kpm series');
        assert.strictEqual(series[0], 0, 'the first ping precedes any typing and must read 0');
        assert.strictEqual(series[series.length - 1], r.trustedForm.signals.kpm,
          'the reported signal must be the last observed value');
        assert.strictEqual(r.trustedForm.signalPolicy, 'last-observed');
      }
    });

    check('the funnel floor is measured and separated from deliberate pausing', () => {
      for (const r of runs) {
        assert.strictEqual(typeof r.pausedSec, 'number');
        assert.strictEqual(typeof r.unpausedSec, 'number');
        assert.ok(r.unpausedSec > 0, r.cohort + ' reported a zero funnel floor');
        assert.ok(Math.abs((r.pausedSec + r.unpausedSec) - r.actualDurationSec) < 0.5,
          r.cohort + ': ' + r.pausedSec + ' + ' + r.unpausedSec + ' != ' + r.actualDurationSec);
        assert.ok(r.minimumSessionSec >= r.unpausedSec, 'minimum session must include the funnel floor');
        assert.strictEqual(r.targetUnreachable, r.minimumSessionSec > r.targetDurationSec);
      }
    });

    check('the browser user agent is reported as-is, not spoofed', () => {
      for (const r of runs) {
        assert.ok(r.browser.userAgent, 'no user agent recorded');
        assert.strictEqual(r.browser.headless, true);
        assert.ok(/HeadlessChrome/.test(r.browser.userAgent),
          'headless run should report HeadlessChrome, got: ' + r.browser.userAgent);
      }
    });

    check('per-run JSON files were written', () => {
      const runFiles = fs.readdirSync(path.join(reportDir, 'runs'));
      assert.strictEqual(runFiles.length, 3);
      for (const r of runs) assert.ok(runFiles.includes(r.runId + '.json'));
    });

    check('the CSV has a header and one row per run, with no events', () => {
      const csv = fs.readFileSync(path.join(reportDir, csvReport), 'utf8');
      const lines = csv.trim().split('\n');
      assert.strictEqual(lines.length, 4);
      assert.ok(lines[0].startsWith('runId,cohort,targetDurationSec,actualDurationSec'));
      assert.ok(lines[0].includes('wpm,kpm'));
      assert.ok(!csv.includes('"eventType"'));
      for (const r of runs) assert.ok(csv.includes(r.runId));
    });

    check('the aggregate summary covers all three cohorts', () => {
      assert.strictEqual(report.summary.length, 3);
      for (const s of report.summary) {
        assert.strictEqual(s.runs, 1);
        assert.strictEqual(s.successfulSubmissions, 1);
        assert.strictEqual(s.trustedFormCertificates, 1);
        assert.ok(typeof s.meanDurationSec === 'number');
        assert.ok(typeof s.medianDurationSec === 'number');
      }
      assert.ok(/SHORT[\s\S]*MEDIUM[\s\S]*LONG/.test(result.stdout));
    });

    // The wpm/kpm question, measured rather than asserted: the same funnel,
    // the same cohort, the only difference being how the value reaches the field.
    const fillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fill-'));
    const fillRun = await run([
      '--test-mode', '--offline-selftest', '--cohort', 'short', '--count', '1',
      '--entry-mode', 'fill', ...LEAD,
    ], { ...env, BEHAVIOR_REPORT_DIR: fillDir });

    check('the fill arm submits successfully too', () => {
      assert.strictEqual(fillRun.code, 0, 'fill arm exited ' + fillRun.code);
    });

    let fillRecord = null;
    check('locator.fill() produces NO key events, and a zero keystroke rate', () => {
      const file = fs.readdirSync(fillDir).find((f) => f.startsWith('behavioral-') && f.endsWith('.json'));
      fillRecord = JSON.parse(fs.readFileSync(path.join(fillDir, file), 'utf8')).runs[0];
      assert.strictEqual(fillRecord.interactionModel.entryMode, 'fill');
      assert.strictEqual(fillRecord.submission.success, true, 'the fill arm must still submit');
      assert.strictEqual(fillRecord.interactionSummary.keystrokeCount, 0,
        'fill() must emit no key events; got ' + fillRecord.interactionSummary.keystrokeCount);
      assert.strictEqual(Number(fillRecord.trustedForm.signals.kpm), 0,
        'a page-side listener counting keydown must report 0 for a filled form; got '
        + fillRecord.trustedForm.signals.kpm);
      assert.strictEqual(Number(fillRecord.trustedForm.signals.wpm), 0);
    });

    check('the fill arm still produces input events with timestamps', () => {
      // This is the other half of the observation: values DO land and ARE
      // observable as timestamped events, even with zero keystrokes.
      assert.ok(fillRecord.interactionSummary.inputCount > 0,
        'fill() should still dispatch input events');
      const inputs = fillRecord.events.filter((e) => e.eventType === 'input');
      assert.ok(inputs.every((e) => typeof e.elapsedMs === 'number' && e.timestamp));
      assert.ok(inputs.some((e) => e.valueLength > 0));
    });

    check('typing is what makes the keystroke rate non-zero', () => {
      const typed = runs.find((r) => r.cohort === 'short');
      assert.strictEqual(typed.interactionModel.entryMode, 'type');
      assert.ok(typed.interactionSummary.keystrokeCount > 0);
      assert.ok(Number(typed.trustedForm.signals.kpm) > 0);
      assert.strictEqual(fillRecord.interactionSummary.keystrokeCount, 0);
      console.log('    measured: entry-mode=type -> keystrokes '
        + typed.interactionSummary.keystrokeCount + ', page-side kpm ' + typed.trustedForm.signals.kpm
        + '  |  entry-mode=fill -> keystrokes ' + fillRecord.interactionSummary.keystrokeCount
        + ', page-side kpm ' + fillRecord.trustedForm.signals.kpm);
    });

    check('no orphaned Chromium processes are left behind', () => {
      const after = countChromium(executablePath);
      assert.ok(after <= before, 'chromium processes before=' + before + ' after=' + after);
      assert.ok(/Browser contexts still open: 0/.test(result.stdout));
    });
  } finally {
    server.close();
  }

  console.log('');
  console.log('===== OFFLINE SELF-TEST =====');
  for (const c of checks) console.log((c.ok ? '  ok   ' : '  FAIL ') + c.name);
  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log(checks.length - failed.length + ' passed, ' + failed.length + ' failed');
  for (const f of failed) console.error('\n' + f.name + '\n' + f.error.stack);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('ERROR: ' + error.stack);
  process.exitCode = 1;
});
