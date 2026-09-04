'use strict';
//
// Dumps the entire `submissions` collection to one CSV file.
//
// Why this exists alongside /api/analytics/export/csv: that endpoint is for an
// operator clicking Export in the dashboard, and it hand-picks about thirty
// columns. It drops `source` and `batch_id`, so a synthetic harness lead and a
// lead a real visitor left come out indistinguishable, and it also drops the
// UTM fields, the user agent, the OS, the geolocation city and coordinates, and
// the created/updated timestamps. This script is the "give me everything"
// counterpart: every field on every document, nothing hand-picked, so the file
// can be handed to someone who needs the whole record rather than a summary.
//
// Columns are ordered by the schema so the CSV opens readably (name, contact,
// address, qualification answers, then technical data). Any key found on a
// document that the schema does not declare - a field added and later removed,
// or a record written before the schema caught up - is appended at the end
// rather than dropped, because silently losing a column is exactly the failure
// this script exists to avoid.
//
// Usage:
//   node scripts/exportSubmissionsCsv.js [--out <path>] [--source form|batch]
//

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const Submission = require('../models/Submission');

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf('--' + name);
  return i === -1 ? undefined : args[i + 1];
}

const onlySource = flag('source');
if (onlySource && !['form', 'batch'].includes(onlySource)) {
  console.error('--source must be "form" or "batch".');
  process.exit(1);
}

const outPath = path.resolve(
  flag('out')
    || path.join(__dirname, '..', 'exports',
      'submissions-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.csv'),
);

// Mongoose's own bookkeeping. Every other key on a document is real data and is
// exported, including ones this list's author never saw.
const INTERNAL_KEYS = new Set(['__v']);

// The order a person wants to read these in, which is neither insertion order
// nor alphabetical. Anything not named here still gets exported; it just lands
// after these.
const PREFERRED_ORDER = [
  '_id', 'source', 'batch_id', 'batch_row',
  'submission_date', 'createdAt', 'updatedAt',
  'fname', 'lname', 'email', 'phone',
  'address', 'city', 'state', 'zip',
  'gender', 'date_of_birth',
  'currently_insured', 'coverage_amount', 'credit_rating', 'marital',
  'homeowner', 'military', 'tobacco_use', 'cancer', 'heart_disease',
  'height', 'weight',
  'status', 'processed', 'quality_score',
  'case_type', 'ownerid', 'campaign', 'offer_url',
  'trusted_form_cert_url',
  'referrer', 'utm_source', 'utm_medium', 'utm_campaign',
  'page_views', 'time_on_page',
  'ip_address', 'user_agent',
  'geolocation.country', 'geolocation.country_code', 'geolocation.region',
  'geolocation.region_name', 'geolocation.city', 'geolocation.zip',
  'geolocation.latitude', 'geolocation.longitude', 'geolocation.timezone',
  'geolocation.isp', 'geolocation.org',
  'browser_info.family', 'browser_info.version', 'browser_info.major',
  'os_info.family', 'os_info.version', 'os_info.major',
  'device_info.family', 'device_info.brand', 'device_info.model', 'device_info.type',
];

// Nested schema paths become dotted columns (`geolocation.city`). An array or an
// unexpected object becomes JSON in a single cell rather than being spread into
// a variable number of columns, which would make the header row depend on the
// data.
function flatten(value, prefix, out) {
  for (const [key, item] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(key)) continue;
    const column = prefix ? prefix + '.' + key : key;
    const isPlainObject = item !== null
      && typeof item === 'object'
      && !Array.isArray(item)
      && !(item instanceof Date)
      && !(item instanceof mongoose.Types.ObjectId)
      && !Buffer.isBuffer(item);
    if (isPlainObject) {
      flatten(item, column, out);
    } else {
      out[column] = item;
    }
  }
  return out;
}

function cell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return String(value);
  return String(value);
}

// RFC 4180: quote any field containing a comma, quote or newline, and escape an
// embedded quote by doubling it. Lead data carries commas in addresses and the
// occasional newline pasted into a field, so this is not theoretical.
function escape(value) {
  const text = cell(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set. The app reads it from .env; run this '
      + 'from the deployment directory so dotenv finds the same file.');
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  const filter = onlySource ? { source: onlySource } : {};
  const docs = await Submission.find(filter).sort({ submission_date: 1 }).lean();

  if (!docs.length) {
    console.log('No submissions matched, so no file was written.');
    return;
  }

  const rows = docs.map((doc) => flatten(doc, '', {}));

  const seen = new Set();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  const columns = [
    ...PREFERRED_ORDER.filter((key) => seen.has(key)),
    ...[...seen].filter((key) => !PREFERRED_ORDER.includes(key)).sort(),
  ];

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  // Excel reads a UTF-8 CSV as the local codepage unless it sees a BOM, which
  // mangles any non-ASCII name in the file.
  out.write('﻿');
  out.write(columns.join(',') + '\r\n');
  for (const row of rows) {
    out.write(columns.map((key) => escape(row[key])).join(',') + '\r\n');
  }
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });

  const bySource = rows.reduce((acc, row) => {
    const key = row.source || '(unset)';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log('Wrote ' + rows.length + ' row(s) and ' + columns.length + ' column(s) to');
  console.log('  ' + outPath);
  console.log('By source: '
    + Object.entries(bySource).map(([k, v]) => k + '=' + v).join('  '));
}

main()
  .catch((error) => {
    console.error('ERROR: ' + error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
