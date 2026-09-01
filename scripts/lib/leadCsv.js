'use strict';

//
// Input CSV ingest, sanitization and output for the batch test harness.
//
// Parsing is done here rather than with a dependency so the package-lock stays
// untouched; the parser is RFC 4180 (quoted fields, embedded commas, embedded
// newlines, doubled quotes) and is covered by test/unit.js.
//

const fs = require('fs');

const REQUIRED_HEADERS = [
  'First_Name', 'Last_Name', 'Gender', 'Age', 'Address',
  'City', 'State', 'Zip', 'Phone', 'Email', 'DOB',
];

// The final business output, exactly these headers in exactly this order.
const OUTPUT_HEADERS = [
  'firstName', 'lastName', 'phone', 'email', 'address', 'city', 'state',
  'zipCode', 'birthdate', 'gender', 'ipAddress', 'trustedFormURL', 'datePosted',
];

// ---------------------------------------------------------------------------
// RFC 4180 parsing
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // distinguishes an empty trailing line from a real field

  const endField = () => { row.push(field); field = ''; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  const src = String(text).replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && !started) { inQuotes = true; started = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRow(); continue; }
    field += c;
    started = true;
  }
  if (field !== '' || started || row.length) endRow();

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

/**
 * Standardize a date of birth to MM/DD/YYYY with zero padding.
 *
 * Accepts M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD and the same with '-' or '.' as the
 * separator. Ambiguous two-digit years are rejected rather than guessed: a lead
 * born in '55 and one born in 2055 are not distinguishable, and silently
 * choosing is worse than telling the operator to fix the input.
 */
function normalizeDob(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) throw new Error('DOB is empty');

  let y;
  let m;
  let d;
  let match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    [, y, m, d] = match;
  } else {
    match = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!match) {
      throw new Error('DOB "' + value + '" is not MM/DD/YYYY or YYYY-MM-DD'
        + (/\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/.test(value)
          ? ' (two-digit years are ambiguous and are not guessed)' : ''));
    }
    [, m, d, y] = match;
  }

  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12) throw new Error('DOB "' + value + '" has month ' + month);
  if (day < 1 || day > 31) throw new Error('DOB "' + value + '" has day ' + day);

  // Reject dates that do not exist, e.g. 02/30.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error('DOB "' + value + '" is not a real date');
  }

  const pad = (n) => String(n).padStart(2, '0');
  return pad(month) + '/' + pad(day) + '/' + year;
}

/**
 * Reduce a phone number to 10 digits.
 *
 * A leading US country code is dropped; anything else that is not exactly ten
 * digits is an error rather than a truncation, because quietly trimming digits
 * produces a valid-looking number belonging to someone else.
 */
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) {
    throw new Error('Phone "' + String(raw).trim() + '" has ' + local.length + ' digits, expected 10');
  }
  return local;
}

/** Normalize gender for internal routing. Unknown values pass through lowercased. */
function normalizeGender(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (['m', 'male', 'man'].includes(value)) return 'male';
  if (['f', 'female', 'woman'].includes(value)) return 'female';
  return value;
}

function normalizeZip(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length < 5) throw new Error('Zip "' + String(raw).trim() + '" is shorter than 5 digits');
  return digits.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Test-record safety check
// ---------------------------------------------------------------------------

// Domains reserved by RFC 2606 / RFC 6761 that can never receive real mail.
const RESERVED_EMAIL = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|(?:test|invalid|localhost|example))$/i;
const TEST_NAME = /(?:^|[\s._-])(?:test|testlead|donotcontact|qa|sample|synthetic)(?:$|[\s._-])/i;

/**
 * Does this row look like a synthetic/authorized test record?
 *
 * The batch runner submits to the live funnel, so by default it will only do so
 * for records that are self-evidently test data. This is the check behind that
 * default; `--allow-non-test-records` is required to override it.
 */
function looksLikeTestRecord(row) {
  const reasons = [];
  if (RESERVED_EMAIL.test(String(row.email || ''))) reasons.push('reserved email domain');
  if (TEST_NAME.test(String(row.lastName || '')) || TEST_NAME.test(String(row.firstName || ''))) {
    reasons.push('test marker in name');
  }
  return { isTest: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and sanitize the input CSV.
 *
 * Returns { rows, errors }: rows that sanitized cleanly, and a per-row reason
 * for every row that did not. A bad row never silently becomes a submission.
 */
function loadLeadCsv(filePath) {
  const table = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!table.length) throw new Error('Input CSV is empty: ' + filePath);

  const headers = table[0].map((h) => String(h).trim());
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    throw new Error('Input CSV is missing required header(s): ' + missing.join(', ')
      + '\nFound: ' + headers.join(', '));
  }
  const index = Object.fromEntries(headers.map((h, i) => [h, i]));
  const cell = (r, h) => String(r[index[h]] == null ? '' : r[index[h]]).trim();

  const rows = [];
  const errors = [];
  for (let i = 1; i < table.length; i += 1) {
    const raw = table[i];
    const lineNumber = i + 1;
    try {
      const row = {
        lineNumber,
        firstName: cell(raw, 'First_Name'),
        lastName: cell(raw, 'Last_Name'),
        gender: normalizeGender(cell(raw, 'Gender')),
        age: cell(raw, 'Age'),
        address: cell(raw, 'Address'),
        city: cell(raw, 'City'),
        state: cell(raw, 'State'),
        zip: normalizeZip(cell(raw, 'Zip')),
        phone: normalizePhone(cell(raw, 'Phone')),
        email: cell(raw, 'Email'),
        dob: normalizeDob(cell(raw, 'DOB')),
      };
      for (const required of ['firstName', 'lastName', 'address', 'email']) {
        if (!row[required]) throw new Error(required + ' is empty');
      }
      row.testRecord = looksLikeTestRecord(row);
      rows.push(row);
    } catch (error) {
      errors.push({ lineNumber, error: error.message });
    }
  }
  return { rows, errors, headers };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Execution timestamp as MM/DD/YYYY. */
function datePosted(at = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return pad(at.getMonth() + 1) + '/' + pad(at.getDate()) + '/' + at.getFullYear();
}

function writeOutputCsv(filePath, records) {
  const lines = [OUTPUT_HEADERS.join(',')];
  for (const r of records) {
    lines.push(OUTPUT_HEADERS.map((h) => csvEscape(r[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

module.exports = {
  REQUIRED_HEADERS,
  OUTPUT_HEADERS,
  parseCsv,
  normalizeDob,
  normalizePhone,
  normalizeGender,
  normalizeZip,
  looksLikeTestRecord,
  loadLeadCsv,
  writeOutputCsv,
  csvEscape,
  datePosted,
};
