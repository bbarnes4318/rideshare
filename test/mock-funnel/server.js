'use strict';
//
// Loopback stand-in for the production funnel, used ONLY by the harness's
// --offline-selftest. It is NOT TrustedForm and it is NOT the production
// funnel: it reproduces the shapes the harness depends on (hash-routed steps,
// choice <a> links, a.btn-next, the field ids, a hidden
// input[name=xxTrustedFormCertUrl], an exact-text "Submit" control, and a
// /trustedform/ ping endpoint) so the harness's step walking, telemetry,
// capture, signal extraction and reporting can be verified with no network
// access and no real submission.
//
// The certificate ids and the wpm/kpm it reports are locally generated. Any
// report produced against this server is stamped offlineSelfTest: true.

const http = require('http');
const crypto = require('crypto');

const STEPS = [
  { hash: '#/gender', question: 'What is your gender?', choices: ['Male', 'Female'] },
  { hash: '#/zip-code', question: 'What is your ZIP code?', fields: [{ tag: 'input', id: 'zipCode', type: 'tel' }] },
  {
    hash: '#/birth-date',
    question: 'What is your date of birth?',
    fields: [
      { tag: 'select', id: 'birthMonth', options: ['', 'string:0', 'string:1', 'string:2', 'string:3', 'string:4', 'string:5', 'string:6', 'string:7', 'string:8', 'string:9', 'string:10', 'string:11'] },
      { tag: 'input', id: 'birthDay', type: 'tel' },
      { tag: 'input', id: 'birthYear', type: 'tel' },
    ],
  },
  { hash: '#/currently-insured', question: 'Are you currently insured?', choices: ['Yes', 'No'] },
  { hash: '#/credit-score', question: 'What is your credit score?', choices: ['800-750 Excellent', '700-640 Good', '639-600 Fair'] },
  { hash: '#/marriage-status', question: 'Are you married?', choices: ['Yes', 'No'] },
  { hash: '#/homeowner', question: 'Do you own your home?', choices: ['Yes', 'No'] },
  { hash: '#/va-loan', question: 'Have you served in the military?', choices: ['Yes', 'No'] },
  { hash: '#/tobacco-use', question: 'Do you use tobacco?', choices: ['Yes', 'No'] },
  { hash: '#/cancer', question: 'Have you been diagnosed with cancer?', choices: ['Yes', 'No'] },
  { hash: '#/heart-disease', question: 'Have you been diagnosed with heart disease?', choices: ['Yes', 'No'] },
  { hash: '#/coverage-amount', question: 'How much coverage do you need?', choices: ['$25,000 (Funeral Expenses)', '$50,000', '$100,000'] },
  {
    // Mirrors the live funnel: height is a <select> of INCHES, and weight is a
    // separate step carrying an angularjs-slider rather than an <input>. The
    // real form has no weight input at all, so a mock with one cannot catch a
    // regression in the harness's slider handling.
    hash: '#/height',
    question: 'What is your height?',
    fields: [
      { tag: 'select', id: 'vm.height', options: ['', '55', '60', '63', '64', '66', '67', '68', '69', '70', '71', '72', '75', '76', '83'] },
    ],
  },
  {
    hash: '#/weight',
    question: 'How much do you weigh?',
    slider: { min: 100, max: 400, value: 160 },
  },
  {
    hash: '#/verify-information',
    question: 'Where should we send your quote?',
    fields: [
      { tag: 'input', id: 'address', type: 'text' },
      { tag: 'input', id: 'firstName', type: 'text' },
      { tag: 'input', id: 'lastName', type: 'text' },
      { tag: 'input', id: 'email', type: 'email' },
      { tag: 'input', id: 'phone', type: 'tel' },
    ],
    submit: true,
  },
];

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Mock Funnel (offline self-test)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }
  /* Tall enough that wheel scrolling actually moves the document. */
  #spacer { height: 2200px; }
  .step { display: none; }
  .step.active { display: block; }
  a { display: inline-block; padding: 10px 16px; margin: 6px 0; border: 1px solid #ccc;
      border-radius: 6px; cursor: pointer; text-decoration: none; color: #123; }
  input, select { display: block; font-size: 16px; padding: 8px; margin: 8px 0; width: 260px; }
</style>
<script src="/trustedform.js"></script>
<h1>Mock quote funnel</h1>
<form id="mock-form">
  <input type="hidden" name="xxTrustedFormCertUrl" id="xxTrustedFormCertUrl_0" value="">
  <div id="steps"></div>
</form>
<div id="spacer"></div>
<script>
  var STEPS = __STEPS__;
  var host = document.getElementById('steps');

  // Angular's ng-view keeps only the active step in the DOM, so the mock does
  // the same: building every step up front and merely hiding the inactive ones
  // would let a selector resolve to a control the real funnel has removed.
  function build(step) {
    var el = document.createElement('div');
    el.className = 'step active';
    el.setAttribute('data-hash', step.hash);
    var q = document.createElement('h2');
    q.textContent = step.question;
    el.appendChild(q);
    (step.fields || []).forEach(function (f) {
      if (f.tag === 'select') {
        var sel = document.createElement('select');
        sel.id = f.id; sel.name = f.id;
        f.options.forEach(function (v) {
          var o = document.createElement('option');
          o.value = v; o.textContent = v === '' ? 'Select' : v;
          sel.appendChild(o);
        });
        el.appendChild(sel);
      } else {
        var input = document.createElement('input');
        input.id = f.id; input.name = f.id; input.type = f.type || 'text';
        el.appendChild(input);
      }
    });
    if (step.slider) {
      var s = document.createElement('span');
      s.setAttribute('role', 'slider');
      s.className = 'rz-pointer rz-pointer-min';
      s.setAttribute('tabindex', '0');
      s.setAttribute('aria-valuemin', String(step.slider.min));
      s.setAttribute('aria-valuemax', String(step.slider.max));
      s.setAttribute('aria-valuenow', String(step.slider.value));
      s.textContent = '●';
      // angularjs-slider's keyboard contract: arrows step by one, page keys by
      // 10% of the range, home/end jump to the bounds.
      s.addEventListener('keydown', function (ev) {
        var now = Number(s.getAttribute('aria-valuenow'));
        var min = Number(s.getAttribute('aria-valuemin'));
        var max = Number(s.getAttribute('aria-valuemax'));
        var page = Math.round((max - min) / 10);
        var next = now;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') next = now + 1;
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') next = now - 1;
        else if (ev.key === 'PageUp') next = now + page;
        else if (ev.key === 'PageDown') next = now - page;
        else if (ev.key === 'Home') next = min;
        else if (ev.key === 'End') next = max;
        else return;
        ev.preventDefault();
        next = Math.max(min, Math.min(max, next));
        s.setAttribute('aria-valuenow', String(next));
        readout.textContent = String(next) + ' lbs';
      });
      el.appendChild(s);
      var readout = document.createElement('div');
      readout.className = 'rz-bubble';
      readout.textContent = String(step.slider.value) + ' lbs';
      el.appendChild(readout);
    }
    (step.choices || []).forEach(function (c) {
      var a = document.createElement('a');
      a.href = 'javascript:void(0)';
      a.textContent = c;
      a.onclick = function () { advance(); };
      el.appendChild(a);
      el.appendChild(document.createElement('br'));
    });
    if ((step.fields || step.slider) && !step.submit) {
      var next = document.createElement('a');
      next.href = 'javascript:void(0)';
      next.className = 'btn-next';
      next.textContent = 'Continue';
      next.onclick = function () { advance(); };
      el.appendChild(next);
    }
    if (step.submit) {
      var submit = document.createElement('a');
      submit.href = 'javascript:void(0)';
      submit.id = 'submitBtn';
      submit.textContent = 'Submit';
      submit.onclick = function () { window.location.href = '/thank-you'; };
      el.appendChild(submit);
    }
    return el;
  }

  var rendered = null;
  function render() {
    var hash = location.hash || STEPS[0].hash;
    var step = STEPS.filter(function (s) { return s.hash === hash; })[0] || STEPS[0];
    if (rendered === step.hash) return;
    // A real view swap: the previous step's controls leave the document.
    host.innerHTML = '';
    host.appendChild(build(step));
    rendered = step.hash;
  }
  function advance() {
    var hash = location.hash || STEPS[0].hash;
    var i = STEPS.findIndex(function (s) { return s.hash === hash; });
    if (i < STEPS.length - 1) location.hash = STEPS[i + 1].hash;
  }
  // Angular swaps the template a tick after the hash changes. Reproduce that
  // lag so the harness's step-settle handling is actually exercised.
  window.addEventListener('hashchange', function () { setTimeout(render, 150); });
  if (!location.hash) location.hash = STEPS[0].hash;
  render();
</script>`;

// A deliberately simple stand-in for the real TrustedForm script: it counts the
// key and input events the page emits and reports them back to its own origin,
// which is enough to prove the harness's capture + signal extraction path works.
const TRUSTEDFORM_JS = `(function () {
  var keys = 0, inputs = 0, start = Date.now();
  window.TrustedForm = { version: 'mock-offline-selftest' };
  document.addEventListener('keydown', function () { keys += 1; }, true);
  document.addEventListener('input', function () { inputs += 1; }, true);
  function certUrl() {
    var hex = '';
    for (var i = 0; i < 40; i++) hex += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return 'https://cert.trustedform.com/' + hex;
  }
  var assigned = null;
  function ping() {
    if (!assigned) {
      assigned = certUrl();
      var field = document.querySelector('input[name=xxTrustedFormCertUrl]');
      if (field) field.value = assigned;
    }
    var minutes = Math.max((Date.now() - start) / 60000, 1 / 60);
    try {
      var body = JSON.stringify({
        cert_url: assigned,
        kpm: Math.round(keys / minutes),
        wpm: Math.round((keys / 5) / minutes),
        events: { keydown: keys, input: inputs },
        page_url: location.href
      });
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/trustedform/ping', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
    } catch (e) { /* ignore */ }
  }
  setTimeout(ping, 1200);
  setInterval(ping, 4000);
})();`;

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/trustedform.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(TRUSTEDFORM_JS);
      return;
    }
    if (url === '/trustedform/ping') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let echo = {};
        try { echo = JSON.parse(body); } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          received: { wpm: echo.wpm ?? null, kpm: echo.kpm ?? null },
          ping_id: crypto.randomBytes(6).toString('hex'),
        }));
      });
      return;
    }
    if (url === '/thank-you') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><title>Thank you</title><h1>Thank you</h1><p>Your quote request was received.</p>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE.replace('__STEPS__', JSON.stringify(STEPS)));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port + '/' });
    });
  });
}

module.exports = { start, STEPS };

if (require.main === module) {
  start(Number(process.argv[2] || 0)).then(({ url }) => console.log('mock funnel: ' + url));
}
