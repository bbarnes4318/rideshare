#!/usr/bin/env node
'use strict';
//
// Import batches that were already run into the submissions collection.
//
// Until the runner learned to store its rows, a batch produced a CSV and a
// forensic record on disk and nothing on the dashboard's Submissions page. This
// walks what is on disk and puts those leads where they should have been all
// along. It is idempotent - the unique (batch_id, batch_row) index makes a
// second pass a no-op - so it is safe to re-run after another batch finishes.
//
// Two sources per batch, in order of preference:
//
//   1. test-reports/behavioral-<batchId>.json - the forensic record, written
//      when a batch completes. Carries the observed IP, the certificate, the
//      user agent, the qualification answers actually submitted and the
//      per-row line numbers, so the imported document is as complete as one the
//      runner writes today.
//
//   2. test-reports/uploads/<batchId>/leads.csv - the business CSV, kept
//      current while a batch runs. This is the only source for a batch that was
//      interrupted (a deploy, an OOM, an operator), and it is thinner: it has
//      the lead, the observed IP and the certificate, but no qualification
//      answers and no user agent. Line numbers are recovered by joining back to
//      that batch's input.csv on email, so a later pass over the same batch
//      from source 1 updates nothing and duplicates nothing.
//
// Nothing is invented to fill a gap. A field the run did not observe is stored
// as "unknown", exactly as the runner stores it.
//
// Usage:
//   node scripts/backfillBatchSubmissions.js [--batch <id>] [--dry-run]
//
//   --batch <id>   Import only this batch (default: every batch found)
//   --dry-run      Report what would be imported; write nothing
//

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const leadCsv = require('./lib/leadCsv');
const store = require('./lib/submissionStore');

const REPORT_DIR = path.resolve(process.env.BEHAVIOR_REPORT_DIR
  || path.join(__dirname, '..', 'test-reports'));
const UPLOAD_DIR = path.join(REPORT_DIR, 'uploads');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const onlyBatch = arg('batch', null);
const dryRun = process.argv.includes('--dry-run');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Rows from a completed batch's forensic record. */
function fromForensicJson(batchId) {
  const file = path.join(REPORT_DIR, 'behavioral-' + batchId + '.json');
  if (!fs.existsSync(file)) return null;
  const doc = readJson(file);
  if (!doc || !Array.isArray(doc.runs)) return null;

  const rows = [];
  for (const record of doc.runs) {
    // Same rule as the runner and the business CSV: a row the funnel did not
    // accept is not a lead, so it is not imported.
    if (!(record.submission && record.submission.success)) continue;
    if (!record.sourceRow) continue;
    rows.push({ row: record.sourceRow, quals: record.qualification, record });
  }
  return { source: path.basename(file), rows };
}

/**
 * Rows from a batch's business CSV, for a batch with no forensic record.
 *
 * The CSV holds only accepted rows by construction, so there is no acceptance
 * check to make here. Line numbers come from the batch's own input.csv: they
 * are what makes the import idempotent against a later forensic pass, and
 * without them the same lead would import twice under two different keys.
 */
function fromLeadsCsv(batchId) {
  const dir = path.join(UPLOAD_DIR, batchId);
  const csvPath = path.join(dir, 'leads.csv');
  const inputPath = path.join(dir, 'input.csv');
  if (!fs.existsSync(csvPath)) return null;

  const lineByEmail = new Map();
  if (fs.existsSync(inputPath)) {
    try {
      for (const r of leadCsv.loadLeadCsv(inputPath).rows) {
        lineByEmail.set(String(r.email || '').toLowerCase(), r.lineNumber);
      }
    } catch (error) {
      console.warn('  could not re-read ' + inputPath + ' for line numbers: ' + error.message);
    }
  }

  const table = leadCsv.parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (!table.length) return { source: 'leads.csv', rows: [] };
  const header = table[0].map((h) => String(h || '').trim());
  const at = (name) => header.indexOf(name);

  const rows = [];
  for (const cells of table.slice(1)) {
    if (!cells.length || cells.every((c) => !String(c || '').trim())) continue;
    const cell = (name) => {
      const i = at(name);
      return i === -1 ? '' : String(cells[i] || '').trim();
    };
    const email = cell('email').toLowerCase();
    const lineNumber = lineByEmail.get(email);
    if (lineNumber === undefined) {
      console.warn('  ' + (email || '(no email)') + ' is in leads.csv but not in input.csv; '
        + 'skipped, because without its line number the import cannot stay idempotent.');
      continue;
    }
    rows.push({
      row: {
        lineNumber,
        firstName: cell('firstName'),
        lastName: cell('lastName'),
        gender: cell('gender'),
        address: cell('address'),
        city: cell('city'),
        state: cell('state'),
        zip: cell('zipCode'),
        phone: cell('phone'),
        email: cell('email'),
        dob: cell('birthdate'),
      },
      // The CSV never carried the qualification answers; they stay unset rather
      // than being re-drawn, which would record answers no run ever submitted.
      quals: null,
      record: {
        proxy: { ip: cell('ipAddress') || null },
        trustedForm: { certificateUrl: cell('trustedFormURL') || null },
        submission: { success: true, timestamp: cell('datePosted') || null },
      },
    });
  }
  return { source: 'leads.csv', rows };
}

/** Every batch id on disk, from either source. */
function findBatchIds() {
  const ids = new Set();
  if (fs.existsSync(UPLOAD_DIR)) {
    for (const entry of fs.readdirSync(UPLOAD_DIR)) {
      if (fs.existsSync(path.join(UPLOAD_DIR, entry, 'leads.csv'))) ids.add(entry);
    }
  }
  if (fs.existsSync(REPORT_DIR)) {
    for (const entry of fs.readdirSync(REPORT_DIR)) {
      const m = entry.match(/^behavioral-(.+)\.json$/);
      if (m) ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

async function main() {
  const ids = onlyBatch ? [onlyBatch] : findBatchIds();
  if (!ids.length) {
    console.log('No batches found under ' + REPORT_DIR + '.');
    return;
  }

  if (!dryRun && !(await store.connect())) {
    throw new Error('No database connection, so nothing can be imported. '
      + 'Set MONGODB_URI (the app reads it from .env) and re-run.');
  }

  const totals = { saved: 0, duplicate: 0, skipped: 0, failed: 0, wouldImport: 0 };

  for (const batchId of ids) {
    const found = fromForensicJson(batchId) || fromLeadsCsv(batchId);
    if (!found) {
      console.log(batchId + ': nothing on disk to import.');
      continue;
    }
    console.log(batchId + ': ' + found.rows.length + ' accepted row(s) from ' + found.source);

    for (const { row, quals, record } of found.rows) {
      if (dryRun) {
        totals.wouldImport += 1;
        console.log('  would import line ' + row.lineNumber + '  '
          + row.firstName + ' ' + row.lastName + '  <' + row.email + '>');
        continue;
      }
      const outcome = await store.saveBatchRow({ batchId, row, quals, record });
      totals[outcome] += 1;
    }
  }

  console.log('');
  if (dryRun) {
    console.log('--dry-run: ' + totals.wouldImport + ' row(s) would be imported; nothing was written.');
  } else {
    console.log('imported:   ' + totals.saved);
    console.log('already in: ' + totals.duplicate);
    if (totals.failed) console.log('failed:     ' + totals.failed);
    if (totals.skipped) console.log('skipped:    ' + totals.skipped);
  }
}

main()
  .catch((error) => {
    console.error('ERROR: ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => store.disconnect());
