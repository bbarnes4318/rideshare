'use strict';
//
// Report writing and TrustedForm signal extraction for the behavioral harness.
//
// Signal extraction is deliberately conservative: it flattens whatever the
// browser actually exchanged with TrustedForm (the `--capture` events) and
// reports the values it finds under their real key names. A signal that is not
// present in the capture is reported as null. Nothing is inferred, defaulted,
// derived or invented.

const fs = require('fs');
const path = require('path');

// The signals this study is specifically asking about. Reported as null when
// the capture does not contain them, never as 0.
const CANONICAL_SIGNALS = ['wpm', 'kpm'];

function flatten(value, prefix, out) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, prefix + '[' + i + ']', out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? prefix + '.' + k : k, out);
    return out;
  }
  out[prefix] = value;
  return out;
}

function parsePayload(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* not JSON; try form encoding below */ }
  if (!/[=&]/.test(trimmed) || /\s{2,}|[<>]/.test(trimmed)) return null;
  const params = new URLSearchParams(trimmed);
  const out = {};
  let any = false;
  for (const [k, v] of params) {
    any = true;
    // TrustedForm form-encodes JSON blobs into single parameters.
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return any ? out : null;
}

// Keep the series bounded: a long session can ping many times.
const MAX_SERIES = 100;

/**
 * Extract whatever TrustedForm signals the capture actually contains.
 *
 * Policy is LAST OBSERVED, not first. TrustedForm's script pings periodically
 * from page load onwards, so the earliest payload of a session is always zero
 * for anything cumulative -- it fires before the visitor has touched the form.
 * Reporting that first ping would understate every run. `signals` therefore
 * carries the last value seen for each key (the state closest to submission),
 * and `series` carries the ordered values so the progression, including the
 * leading zeros, stays visible in the report.
 *
 * A key the capture never contained is reported as null. Nothing is inferred,
 * defaulted or derived.
 */
function extractTrustedFormSignals(captureEvents) {
  const signals = {};
  for (const key of CANONICAL_SIGNALS) signals[key] = null;

  const series = {};
  const observedKeys = new Set();
  let sourceCount = 0;

  for (const event of captureEvents || []) {
    for (const payloadText of [event.post, event.body]) {
      const parsed = parsePayload(payloadText);
      if (!parsed || typeof parsed !== 'object') continue;
      sourceCount += 1;
      const flat = flatten(parsed, '', {});
      for (const [fullKey, value] of Object.entries(flat)) {
        observedKeys.add(fullKey);
        const leaf = fullKey.split('.').pop().replace(/\[\d+\]$/, '');
        const known = Object.prototype.hasOwnProperty.call(signals, leaf);
        if (!known && typeof value !== 'number' && typeof value !== 'boolean') continue;
        signals[leaf] = value;
        if (!series[leaf]) series[leaf] = [];
        if (series[leaf].length < MAX_SERIES) series[leaf].push(value);
      }
    }
  }

  return {
    signals,
    series,
    observedKeys: [...observedKeys].sort(),
    sourceCount,
    policy: 'last-observed',
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// One row per run. Detailed events stay in JSON, never in the CSV.
const CSV_COLUMNS = [
  'runId', 'cohort', 'targetDurationSec', 'actualDurationSec', 'proxyIp', 'proxyCity', 'proxyState',
  'zip', 'city', 'state', 'trustedFormCertificate', 'trustedFormCertificateId', 'wpm', 'kpm',
  'interactionCount', 'keystrokeCount', 'focusCount', 'blurCount', 'scrollCount', 'pauseCount',
  'submitTimestamp', 'success',
];

function csvRow(record) {
  const g = (o, ...keys) => keys.reduce((acc, k) => (acc == null ? acc : acc[k]), o);
  const values = {
    runId: record.runId,
    cohort: record.cohort,
    targetDurationSec: record.targetDurationSec,
    actualDurationSec: record.actualDurationSec,
    proxyIp: g(record, 'proxy', 'ip'),
    proxyCity: g(record, 'proxy', 'city'),
    proxyState: g(record, 'proxy', 'state'),
    zip: g(record, 'leadLocation', 'zip'),
    city: g(record, 'leadLocation', 'city'),
    state: g(record, 'leadLocation', 'state'),
    trustedFormCertificate: g(record, 'trustedForm', 'certificateUrl'),
    trustedFormCertificateId: g(record, 'trustedForm', 'certificateId'),
    wpm: g(record, 'trustedForm', 'signals', 'wpm'),
    kpm: g(record, 'trustedForm', 'signals', 'kpm'),
    interactionCount: g(record, 'interactionSummary', 'interactionCount'),
    keystrokeCount: g(record, 'interactionSummary', 'keystrokeCount'),
    focusCount: g(record, 'interactionSummary', 'focusCount'),
    blurCount: g(record, 'interactionSummary', 'blurCount'),
    scrollCount: g(record, 'interactionSummary', 'scrollCount'),
    pauseCount: g(record, 'interactionSummary', 'pauseCount'),
    submitTimestamp: g(record, 'submission', 'timestamp'),
    success: g(record, 'submission', 'success'),
  };
  return CSV_COLUMNS.map((c) => csvEscape(values[c])).join(',');
}

function toCsv(records) {
  return [CSV_COLUMNS.join(','), ...records.map(csvRow)].join('\n') + '\n';
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function summarize(records) {
  const byCohort = new Map();
  for (const r of records) {
    if (!byCohort.has(r.cohort)) byCohort.set(r.cohort, []);
    byCohort.get(r.cohort).push(r);
  }
  const out = [];
  for (const [cohort, rows] of byCohort) {
    const durations = rows.map((r) => r.actualDurationSec).filter((d) => typeof d === 'number');
    out.push({
      cohort,
      runs: rows.length,
      minDurationSec: durations.length ? Math.min(...durations) : null,
      maxDurationSec: durations.length ? Math.max(...durations) : null,
      meanDurationSec: durations.length ? round2(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      medianDurationSec: median(durations),
      successfulSubmissions: rows.filter((r) => r.submission && r.submission.success).length,
      trustedFormCertificates: rows.filter((r) => r.trustedForm && r.trustedForm.certificateUrl).length,
      runsWithNonZeroWpm: rows.filter((r) => Number(r.trustedForm?.signals?.wpm) > 0).length,
      runsWithNonZeroKpm: rows.filter((r) => Number(r.trustedForm?.signals?.kpm) > 0).length,
      // The funnel's own irreducible cost, measured. A cohort range below this
      // cannot be reached however the pauses are distributed.
      meanFunnelFloorSec: (() => {
        const floors = rows.map((r) => r.unpausedSec).filter((v) => typeof v === 'number');
        return floors.length ? round2(floors.reduce((a, b) => a + b, 0) / floors.length) : null;
      })(),
      meanMinimumSessionSec: (() => {
        const mins = rows.map((r) => r.minimumSessionSec).filter((v) => typeof v === 'number');
        return mins.length ? round2(mins.reduce((a, b) => a + b, 0) / mins.length) : null;
      })(),
      runsWithUnreachableTarget: rows.filter((r) => r.targetUnreachable).length,
    });
  }
  return out;
}

function formatSummary(summaries) {
  const lines = [];
  for (const s of summaries) {
    lines.push(s.cohort.toUpperCase());
    lines.push('  runs:                    ' + s.runs);
    lines.push('  min duration (s):        ' + s.minDurationSec);
    lines.push('  max duration (s):        ' + s.maxDurationSec);
    lines.push('  mean duration (s):       ' + s.meanDurationSec);
    lines.push('  median duration (s):     ' + s.medianDurationSec);
    lines.push('  successful submissions:  ' + s.successfulSubmissions);
    lines.push('  TrustedForm certificates:' + s.trustedFormCertificates);
    lines.push('  runs with wpm > 0:       ' + s.runsWithNonZeroWpm);
    lines.push('  runs with kpm > 0:       ' + s.runsWithNonZeroKpm);
    lines.push('  mean funnel floor (s):   ' + s.meanFunnelFloorSec);
    lines.push('  mean min session (s):    ' + s.meanMinimumSessionSec);
    lines.push('  targets unreachable:     ' + s.runsWithUnreachableTarget);
  }
  return lines.join('\n');
}

function writeReports({ reportDir, batchId, records }) {
  const runsDir = path.join(reportDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  for (const record of records) {
    fs.writeFileSync(path.join(runsDir, record.runId + '.json'), JSON.stringify(record, null, 2));
  }
  const summaries = summarize(records);
  const jsonPath = path.join(reportDir, 'behavioral-' + batchId + '.json');
  const csvPath = path.join(reportDir, 'behavioral-' + batchId + '.csv');
  fs.writeFileSync(jsonPath, JSON.stringify({
    batchId,
    generatedAt: new Date().toISOString(),
    automatedTest: true,
    summary: summaries,
    runs: records,
  }, null, 2));
  fs.writeFileSync(csvPath, toCsv(records));
  return { jsonPath, csvPath, runsDir, summaries };
}

module.exports = {
  CANONICAL_SIGNALS,
  CSV_COLUMNS,
  extractTrustedFormSignals,
  flatten,
  parsePayload,
  csvEscape,
  toCsv,
  csvRow,
  median,
  summarize,
  formatSummary,
  writeReports,
};
