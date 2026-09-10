'use strict';
//
// Decode the TrustedForm event stream out of a `--capture` file.
//
// This is ADDITIVE. scripts/lib/reporting.js keeps doing exactly what it did:
// it flattens the JSON envelopes and reports the `wpm` / `kpm` values found in
// the /update pings. What it never looked inside is the `body` field that the
// POSTs to /certs/<id>/events carry, because that body is not JSON -- it is
// zlib-deflated, base64-encoded, and only then a JSON array. Everything the
// study actually asks about (was a submission observed, and when) lives in
// there, so this module opens it.
//
// Nothing here infers, defaults or derives. A stream that cannot be decoded is
// reported as undecodable; a code that is absent is reported as absent.

const zlib = require('zlib');

// The event code table, read verbatim off the SDK the page loads
// (cdn.trustedform.com/trustedform-1.12.10.js, where these are the string
// values of its EVENT_* constants). Each event in the stream is an array whose
// first element is a millisecond offset and whose second is one of these codes.
//
// Two codes collide in the SDK itself: EVENT_CHECKBOX_CHANGED and
// EVENT_OPT_IN_OPT_OUT are both "b". That is the vendor's own overload, not a
// transcription error, so both names are kept on the one code.
const EVENT_NAMES = {
  d: 'DOM_MUTATION',
  k: 'INPUT_CHANGED',
  kd: 'KEYDOWN',
  b: 'CHECKBOX_CHANGED / OPT_IN_OPT_OUT',
  r: 'RADIO_CHANGED',
  si: 'SELECT_CHANGED',
  c: 'CLICK',
  m: 'MOUSEMOVE',
  rw: 'RESIZE_WINDOW',
  s: 'SCROLLING',
  fs: 'FORM_SUBMIT',
  cl: 'CONSENT_LANGUAGE_FOUND',
  clmd: 'CONSENT_LANGUAGE_METADATA',
  otoc: 'OTOC_FOUND',
  mlc: 'MLC_FOUND',
  sbc: 'SUBMIT_BELOW_CONSENT',
  vndr: 'VENDOR_TAG',
  lf: 'LIBRARY_FOUND',
};

// The code this whole investigation is about. TrustedForm emits it from two
// places in the SDK: its listener on a <form>'s `submit` event, and its
// listener on the `click` of an element matching its submit-role selector list.
const FORM_SUBMIT_CODE = 'fs';

/**
 * Turn one captured POST body into the text the SDK sent.
 *
 * The envelope is {body, chunk_number, request_number, encoding}. `encoding` is
 * only present on the small uncompressed payloads; the large ones are deflated
 * with no marker at all, so decompression is attempted and falls back to a
 * plain base64 decode rather than being decided by the field.
 */
function decodeEventBody(base64Body) {
  const buffer = Buffer.from(String(base64Body), 'base64');
  try {
    return zlib.inflateSync(buffer).toString('utf8');
  } catch {
    return buffer.toString('utf8');
  }
}

function isEventsRequest(event) {
  return event
    && event.dir === 'REQ'
    && /\/certs\/[^/]+\/events(\?|$)/.test(String(event.url));
}

/**
 * Pull every `[offsetMs, code, ...]` tuple out of a decoded stream.
 *
 * The stream is a JSON array of arrays, but a chunked request can hand over a
 * fragment that is not itself parseable JSON. Parsing is therefore attempted
 * first and a bounded scan is used when it fails, so a truncated final chunk
 * still yields the events it does contain instead of yielding nothing. Which
 * path was taken is reported per request in `requests[].parsed`.
 */
function readEventTuples(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const tuples = parsed
        .filter((e) => Array.isArray(e) && typeof e[1] === 'string')
        .map((e) => ({ offsetMs: typeof e[0] === 'number' ? e[0] : null, code: e[1] }));
      return { tuples, parsed: 'json' };
    }
  } catch { /* fragment, not a complete document; scan below */ }

  const tuples = [];
  const re = /\[\s*(\d+)\s*,\s*"([a-z_]{1,8})"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    tuples.push({ offsetMs: Number(match[1]), code: match[2] });
  }
  return { tuples, parsed: 'scanned' };
}

/**
 * Decode a capture's TrustedForm event stream.
 *
 * Returns the observed code counts, the per-request breakdown, and a
 * `formSubmitted` verdict that is `true` / `false` only when the stream was
 * readable. If no /events POST was captured at all, or every one of them failed
 * to decode, the verdict is the string 'not available' -- the absence of
 * evidence is reported as such and never collapsed into `false`.
 */
function decodeTrustedFormEvents(captureEvents) {
  const requests = [];
  const counts = {};
  const formSubmitEvents = [];
  let decodedRequests = 0;

  for (const event of captureEvents || []) {
    if (!isEventsRequest(event)) continue;

    let envelope = null;
    try {
      envelope = JSON.parse(event.post);
    } catch {
      requests.push({ status: 'envelope-unparseable', bytes: (event.post || '').length });
      continue;
    }
    if (!envelope || typeof envelope.body !== 'string') {
      requests.push({ status: 'no-body-field', requestNumber: envelope && envelope.request_number });
      continue;
    }

    let text;
    try {
      text = decodeEventBody(envelope.body);
    } catch (error) {
      requests.push({ status: 'undecodable', requestNumber: envelope.request_number, error: error.message });
      continue;
    }

    const { tuples, parsed } = readEventTuples(text);
    decodedRequests += 1;

    const perRequest = {};
    for (const tuple of tuples) {
      counts[tuple.code] = (counts[tuple.code] || 0) + 1;
      perRequest[tuple.code] = (perRequest[tuple.code] || 0) + 1;
      if (tuple.code === FORM_SUBMIT_CODE) {
        formSubmitEvents.push({
          requestNumber: envelope.request_number,
          chunkNumber: envelope.chunk_number,
          offsetMs: tuple.offsetMs,
        });
      }
    }

    requests.push({
      status: 'decoded',
      requestNumber: envelope.request_number,
      chunkNumber: envelope.chunk_number,
      decodedBytes: text.length,
      parsed,
      eventCount: tuples.length,
      codes: perRequest,
    });
  }

  const observed = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, name: EVENT_NAMES[code] || 'UNKNOWN', count }));

  return {
    eventRequests: requests.length,
    decodedRequests,
    observed,
    // The answer to the question ActiveProspect asked, and nothing more.
    formSubmitted: decodedRequests === 0 ? 'not available' : formSubmitEvents.length > 0,
    formSubmitEvents,
    consentLanguageFound: decodedRequests === 0 ? 'not available' : Boolean(counts.cl),
    consentLanguageMetadata: decodedRequests === 0 ? 'not available' : Boolean(counts.clmd),
    submitBelowConsent: decodedRequests === 0 ? 'not available' : Boolean(counts.sbc),
    taggedConsentMatch: decodedRequests === 0 ? 'not available' : Boolean(counts.mlc),
  };
}

module.exports = {
  EVENT_NAMES,
  FORM_SUBMIT_CODE,
  decodeEventBody,
  decodeTrustedFormEvents,
};
