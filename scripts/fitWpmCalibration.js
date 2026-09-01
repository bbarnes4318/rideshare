#!/usr/bin/env node
'use strict';

//
// Fit the typing-rate -> TrustedForm-wpm calibration from real runs.
//
// TrustedForm computes wpm from the interval between real key events, so a
// requested wpm is delivered by typing at the rate that produces it. That
// mapping is empirical: it is measured here from every run that recorded both
// the rate it typed at and the wpm TrustedForm reported back.
//
// Usage:
//   node scripts/fitWpmCalibration.js [report-dir]
//
// Prints the fitted model, its residuals, and the environment variables to set.
// Nothing is submitted and nothing is modified.
//

const fs = require('fs');
const path = require('path');

const reportDir = path.resolve(process.argv[2]
  || process.env.BEHAVIOR_REPORT_DIR
  || path.join(__dirname, '..', 'test-reports'));

function collect(dir) {
  const runsDir = path.join(dir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const points = [];
  for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'))) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8')); } catch { continue; }
    const cpm = record.interactionModel && record.interactionModel.typingCharsPerMinute;
    const wpm = record.trustedForm && record.trustedForm.signals && record.trustedForm.signals.wpm;
    // Only typed runs with a real reported rate. A fill run reports 0 by
    // construction and would drag the fit toward the origin for the wrong reason.
    if (!cpm || typeof wpm !== 'number' || !(wpm > 0)) continue;
    if (record.interactionModel.entryMode === 'fill') continue;
    points.push({
      cpm,
      wpm,
      runId: record.runId,
      keystrokes: record.interactionSummary && record.interactionSummary.keystrokeCount,
    });
  }
  return points.sort((a, b) => a.cpm - b.cpm);
}

/** Ordinary least squares for wpm = a*cpm + b. */
function fit(points) {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.cpm, 0) / n;
  const meanY = points.reduce((s, p) => s + p.wpm, 0) / n;
  const sxy = points.reduce((s, p) => s + (p.cpm - meanX) * (p.wpm - meanY), 0);
  const sxx = points.reduce((s, p) => s + (p.cpm - meanX) ** 2, 0);
  const a = sxy / sxx;
  const b = meanY - a * meanX;
  const ssTot = points.reduce((s, p) => s + (p.wpm - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.wpm - (a * p.cpm + b)) ** 2, 0);
  return { a, b, r2: ssTot === 0 ? null : 1 - ssRes / ssTot };
}

const points = collect(reportDir);

console.log('WPM calibration fit');
console.log('report dir: ' + reportDir);
console.log('');

if (points.length < 3) {
  console.log('Only ' + points.length + ' usable point(s). Need at least 3 typed runs that');
  console.log('produced a non-zero TrustedForm wpm before a fit means anything.');
  console.log('Run a few with --target-wpm at different values, then re-run this.');
  process.exitCode = 1;
} else {
  const { a, b, r2 } = fit(points);
  const invSlope = 1 / a;
  const invOffset = -b / a;

  console.log(points.length + ' points:');
  console.log('   cpm    TF wpm    fitted    error');
  for (const p of points) {
    const pred = a * p.cpm + b;
    console.log('  ' + String(p.cpm).padStart(4)
      + String(p.wpm.toFixed(1)).padStart(10)
      + String(pred.toFixed(1)).padStart(10)
      + String((pred - p.wpm >= 0 ? '+' : '') + (pred - p.wpm).toFixed(1)).padStart(9));
  }
  console.log('');
  console.log('model:    wpm = ' + a.toFixed(5) + ' * cpm ' + (b >= 0 ? '+ ' : '- ') + Math.abs(b).toFixed(3));
  console.log('inverse:  cpm = ' + invSlope.toFixed(4) + ' * wpm ' + (invOffset >= 0 ? '+ ' : '- ') + Math.abs(invOffset).toFixed(2));
  console.log('R^2:      ' + (r2 === null ? 'n/a' : r2.toFixed(4)));
  console.log('');

  // A purely proportional model is what the harness ships with by default;
  // report whether the offset is actually earning its place.
  const propSlope = points.reduce((s, p) => s + p.cpm / p.wpm, 0) / points.length;
  const propErr = points.reduce((s, p) => s + Math.abs(p.cpm / propSlope - p.wpm), 0) / points.length;
  const affErr = points.reduce((s, p) => s + Math.abs(a * p.cpm + b - p.wpm), 0) / points.length;
  console.log('mean abs error, proportional (cpm = ' + propSlope.toFixed(3) + ' * wpm): '
    + propErr.toFixed(2) + ' wpm');
  console.log('mean abs error, affine:                          ' + affErr.toFixed(2) + ' wpm');
  console.log('');
  console.log('Set these to use the fitted model:');
  console.log('  BEHAVIOR_CPM_PER_WPM=' + invSlope.toFixed(4));
  console.log('  BEHAVIOR_CPM_WPM_OFFSET=' + invOffset.toFixed(2));
  console.log('');
  console.log('Residual spread is real: TrustedForm measures over the intervals typing');
  console.log('actually occupied, so the same requested rate lands a few wpm apart run to');
  console.log('run. Treat a target as approximate and read the achieved value per run.');
}
