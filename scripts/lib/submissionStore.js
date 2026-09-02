'use strict';
//
// Persists a batch row into the same `submissions` collection the dashboard's
// Submissions page reads.
//
// Why this file exists: uploading a CSV and running it produced a business CSV
// and a forensic record on disk, and nothing else. The only writer of a
// Submission document in the whole application was middleware/formHandler.js,
// which fires when a visitor posts this repository's own index.html to
// /api-proxy/. Batch rows never touch that path - they drive the production
// funnel at PRODUCTION_FUNNEL_URL in a real browser - so every lead the harness
// submitted was invisible on the page an operator actually looks at.
//
// What is stored is what the run observed. The egress IP, the TrustedForm
// certificate, the geolocation and the elapsed time all come off the record the
// runner produced; the qualification answers are the ones actually submitted.
// Nothing is inferred to make a row look better than it was, and a row the
// funnel did not accept is not stored at all - the same rule the business CSV
// follows, so the two never disagree about which leads exist.
//
// Every entry point here is failure-tolerant on purpose. A batch is hours of
// real submissions; losing the run because Mongo was briefly unreachable would
// cost far more than the row it failed to write, so problems are logged and the
// run continues.
//

const mongoose = require('mongoose');
const Submission = require('../../models/Submission');

let connecting = null;
let warnedNoUri = false;

/**
 * Connect on first use, and only once.
 *
 * The runner is spawned detached by routes/batch.js with the server's env, and
 * loads .env itself, so MONGODB_URI is normally present. When it is not, say so
 * once and let the batch run on: the CSV and the forensic record are still
 * written, and the operator gets a named reason instead of silence.
 */
async function connect() {
  if (mongoose.connection.readyState === 1) return true;
  if (!process.env.MONGODB_URI) {
    if (!warnedNoUri) {
      warnedNoUri = true;
      console.warn('MONGODB_URI is not set: batch rows will not appear on the '
        + 'dashboard Submissions page. The CSV and forensic reports are unaffected.');
    }
    return false;
  }
  if (!connecting) {
    connecting = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    }).catch((error) => {
      console.warn('Could not connect to MongoDB, so batch rows will not reach the '
        + 'Submissions page: ' + error.message);
      connecting = null;
      return null;
    });
  }
  return !!(await connecting);
}

async function disconnect() {
  if (mongoose.connection.readyState === 0) return;
  try {
    await mongoose.disconnect();
  } catch (error) {
    console.warn('Ignoring error while closing the MongoDB connection: ' + error.message);
  }
}

// The funnel's credit tiers are labels ("700-640 Good"); the schema stores the
// grade. Take the grade off the end rather than mapping every label, so a new
// tier spelling does not silently become no rating at all.
function creditRating(tier) {
  const grade = String(tier || '').trim().split(/\s+/).pop().toLowerCase();
  return ['excellent', 'good', 'fair', 'poor'].includes(grade) ? grade : undefined;
}

function gender(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'm' || v === 'male') return 'Male';
  if (v === 'f' || v === 'female') return 'Female';
  if (['x', 'non-binary', 'nonbinary', 'non binary'].includes(v)) return 'Non-Binary';
  return 'Other';
}

function yesNo(value) {
  const v = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(v)) return 'Yes';
  if (['n', 'no', 'false', '0'].includes(v)) return 'No';
  return undefined;
}

// Rows carry MM/DD/YYYY, which is what the CSV loader validates.
function parseDob(dob) {
  const parts = String(dob || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!parts) return null;
  const date = new Date(Number(parts[3]), Number(parts[1]) - 1, Number(parts[2]));
  return isNaN(date.getTime()) ? null : date;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ip_address, user_agent and trusted_form_cert_url are required by the schema,
// and a run can legitimately finish without one of them. "unknown" is stored in
// that case rather than a plausible-looking value: it cannot be mistaken for an
// address or a certificate, and it keeps the row - which is a real lead the
// funnel accepted - instead of dropping it over a missing field.
const UNKNOWN = 'unknown';

/**
 * Map a completed batch row onto a Submission document.
 *
 * Pure, and exported for the unit tests: the mapping is the part most likely to
 * drift as the funnel's answers change, and it can be checked without a
 * database, a browser or a proxy.
 */
function toSubmissionData({ batchId, row, quals, record }) {
  const proxy = (record && record.proxy) || {};
  const trustedForm = (record && record.trustedForm) || {};
  const submission = (record && record.submission) || {};
  const browser = (record && record.browser) || {};
  const leadLocation = (record && record.leadLocation) || {};
  const q = quals || {};

  return {
    fname: row.firstName,
    lname: row.lastName,
    email: String(row.email || '').trim().toLowerCase(),
    phone: String(row.phone || '').replace(/\D/g, ''),
    address: row.address,
    city: row.city || leadLocation.city,
    state: String(row.state || leadLocation.state || '').toUpperCase(),
    zip: row.zip,
    gender: gender(row.gender),
    date_of_birth: parseDob(row.dob),

    // The answers the run actually submitted, not a fresh draw.
    currently_insured: yesNo(q.currentlyInsured),
    credit_rating: creditRating(q.creditScore),
    marital: yesNo(q.married),
    homeowner: yesNo(q.homeowner),
    military: yesNo(q.military),
    tobacco_use: yesNo(q.tobacco),
    cancer: yesNo(q.cancer),
    heart_disease: yesNo(q.heartDisease),
    coverage_amount: q.coverageAmount,
    height: number(q.heightInches),
    // What the form ended up with, falling back to what was generated for it.
    weight: number(record && record.weightSubmitted) ?? number(q.weightLbs),

    // Observed, never fabricated.
    ip_address: proxy.ip || UNKNOWN,
    geolocation: {
      country: proxy.country || 'Unknown',
      region: proxy.state || leadLocation.stateName || 'Unknown',
      region_name: proxy.state || leadLocation.stateName || '',
      city: proxy.city || row.city || 'Unknown',
      zip: row.zip || '',
      isp: proxy.isp || '',
    },
    user_agent: browser.userAgent || UNKNOWN,
    trusted_form_cert_url: trustedForm.certificateUrl || UNKNOWN,

    case_type: 'Life Insurance',
    offer_url: submission.finalUrl || process.env.PRODUCTION_FUNNEL_URL || '',
    time_on_page: number(record && record.actualDurationSec),
    submission_date: submission.timestamp ? new Date(submission.timestamp) : new Date(),

    source: 'batch',
    batch_id: batchId,
    batch_row: row.lineNumber,
  };
}

/**
 * Store one accepted batch row.
 *
 * Written as the row settles rather than at the end of the batch, for the same
 * reason the output CSV is: a batch that is killed half way through - by a
 * deploy, an OOM, an operator - keeps everything it had already done.
 *
 * Idempotent through the unique (batch_id, batch_row) index, so re-running the
 * backfill over a batch that already stored its rows is a no-op rather than a
 * duplicate.
 *
 * @returns {Promise<'saved'|'duplicate'|'skipped'|'failed'>}
 */
async function saveBatchRow({ batchId, row, quals, record }) {
  if (!(await connect())) return 'skipped';
  try {
    const data = toSubmissionData({ batchId, row, quals, record });
    if (!data.date_of_birth) {
      console.warn('Row ' + row.lineNumber + ' has an unparseable date of birth ('
        + row.dob + '); it is in the CSV but not on the Submissions page.');
      return 'failed';
    }
    await new Submission(data).save();
    return 'saved';
  } catch (error) {
    if (error && error.code === 11000) return 'duplicate';
    console.warn('Row ' + row.lineNumber + ' was submitted but could not be stored for '
      + 'the Submissions page: ' + error.message);
    return 'failed';
  }
}

module.exports = { connect, disconnect, saveBatchRow, toSubmissionData };
