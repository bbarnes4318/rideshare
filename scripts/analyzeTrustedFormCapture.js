#!/usr/bin/env node
'use strict';
//
// Report what a `--capture` file actually contains, and compare two of them.
//
// Usage:
//   node scripts/analyzeTrustedFormCapture.js <capture.json> [<capture.json> ...]
//
// Every value printed is read out of the capture. A signal the capture does not
// contain prints as "not available", never as false and never as zero.

const fs = require('fs');
const path = require('path');
const { decodeTrustedFormEvents } = require('./lib/tfEvents');

function loadRun(capturePath) {
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const metaPath = capturePath.replace(/\.json$/, '') + '.meta.json';
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
  return { capturePath, capture, meta, decoded: decodeTrustedFormEvents(capture.events) };
}

function line(label, value) {
  console.log(label.padEnd(28) + ': ' + (value === null || value === undefined ? 'not available' : value));
}

function report(run) {
  const { capture, meta, decoded } = run;
  console.log('');
  console.log('='.repeat(72));
  console.log(path.basename(run.capturePath));
  console.log('='.repeat(72));

  line('submission mode', meta && meta.submissionMode);
  line('page URL', meta && meta.pageUrl);
  line('certificate', capture.certUrl);
  line('certificate ID', capture.certId);
  line('capture file', run.capturePath);
  line('proxy IP', capture.egressIp || (meta && meta.proxyIp));
  line('proxy IP location', meta && meta.proxyIpLocation);
  line('ZIP', meta && meta.zip);
  line('city', meta && meta.city);
  line('state', meta && meta.state);
  line('final URL', capture.pageUrl);
  line('form response', meta && meta.responseMessage);

  console.log('');
  console.log('-- POST to /api-proxy/ (did the submission actually leave the browser) --');
  if (meta && meta.apiRequest) {
    line('  method', meta.apiRequest.method);
    line('  content-type', meta.apiRequest.contentType);
    line('  Authorization header', meta.apiRequest.hasAuthorizationHeader);
    line('  body bytes', meta.apiRequest.postDataBytes);
  } else {
    line('  observed', meta ? 'NO POST OBSERVED' : null);
  }

  console.log('');
  console.log('-- TrustedForm signals decoded from the capture --');
  line('form_submitted', decoded.formSubmitted);
  line('  FORM_SUBMIT events', decoded.formSubmitEvents.length
    ? decoded.formSubmitEvents.map((e) => `req#${e.requestNumber} @${e.offsetMs}ms`).join(', ')
    : (decoded.formSubmitted === 'not available' ? null : 'none'));
  line('submit clicked at', meta && meta.submitClickedAt);
  line('consent language found', decoded.consentLanguageFound);
  line('consent language metadata', decoded.consentLanguageMetadata);
  line('tagged consent match', decoded.taggedConsentMatch);
  line('submit below consent', decoded.submitBelowConsent);
  line('/events POSTs captured', decoded.eventRequests);
  line('/events POSTs decoded', decoded.decodedRequests);

  console.log('');
  console.log('-- event codes present in the stream --');
  if (!decoded.observed.length) console.log('  (none decoded)');
  for (const entry of decoded.observed) {
    console.log('  ' + String(entry.count).padStart(6) + '  ' + entry.code.padEnd(6) + entry.name);
  }
}

function compare(runs) {
  console.log('');
  console.log('='.repeat(72));
  console.log('A/B COMPARISON');
  console.log('='.repeat(72));
  const rows = [
    ['submission mode', (r) => (r.meta && r.meta.submissionMode) || '?'],
    ['certificate ID', (r) => r.capture.certId],
    ['form_submitted', (r) => String(r.decoded.formSubmitted)],
    ['FORM_SUBMIT count', (r) => r.decoded.formSubmitEvents.length],
    ['consent language found', (r) => String(r.decoded.consentLanguageFound)],
    ['tagged consent match', (r) => String(r.decoded.taggedConsentMatch)],
    ['submit below consent', (r) => String(r.decoded.submitBelowConsent)],
    ['/events decoded', (r) => r.decoded.decodedRequests],
    ['POST /api-proxy/ seen', (r) => String(Boolean(r.meta && r.meta.apiRequest))],
  ];
  for (const [label, get] of rows) {
    console.log(label.padEnd(26) + runs.map((r) => String(get(r)).padEnd(44)).join(''));
  }
}

function main() {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!paths.length) {
    console.error('Usage: node scripts/analyzeTrustedFormCapture.js <capture.json> [...]');
    process.exit(1);
  }
  const runs = paths.map(loadRun);
  runs.forEach(report);
  if (runs.length > 1) compare(runs);
}

main();
