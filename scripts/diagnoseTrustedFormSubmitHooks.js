#!/usr/bin/env node
'use strict';
//
// Why did the A/B captures contain no submit event in EITHER mode?
//
// Step 16 of the investigation plan: before changing any TrustedForm code,
// establish what the SDK actually does on this page. This probe answers three
// questions directly rather than inferring them from an absent event:
//
//   1. Which listeners does TrustedForm register, on which elements?
//      (cdn.trustedform.com/trustedform-1.12.10.js registers a "submit"
//      listener on every <form> and a "click" listener on every element
//      matching its submit-role selector list.)
//   2. Do those listeners actually run when the form is submitted?
//   3. Does the SDK put anything on the wire as a result?
//
// It hooks addEventListener to RECORD registrations and then calls through, so
// the page and the SDK behave exactly as they normally would. Nothing is
// blocked, replaced or stubbed.
//
// This is a diagnostic, not a lead submission: it fills nothing and submits
// nothing to /api-proxy/. It dispatches a submit event on the form and clicks
// the submit button with the form's own submission suppressed, purely to see
// whether TrustedForm's handlers fire.
//
// Usage:
//   node scripts/diagnoseTrustedFormSubmitHooks.js [--url <page>] [--mode ajax|native]

require('dotenv').config();

const { chromium } = require('playwright-core');
const {
  arg,
  hasFlag,
  resolveBrowserPath,
  LAUNCH_ARGS,
  attachTrustedFormCapture,
  proxyCredentialsFromEnv,
  selectResidentialSession,
  getZipTarget,
  PROXY_HOST,
  PROXY_PORT,
} = require('./lib/funnelCore');
const { decodeEventBody } = require('./lib/tfEvents');

const BASE_URL = arg('url', process.env.TRUSTEDFORM_TARGET_URL);
const MODE = String(arg('mode', 'ajax')).toLowerCase();

// Recorded in the page, read back afterwards. Kept on window so it survives the
// SDK loading asynchronously well after this script runs.
const INSTRUMENT = () => {
  window.__tfProbe = { registrations: [], fired: [] };

  const describe = (target) => {
    if (target === window) return 'window';
    if (target === document) return 'document';
    if (!target || !target.tagName) return String(target);
    return (
      target.tagName.toLowerCase() +
      (target.id ? '#' + target.id : '') +
      (target.getAttribute && target.getAttribute('data-tf-element-role')
        ? '[role=' + target.getAttribute('data-tf-element-role') + ']'
        : '') +
      (target.getAttribute && target.getAttribute('type')
        ? '[type=' + target.getAttribute('type') + ']'
        : '')
    );
  };

  // Attribute a registration to whoever registered it. The TrustedForm SDK is
  // the only script on the page served from cdn.trustedform.com, so a stack
  // frame naming that host identifies it unambiguously.
  const originIsTrustedForm = () => {
    const stack = new Error().stack || '';
    return /trustedform/i.test(stack);
  };

  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'submit' || type === 'click') {
      const record = {
        type,
        target: describe(this),
        trustedForm: originIsTrustedForm(),
      };
      window.__tfProbe.registrations.push(record);
      const wrapped = function (event) {
        window.__tfProbe.fired.push({
          type,
          target: record.target,
          trustedForm: record.trustedForm,
          defaultPrevented: event.defaultPrevented,
          at: Date.now(),
        });
        return listener.apply(this, arguments);
      };
      return original.call(this, type, wrapped, options);
    }
    return original.call(this, type, listener, options);
  };
};

async function main() {
  if (!BASE_URL) throw new Error('Pass --url or set TRUSTEDFORM_TARGET_URL');
  const url = new URL(BASE_URL);
  if (MODE === 'native') url.searchParams.set('submission-mode', 'native');

  // --proxy routes this probe through the same residential session the A/B runs
  // use. It is the last uncontrolled difference between this probe (which sees
  // TrustedForm flush a submission event) and the proxied A/B runs (which do
  // not), so it has to be testable here.
  let proxy;
  if (hasFlag('proxy')) {
    const { username, basePassword } = proxyCredentialsFromEnv();
    const location = getZipTarget(arg('zip', process.env.TEST_ZIP));
    const selection = await selectResidentialSession({
      host: PROXY_HOST, port: PROXY_PORT, username, basePassword, location,
    });
    proxy = {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      username: selection.username,
      password: selection.password,
    };
    console.log('routing through the residential proxy');
  }

  const browser = await chromium.launch({
    executablePath: resolveBrowserPath(),
    headless: process.env.HEADLESS !== 'false',
    args: LAUNCH_ARGS,
    ...(proxy ? { proxy } : {}),
  });

  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York' });
    // Runs before any page script, so the hook is in place before the
    // TrustedForm loader inserts its <script>.
    await context.addInitScript(INSTRUMENT);

    const page = await context.newPage();
    const captured = attachTrustedFormCapture(page);
    page.setDefaultTimeout(45_000);

    console.log('probing: ' + url.toString() + '  (mode=' + MODE + ')');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const f = document.querySelector('#xxTrustedFormCertUrl');
      return f && /^https?:\/\//i.test(f.value || '');
    }, { timeout: 45_000 });
    const cert = await page.locator('#xxTrustedFormCertUrl').inputValue();
    console.log('certificate: ' + cert);

    // Let the SDK finish its DOM scan and attach whatever it attaches.
    await page.waitForTimeout(Number(process.env.PROBE_SETTLE_MS || 6000));

    // Every control on this form is `required`. An empty form therefore fails
    // HTML5 constraint validation on click, and the browser never dispatches a
    // submit event at all -- so an unfilled probe can only ever exercise the
    // click path. Fill it so the submit event genuinely fires.
    // --fill-mode playwright reproduces exactly how the A/B runner enters values
    // (locator.fill / locator.selectOption). --fill-mode script sets the values
    // from page JavaScript. These are the last uncontrolled difference between
    // this probe and the runner, so the probe has to be able to do both.
    const fillMode = String(arg('fill-mode', 'script')).toLowerCase();
    if (fillMode === 'playwright') {
      for (const el of await page.locator('#quote-form select').all()) {
        const value = await el.locator('option').nth(1).getAttribute('value');
        await el.selectOption(value);
      }
      await page.locator('#zip').fill('07302');
      await page.locator('#date_of_birth').fill('1982-07-09');
      await page.locator('#address').fill('88 Morgan St');
      await page.locator('#fname').fill('Probe');
      await page.locator('#lname').fill('Probe');
      await page.locator('#email').fill('probe@example.com');
      await page.locator('#phone').fill('5513326220');
      await page.locator('#weight').fill('160');
    } else await page.evaluate(() => {
      const set = (el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      for (const el of document.querySelectorAll('#quote-form select')) {
        const option = [...el.options].find((o) => o.value !== '');
        if (option) set(el, option.value);
      }
      for (const el of document.querySelectorAll('#quote-form input')) {
        if (el.type === 'hidden' || el.value) continue;
        if (el.id === 'zip') set(el, '07302');
        else if (el.type === 'date') set(el, '1982-07-09');
        else if (el.type === 'email') set(el, 'probe@example.com');
        else if (el.type === 'tel') set(el, '5513326220');
        else if (el.type === 'number') set(el, '160');
        else set(el, 'probe');
      }
    });
    console.log('form validity: ' + await page.evaluate(
      () => document.querySelector('#quote-form').checkValidity(),
    ));

    const before = await page.evaluate(() => ({
      registrations: window.__tfProbe.registrations,
      fired: window.__tfProbe.fired.length,
    }));
    console.log('');
    console.log('-- submit/click listeners registered on this page --');
    for (const r of before.registrations) {
      console.log(`  ${r.trustedForm ? 'TRUSTEDFORM' : 'page       '}  ${r.type.padEnd(7)} on ${r.target}`);
    }
    if (!before.registrations.length) console.log('  (none recorded)');

    const eventsBefore = captured.filter((e) => e.dir === 'REQ' && /\/events/.test(e.url)).length;

    // Fire the real thing: click the real submit button. The form's own
    // submission is suppressed for the duration so this probe cannot create a
    // lead; the submit EVENT still dispatches, which is what TrustedForm hooks.
    await page.evaluate(() => {
      document.querySelector('#quote-form').addEventListener(
        'submit',
        (e) => e.preventDefault(),
        { capture: false },
      );
    });
    await page.locator('#submit-button').click();
    await page.waitForTimeout(Number(process.env.PROBE_FLUSH_MS || 20000));

    const after = await page.evaluate(() => window.__tfProbe.fired);
    console.log('');
    console.log('-- listeners that FIRED on the submit --');
    for (const f of after) {
      console.log(`  ${f.trustedForm ? 'TRUSTEDFORM' : 'page       '}  ${f.type.padEnd(7)} on ${f.target}`
        + `  defaultPrevented=${f.defaultPrevented}`);
    }
    if (!after.length) console.log('  (none fired)');

    const eventsAfter = captured.filter((e) => e.dir === 'REQ' && /\/events/.test(e.url));
    console.log('');
    console.log(`-- TrustedForm /events POSTs: ${eventsBefore} before the submit, `
      + `${eventsAfter.length - eventsBefore} after --`);
    for (const e of eventsAfter.slice(eventsBefore)) {
      const envelope = JSON.parse(e.post);
      const text = decodeEventBody(envelope.body);
      console.log('   post-submit payload: ' + text.slice(0, 400));
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exit(1);
});
