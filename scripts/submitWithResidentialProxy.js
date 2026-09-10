#!/usr/bin/env node

require('dotenv').config();

const { chromium } = require('playwright-core');
const { LISTENER_PROBE, readListenerProbe } = require('./lib/listenerProbe');
const {
  PROXY_PROVIDER,
  PROXY_HOST,
  PROXY_PORT,
  IP_CHECK_URL,
  LAUNCH_ARGS,
  arg,
  required,
  normalizeProxyToken,
  getZipTarget,
  proxyCredentialsFromEnv,
  selectResidentialSession,
  preflightProxy,
  resolveBrowserPath,
  lookupIpGeo,
  attachTrustedFormCapture,
  writeCapture,
  certIdFromUrl,
} = require('./lib/funnelCore');

// This runner drives the Express/index.html app in THIS repository, whose form
// is a single page with #zip / #gender / #submit-button ids. The production
// funnel at quotes.nationallifecoverage.org serves something else entirely -
// see scripts/submitProductionFunnel.js for that one. Only the DOM handling
// below is specific to this app; the ZIP resolution, provider targeting and
// sticky-session selection are the shared ones in lib/funnelCore.js, so this
// runner can no longer drift away from the runner that is actually in use.
const TARGET_URL = process.env.TRUSTEDFORM_TARGET_URL || 'https://quotes.nationallifecoverage.org/';

// Which submission mechanism the page should use for this run.
//
//   ajax   (default) - index.html cancels the submit event and POSTs JSON with
//                      fetch(). This is production behaviour and the control.
//   native           - no JavaScript touches the submit event; the browser
//                      performs the form's own POST to action="/api-proxy/".
//
// The page picks its mechanism from ?submission-mode, so both variants are the
// same document, the same fields, the same consent text, the same TrustedForm
// tags and the same SDK. Only the submit event differs, which is the whole
// point of the A/B: see docs/trustedform-submission-event.md.
const SUBMISSION_MODES = ['ajax', 'native'];

function resolveSubmissionMode() {
  const mode = String(arg('submission-mode', 'ajax')).toLowerCase();
  if (!SUBMISSION_MODES.includes(mode)) {
    throw new Error(`--submission-mode must be one of ${SUBMISSION_MODES.join('|')}, got "${mode}"`);
  }
  return mode;
}

function targetUrlForMode(mode) {
  if (mode === 'ajax') return TARGET_URL;
  const url = new URL(TARGET_URL);
  url.searchParams.set('submission-mode', 'native');
  return url.toString();
}

// The form's own submit handler emits MM/DD/YYYY, but the DOM control is an
// <input type="date">, which only accepts YYYY-MM-DD via fill(). Convert here so
// the CLI can keep taking --dob in MM/DD/YYYY.
function toDateInputValue(value) {
  const raw = String(value).trim();
  const slashed = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashed) {
    const [, month, day, year] = slashed;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  throw new Error(`Unsupported --dob value "${raw}". Use MM/DD/YYYY or YYYY-MM-DD.`);
}

async function getBrowserObservedIp(page) {
  // Use the browser page itself so this check follows the exact same proxy path
  // as the TrustedForm page and its third-party scripts.
  await page.goto(IP_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  return (await page.locator('body').innerText()).trim();
}

async function waitForTrustedFormCert(page) {
  await page.waitForFunction(() => {
    const field = document.querySelector('#xxTrustedFormCertUrl');
    return field && /^https?:\/\//i.test(field.value || '');
  }, { timeout: 20_000 });

  return page.locator('#xxTrustedFormCertUrl').inputValue();
}

async function main() {
  const { username, basePassword } = proxyCredentialsFromEnv();
  const submissionMode = resolveSubmissionMode();
  const pageUrl = targetUrlForMode(submissionMode);
  // --capture <file> records everything the browser exchanges with TrustedForm,
  // using the same listeners the production funnel runner installs.
  const capturePath = arg('capture', null);
  const zip = required('--zip', arg('zip', process.env.TEST_ZIP));

  const location = getZipTarget(zip);

  const payload = {
    zip: location.zip,
    gender: required('--gender', arg('gender', process.env.TEST_GENDER || 'Male')),
    date_of_birth: required('--dob', arg('dob', process.env.TEST_DOB)),
    currently_insured: required('--currently-insured', arg('currently-insured', process.env.TEST_CURRENTLY_INSURED || 'No')),
    credit_rating: required('--credit-rating', arg('credit-rating', process.env.TEST_CREDIT_RATING || 'good')),
    marital: required('--marital', arg('marital', process.env.TEST_MARITAL || 'No')),
    homeowner: required('--homeowner', arg('homeowner', process.env.TEST_HOMEOWNER || 'Yes')),
    military: required('--military', arg('military', process.env.TEST_MILITARY || 'No')),
    tobacco_use: required('--tobacco', arg('tobacco', process.env.TEST_TOBACCO || 'No')),
    cancer: required('--cancer', arg('cancer', process.env.TEST_CANCER || 'No')),
    heart_disease: required('--heart-disease', arg('heart-disease', process.env.TEST_HEART_DISEASE || 'No')),
    coverage_amount: required('--coverage', arg('coverage', process.env.TEST_COVERAGE || '$25,000')),
    height: required('--height', arg('height', process.env.TEST_HEIGHT || '70')),
    weight: required('--weight', arg('weight', process.env.TEST_WEIGHT || '160')),
    address: required('--address', arg('address', process.env.TEST_ADDRESS)),
    fname: required('--fname', arg('fname', process.env.TEST_FNAME)),
    lname: required('--lname', arg('lname', process.env.TEST_LNAME)),
    email: required('--email', arg('email', process.env.TEST_EMAIL)),
    phone: required('--phone', arg('phone', process.env.TEST_PHONE)),
  };

  console.log(JSON.stringify({
    targetUrl: pageUrl,
    submissionMode,
    submittedZip: location.zip,
    resolvedCity: location.city,
    resolvedState: location.state,
    zipCentroid: { latitude: location.latitude, longitude: location.longitude },
    proxyProvider: PROXY_PROVIDER.id,
    proxyHost: PROXY_HOST,
    proxyPort: PROXY_PORT,
  }, null, 2));

  // Server-side diagnostic first: distinguishes an account/credential problem
  // from a browser problem before Chromium is even started.
  const probe = await preflightProxy({
    host: PROXY_HOST, port: PROXY_PORT, username, basePassword, location, ipCheckUrl: IP_CHECK_URL,
  });
  console.log(`${PROXY_PROVIDER.id} CONNECT preflight: HTTP ${probe.statusCode} (tunnel established)`);

  console.log(`Selecting a residential session near ${location.city}, ${location.state}:`);
  const selection = await selectResidentialSession({
    host: PROXY_HOST,
    port: PROXY_PORT,
    username,
    basePassword,
    location,
  });

  const browser = await chromium.launch({
    executablePath: resolveBrowserPath(),
    headless: process.env.HEADLESS !== 'false',
    // Shared-CPU host: keep Chromium to a single lightweight instance.
    args: LAUNCH_ARGS,
    proxy: {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      // Both halves from the selection - Geonode's and Shifter's targeting and
      // sticky session id live in the username, so the account username alone
      // would silently egress from somewhere other than the IP just verified.
      username: selection.username,
      password: selection.password,
    },
  });

  try {
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ignoreHTTPSErrors: false,
    });

    // --probe-listeners records which submit/click listeners get registered on
    // this page and which of them actually run, so a run that produces no
    // TrustedForm submission event can be told apart from one where the SDK
    // never attached a handler in the first place. Off by default: it wraps
    // addEventListener, and the A/B captures themselves must be uninstrumented.
    const probeListeners = process.argv.includes('--probe-listeners');
    if (probeListeners) await context.addInitScript(LISTENER_PROBE);

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    const observedIp = await getBrowserObservedIp(page);
    console.log(`Observed outbound browser IP through ${PROXY_PROVIDER.id}: ${observedIp}`);

    // A gateway widens the pool silently when the requested city has no peers,
    // so report where the egress IP actually landed instead of assuming the
    // city/state target was honoured.
    const observedGeo = await lookupIpGeo(observedIp);
    let geoTargetMatch = selection.match;
    if (observedGeo) {
      const cityMatch = normalizeProxyToken(observedGeo.city) === normalizeProxyToken(location.city);
      const stateMatch = normalizeProxyToken(observedGeo.regionName) === normalizeProxyToken(location.stateName);
      if (cityMatch && stateMatch) geoTargetMatch = 'city + state matched';
      else if (stateMatch) geoTargetMatch = 'state matched, city did not';
      else geoTargetMatch = 'NOT matched - the gateway fell back to a wider pool';
      console.log(`Observed IP location: ${observedGeo.city}, ${observedGeo.regionName}, ${observedGeo.country}`
        + ` (ISP: ${observedGeo.isp}, hosting: ${observedGeo.hosting})`);
      console.log(`Geo target result: ${geoTargetMatch}`);
    }

    const captured = capturePath ? attachTrustedFormCapture(page) : null;

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

    // Confirm the page really is running the mechanism this run asked for,
    // before a single field is filled. Reading it back off the document means a
    // stale deployment or a dropped query parameter fails here rather than
    // producing a run labelled "native" that in fact ran the AJAX path.
    const pageSubmissionMode = await page.evaluate(() => ({
      mode: typeof SUBMISSION_MODE === 'string' ? SUBMISSION_MODE : null,
      action: document.querySelector('#quote-form')?.getAttribute('action') || null,
      method: document.querySelector('#quote-form')?.getAttribute('method') || null,
    }));
    console.log(`Page reports submission mode: ${JSON.stringify(pageSubmissionMode)}`);
    if (pageSubmissionMode.mode !== submissionMode) {
      throw new Error(
        `Requested --submission-mode ${submissionMode} but the page is running `
        + `"${pageSubmissionMode.mode}". The deployed index.html is not the A/B build.`
      );
    }

    // TrustedForm runs in this browser session, so its network observations use
    // the same residential proxy as the page and its third-party requests.
    //
    // Wait for the certificate BEFORE touching a field. This used to run
    // concurrently with the fill, and that is what made the first A/B captures
    // unreadable: the runner began filling a few hundred milliseconds after
    // domcontentloaded, while the SDK was still loading, and the resulting
    // sessions recorded the page-load events and then never flushed another
    // batch -- no field entry, no click, no submission -- even when the
    // instrumented run proved TrustedForm's own submit handler had fired.
    // Letting the SDK finish initialising first produces a complete event
    // stream, and it is also closer to a real visitor, who does not start
    // typing before the page has finished loading. Both variants do this, so
    // the A/B stays controlled.
    const trustedFormCertUrl = await waitForTrustedFormCert(page);
    console.log(`TrustedForm certificate URL: ${trustedFormCertUrl}`);
    await page.waitForTimeout(Number(process.env.AB_SDK_SETTLE_MS || 4000));

    await page.locator('#zip').fill(payload.zip);
    await page.locator('#gender').selectOption({ label: payload.gender });
    await page.locator('#date_of_birth').fill(toDateInputValue(payload.date_of_birth));
    await page.locator('#currently_insured').selectOption(payload.currently_insured);
    await page.locator('#credit_rating').selectOption(payload.credit_rating);
    await page.locator('#marital').selectOption(payload.marital);
    await page.locator('#homeowner').selectOption(payload.homeowner);
    await page.locator('#military').selectOption(payload.military);
    await page.locator('#tobacco_use').selectOption(payload.tobacco_use);
    await page.locator('#cancer').selectOption(payload.cancer);
    await page.locator('#heart_disease').selectOption(payload.heart_disease);
    await page.locator('#coverage_amount').selectOption(payload.coverage_amount);
    await page.locator('#height').selectOption(payload.height);
    await page.locator('#weight').evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, payload.weight);
    await page.locator('#address').fill(payload.address);
    await page.locator('#fname').fill(payload.fname);
    await page.locator('#lname').fill(payload.lname);
    await page.locator('#email').fill(payload.email);
    await page.locator('#phone').fill(payload.phone);

    // Watch the POST to /api-proxy/ itself, so the report can state whether the
    // request actually left the browser and how it was encoded, rather than
    // inferring a submission from the message that appears afterwards.
    const apiRequestPromise = page
      .waitForRequest((req) => req.method() === 'POST' && /\/api-proxy\//.test(req.url()), { timeout: 30_000 })
      .catch(() => null);

    const submitClickedAt = new Date().toISOString();
    await page.locator('#submit-button').click();

    if (submissionMode === 'native') {
      // The browser is navigating. Waiting on the old document's DOM would race
      // the teardown of its execution context, so wait for the navigation.
      await page.waitForLoadState('load', { timeout: 30_000 });
    } else {
      await page.waitForFunction(() => {
        const el = document.querySelector('#response-message');
        return !!el && el.innerText.trim().length > 0;
      }, { timeout: 30_000 });
    }

    if (probeListeners) {
      const probe = await readListenerProbe(page);
      console.log('');
      console.log('-- submit/click listeners registered --');
      for (const r of probe.registrations) {
        console.log(`   ${r.trustedForm ? 'TRUSTEDFORM' : 'page       '}  ${r.type.padEnd(7)} on ${r.target}`);
      }
      console.log('-- listeners that fired --');
      for (const f of probe.fired) {
        console.log(`   ${f.trustedForm ? 'TRUSTEDFORM' : 'page       '}  ${f.type.padEnd(7)} on ${f.target}`
          + `  defaultPrevented=${f.defaultPrevented}`);
      }
      if (!probe.fired.length) console.log('   (none fired)');
      console.log('-- requests the page attempted to TrustedForm --');
      for (const a of probe.attempts || []) {
        console.log(`   ${a.via.padEnd(7)} ${a.bytes.toString().padStart(7)}b  ${a.url}`);
      }
      console.log('');
    }

    const apiRequest = await apiRequestPromise;
    const apiRequestSummary = apiRequest
      ? {
          method: apiRequest.method(),
          url: apiRequest.url(),
          contentType: apiRequest.headers()['content-type'] || null,
          // Whether the browser could attach an Authorization header at all is
          // one of the things that differs between the two mechanisms.
          hasAuthorizationHeader: Boolean(apiRequest.headers().authorization),
          postDataBytes: (apiRequest.postData() || '').length,
        }
      : null;
    console.log(`POST /api-proxy/ observed: ${JSON.stringify(apiRequestSummary)}`);

    // TrustedForm flushes its event stream asynchronously, and the native
    // variant tears the page down at exactly that moment. Give both variants
    // the same settle window so neither capture is cut short relative to the
    // other -- an unequal wait here would be a second variable.
    const settleMs = Number(process.env.AB_SETTLE_MS || 8000);
    await page.waitForTimeout(settleMs);

    const responseMessage = (await page.locator('#response-message').innerText()).trim();
    console.log(`Form response: ${responseMessage}`);
    console.log(`Final page URL: ${page.url()}`);

    if (!/^✓\s*Request received/i.test(responseMessage)) {
      throw new Error(`Form submission did not report success: ${responseMessage}`);
    }

    console.log('');
    console.log('===== RESIDENTIAL-PROXY TRUSTEDFORM TEST RESULT =====');
    console.log(`Resolved ZIP: ${location.zip}`);
    console.log(`Resolved City: ${location.city}`);
    console.log(`Resolved State: ${location.state} (${location.stateName})`);
    console.log(`Proxy Provider: ${PROXY_PROVIDER.id}${selection.strict ? ' (strict targeting)' : ''}`);
    console.log(`Proxy Host: ${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`Observed Browser Public IP: ${observedIp}`);
    console.log(`Observed IP Location: ${observedGeo ? `${observedGeo.city}, ${observedGeo.regionName}` : 'unknown'}`);
    console.log(`Observed IP ISP: ${observedGeo ? observedGeo.isp : 'unknown'}`);
    console.log(`Geo Target Result: ${geoTargetMatch}`);
    console.log(`Targeting Used: ${selection.tier}`);
    console.log(`Submission Mode: ${submissionMode}`);
    console.log(`Page URL: ${pageUrl}`);
    console.log(`TrustedForm Certificate: ${trustedFormCertUrl}`);
    console.log(`TrustedForm Certificate ID: ${certIdFromUrl(trustedFormCertUrl)}`);
    console.log(`Submit Clicked At: ${submitClickedAt}`);
    console.log(`Form Response:`);
    console.log(`${responseMessage}`);
    console.log('====================================================');

    if (capturePath) {
      const count = writeCapture(capturePath, {
        certUrl: trustedFormCertUrl,
        observedIp,
        observedGeo,
        finalUrl: page.url(),
        events: captured,
      });
      // Everything the comparison needs that is not a TrustedForm event lives
      // alongside the capture, so a run is self-describing after the fact.
      const meta = {
        submissionMode,
        pageUrl,
        submitClickedAt,
        apiRequest: apiRequestSummary,
        responseMessage,
        proxyProvider: PROXY_PROVIDER.id,
        proxyIp: observedIp,
        proxyIpLocation: observedGeo ? `${observedGeo.city}, ${observedGeo.regionName}` : null,
        zip: location.zip,
        city: location.city,
        state: location.state,
      };
      require('fs').writeFileSync(capturePath.replace(/\.json$/, '') + '.meta.json', JSON.stringify(meta, null, 2));
      console.log(`TrustedForm capture written to ${capturePath} (${count} events)`);
    }
    console.log('');
    console.log('Residential-proxy TrustedForm submission completed successfully.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
