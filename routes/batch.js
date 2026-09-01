'use strict';

//
// Batch CSV test harness API for the dashboard.
//
// Upload -> preview -> confirm -> run -> download.
//
// Every route is behind the dashboard's existing JWT auth. Starting a batch
// submits real leads to the live funnel and produces real TrustedForm
// certificates, so:
//
//   * uploading only previews; nothing is submitted until an explicit confirm
//   * the preview shows exactly which rows are not recognized as test data, and
//     submitting those requires a separate explicit acknowledgement
//   * only one batch runs at a time, because each row drives a real browser
//   * the client never supplies a path or a CLI flag; all of that is fixed here
//

const { spawn } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { authenticateToken } = require('../middleware/auth');
const leadCsv = require('../scripts/lib/leadCsv');
const qualification = require('../scripts/lib/qualification');

const router = express.Router();

const RUNNER = path.join(__dirname, '..', 'scripts', 'batchCsvRunner.js');
const REPORT_DIR = path.resolve(process.env.BEHAVIOR_REPORT_DIR
  || path.join(__dirname, '..', 'test-reports'));
const UPLOAD_DIR = path.join(REPORT_DIR, 'uploads');
const MAX_CSV_BYTES = Number(process.env.BATCH_MAX_CSV_BYTES || 2 * 1024 * 1024);

// One batch at a time: every row launches a browser through a residential
// proxy, and overlapping batches would fight for CPU and for proxy sessions.
let activeBatchId = null;

// A CSV body can be larger than a typical JSON payload but must still be bounded.
const jsonBody = express.json({ limit: '4mb' });

const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

/** Resolve a batch's directory, refusing anything that is not a plain id. */
function batchDir(batchId) {
  if (!BATCH_ID.test(String(batchId || ''))) return null;
  const dir = path.join(UPLOAD_DIR, batchId);
  // Defence in depth: the regex already forbids separators.
  if (!path.resolve(dir).startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null;
  return dir;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function newBatchId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
    + '-' + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// POST /api/batch/preview - upload and inspect. Submits nothing.
// ---------------------------------------------------------------------------

router.post('/preview', authenticateToken, jsonBody, (req, res) => {
  const content = req.body && req.body.content;
  const filename = String((req.body && req.body.filename) || 'upload.csv');

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ message: 'Send the CSV text as { filename, content }.' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CSV_BYTES) {
    return res.status(413).json({ message: 'CSV is larger than ' + MAX_CSV_BYTES + ' bytes.' });
  }

  const batchId = newBatchId();
  const dir = batchDir(batchId);
  fs.mkdirSync(dir, { recursive: true });
  const inputPath = path.join(dir, 'input.csv');
  fs.writeFileSync(inputPath, content);

  let loaded;
  try {
    loaded = leadCsv.loadLeadCsv(inputPath);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    return res.status(400).json({ message: error.message });
  }

  // Preview the generated variables with the same seed the run will use, so
  // what is shown is what gets submitted.
  const seed = (Math.random() * 1e9) | 0;
  const rng = qualification.mulberry32(seed);
  const preview = loaded.rows.map((row, i) => {
    const quals = qualification.generateQualification(row.gender, rng);
    return {
      lineNumber: row.lineNumber,
      firstName: row.firstName,
      lastName: row.lastName,
      gender: row.gender,
      city: row.city,
      state: row.state,
      zip: row.zip,
      phone: row.phone,
      email: row.email,
      dob: row.dob,
      cohort: ['short', 'medium', 'long'][i % 3],
      recognizedAsTestRecord: row.testRecord.isTest,
      testRecordReasons: row.testRecord.reasons,
      generated: {
        currentlyInsured: quals.currentlyInsured,
        married: quals.married,
        homeowner: quals.homeowner,
        tobacco: quals.tobacco,
        creditScore: quals.creditScore,
        height: quals.heightLabel + ' (' + quals.heightInches + ' in)',
        weight: quals.weightLbs + ' lbs',
        military: quals.military,
        cancer: quals.cancer,
        heartDisease: quals.heartDisease,
        coverageAmount: quals.coverageAmount,
      },
    };
  });

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    batchId, filename, seed, uploadedAt: new Date().toISOString(),
    uploadedBy: (req.user && (req.user.email || req.user.username)) || null,
    usable: loaded.rows.length, rejected: loaded.errors.length,
  }, null, 2));

  res.json({
    batchId,
    filename,
    seed,
    usable: loaded.rows.length,
    rejected: loaded.errors,
    nonTestRecords: preview.filter((r) => !r.recognizedAsTestRecord).length,
    distributions: qualification.describeDistributions(),
    rows: preview,
  });
});

// ---------------------------------------------------------------------------
// POST /api/batch/:batchId/start - explicit confirmation. This submits.
// ---------------------------------------------------------------------------

router.post('/:batchId/start', authenticateToken, jsonBody, (req, res) => {
  const { batchId } = req.params;
  const dir = batchDir(batchId);
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ message: 'Unknown batch.' });

  if (activeBatchId) {
    return res.status(409).json({
      message: 'A batch is already running (' + activeBatchId + '). Each row drives a real '
        + 'browser through the proxy, so batches run one at a time.',
      activeBatchId,
    });
  }

  const meta = readJson(path.join(dir, 'meta.json'), {});
  const inputPath = path.join(dir, 'input.csv');
  const progressPath = path.join(dir, 'progress.json');
  const outputPath = path.join(dir, 'leads.csv');
  const logPath = path.join(dir, 'run.log');

  const body = req.body || {};
  const allowNonTest = body.allowNonTestRecords === true;
  const cohort = ['short', 'medium', 'long', 'mixed'].includes(body.cohort) ? body.cohort : 'mixed';

  // Re-check the gate here rather than trusting the client: the preview is
  // advisory, this is the decision point.
  const loaded = leadCsv.loadLeadCsv(inputPath);
  const nonTest = loaded.rows.filter((r) => !r.testRecord.isTest);
  if (nonTest.length && !allowNonTest) {
    return res.status(400).json({
      message: nonTest.length + ' row(s) are not recognized as test records. Each submission '
        + 'produces a TrustedForm certificate, which is consent evidence about the person it '
        + 'names, so this must be acknowledged explicitly.',
      nonTestRecords: nonTest.map((r) => ({
        lineNumber: r.lineNumber, name: r.firstName + ' ' + r.lastName, email: r.email,
      })),
    });
  }

  const args = [
    RUNNER, '--test-mode',
    '--input', inputPath,
    '--report-dir', REPORT_DIR,
    '--output', outputPath,
    '--progress-file', progressPath,
    '--batch-id', batchId,
    '--cohort', cohort,
  ];
  if (meta.seed !== undefined && meta.seed !== null) args.push('--seed', String(meta.seed));
  if (Number.isInteger(body.limit) && body.limit > 0) args.push('--limit', String(body.limit));
  if (allowNonTest) args.push('--allow-non-test-records');

  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', log, log],
  });

  activeBatchId = batchId;
  fs.writeFileSync(progressPath, JSON.stringify({
    batchId, phase: 'starting', total: loaded.rows.length, completed: 0,
    submitted: 0, certificates: 0, rows: [],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'started.json'), JSON.stringify({
    startedAt: new Date().toISOString(),
    startedBy: (req.user && (req.user.email || req.user.username)) || null,
    pid: child.pid, cohort, allowNonTestRecords: allowNonTest,
  }, null, 2));

  child.on('exit', (code) => {
    if (activeBatchId === batchId) activeBatchId = null;
    try { fs.closeSync(log); } catch { /* already closed */ }
    const progress = readJson(progressPath, {});
    if (progress.phase !== 'done') {
      // The runner died before writing its own terminal state; record that
      // rather than leaving the UI polling a batch that will never finish.
      fs.writeFileSync(progressPath, JSON.stringify({
        ...progress, phase: 'failed', exitCode: code,
        message: 'The batch process exited before completing. See run.log.',
      }, null, 2));
    }
  });

  res.status(202).json({ batchId, started: true, pid: child.pid, cohort });
});

// ---------------------------------------------------------------------------
// GET /api/batch/:batchId/status
// ---------------------------------------------------------------------------

router.get('/:batchId/status', authenticateToken, (req, res) => {
  const dir = batchDir(req.params.batchId);
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ message: 'Unknown batch.' });
  const progress = readJson(path.join(dir, 'progress.json'));
  if (!progress) return res.json({ batchId: req.params.batchId, phase: 'uploaded' });
  res.json({
    ...progress,
    isActive: activeBatchId === req.params.batchId,
    downloadReady: fs.existsSync(path.join(dir, 'leads.csv')),
  });
});

// ---------------------------------------------------------------------------
// GET /api/batch/:batchId/download - the final CSV
// ---------------------------------------------------------------------------

router.get('/:batchId/download', authenticateToken, (req, res) => {
  const dir = batchDir(req.params.batchId);
  if (!dir) return res.status(400).json({ message: 'Bad batch id.' });
  const csv = path.join(dir, 'leads.csv');
  if (!fs.existsSync(csv)) return res.status(404).json({ message: 'No output yet for this batch.' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads-' + req.params.batchId + '.csv"');
  fs.createReadStream(csv).pipe(res);
});

// ---------------------------------------------------------------------------
// GET /api/batch/:batchId/log - the run log, for diagnosing a failure
// ---------------------------------------------------------------------------

router.get('/:batchId/log', authenticateToken, (req, res) => {
  const dir = batchDir(req.params.batchId);
  if (!dir) return res.status(400).json({ message: 'Bad batch id.' });
  const log = path.join(dir, 'run.log');
  if (!fs.existsSync(log)) return res.status(404).json({ message: 'No log for this batch.' });
  res.type('text/plain').send(fs.readFileSync(log, 'utf8').slice(-200000));
});

// ---------------------------------------------------------------------------
// GET /api/batch - recent batches
// ---------------------------------------------------------------------------

router.get('/', authenticateToken, (req, res) => {
  if (!fs.existsSync(UPLOAD_DIR)) return res.json({ activeBatchId, batches: [] });
  const batches = fs.readdirSync(UPLOAD_DIR)
    .filter((id) => BATCH_ID.test(id))
    .map((id) => {
      const dir = path.join(UPLOAD_DIR, id);
      const meta = readJson(path.join(dir, 'meta.json'), {});
      const progress = readJson(path.join(dir, 'progress.json'), {});
      return {
        batchId: id,
        filename: meta.filename || null,
        uploadedAt: meta.uploadedAt || null,
        uploadedBy: meta.uploadedBy || null,
        usable: meta.usable ?? null,
        phase: progress.phase || 'uploaded',
        completed: progress.completed ?? 0,
        total: progress.total ?? meta.usable ?? 0,
        submitted: progress.submitted ?? 0,
        downloadReady: fs.existsSync(path.join(dir, 'leads.csv')),
      };
    })
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))
    .slice(0, 50);
  res.json({ activeBatchId, batches });
});

module.exports = router;
