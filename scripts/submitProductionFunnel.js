#!/usr/bin/env node
//
// Drive the LIVE production funnel at quotes.nationallifecoverage.org through an
// IPRoyal residential IP chosen to match the submitted ZIP, and prove that
// TrustedForm issued a certificate for that proxied session.
//
// This is a different target from scripts/submitWithResidentialProxy.js. That
// runner drives the Express/index.html app in this repository. The production
// hostname does NOT serve that app: it redirects (3 hops) to a hosted AngularJS
// funnel at /fv3/nationallifecoverage/1051/, whose DOM and step flow are
// completely different (#zipCode, not #zip; a 16-step hash-routed wizard, not a
// single page). Selectors here were read off the live page, not assumed.
//
// The IPRoyal targeting, ZIP resolution, sticky-session selection, TrustedForm
// wait and TrustedForm capture now live in scripts/lib/funnelCore.js so that
// scripts/behavioralTestRunner.js drives the same implementation rather than a
// copy of it. The flow below is unchanged.

require('dotenv').config();

const { chromium } = require('playwright-core');
const {
  TARGET_URL,
  PROXY_HOST,
  PROXY_PORT,
  IP_CHECK_URL,
  LAUNCH_ARGS,
  CSS_ID,
  arg,
  required,
  normalizeProxyToken,
  getZipTarget,
  selectResidentialSession,
  preflightProxy,
  waitForTrustedFormCert,
  attachTrustedFormCapture,
  writeCapture,
  certIdFromUrl,
  resolveBrowserPath,
  lookupIpGeo,
  buildAnswers,
  readStep,
  planField,
  isFinalStep,
  buildLead,
} = require('./lib/funnelCore');

// Deliver a step's planned values the way production always has: set the value
// directly. The behavioral harness types instead; see docs/behavioral-testing.md.
async function fillStepFields(page, fields, lead) {
  for (const field of fields) {
    const plan = planField(field, lead);
    if (!plan) continue;
    if (plan.kind === 'select') await page.locator(plan.selector).selectOption(plan.value).catch(() => {});
    else await page.locator(plan.selector).fill(plan.value).catch(() => {});
  }
}

const MAX_STEPS = Number(process.env.FUNNEL_MAX_STEPS || 30);

async function main() {
  const username = required('IPROYAL_PROXY_USERNAME', process.env.IPROYAL_PROXY_USERNAME);
  const basePassword = required('IPROYAL_PROXY_PASSWORD', process.env.IPROYAL_PROXY_PASSWORD);
  const zip = required('--zip', arg('zip', process.env.TEST_ZIP));
  const location = getZipTarget(zip);

  const lead = buildLead(location);
  const answers = buildAnswers();

  console.log(JSON.stringify({
    targetUrl: TARGET_URL,
    submittedZip: location.zip,
    resolvedCity: location.city,
    resolvedState: location.state,
    zipCentroid: { latitude: location.latitude, longitude: location.longitude },
    proxyHost: PROXY_HOST,
    proxyPort: PROXY_PORT,
  }, null, 2));

  // Account check first (402 = no balance, 407 = bad credentials).
  const probe = await preflightProxy({
    host: PROXY_HOST, port: PROXY_PORT, username, basePassword, location, ipCheckUrl: IP_CHECK_URL,
  });
  console.log('IPRoyal CONNECT preflight: HTTP ' + probe.statusCode + ' (tunnel established)');

  console.log('Selecting a residential session near ' + location.city + ', ' + location.state + ':');
  const selection = await selectResidentialSession({
    host: PROXY_HOST, port: PROXY_PORT, username, basePassword, location,
  });

  const browser = await chromium.launch({
    executablePath: resolveBrowserPath(),
    headless: process.env.HEADLESS !== 'false',
    args: LAUNCH_ARGS,
    proxy: {
      server: 'http://' + PROXY_HOST + ':' + PROXY_PORT,
      username,
      password: selection.password,
    },
  });

  let observedIp = null;
  let observedGeo = null;
  let trustedFormCertUrl = null;
  let finalUrl = null;
  let outcome = null;

  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago' });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    // --capture <file> records everything the browser exchanges with
    // TrustedForm, so the certificate's contents can be inspected afterwards.
    const capturePath = arg('capture', null);
    const captured = capturePath ? attachTrustedFormCapture(page) : null;

    await page.goto(IP_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    observedIp = (await page.locator('body').innerText()).trim();
    observedGeo = await lookupIpGeo(observedIp);
    console.log('Observed outbound browser IP through IPRoyal: ' + observedIp);
    if (observedGeo) {
      console.log('Observed IP location: ' + observedGeo.city + ', ' + observedGeo.regionName
        + ' (ISP: ' + observedGeo.isp + ', hosting: ' + observedGeo.hosting + ')');
    }

    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(4000);
    console.log('Funnel URL after redirects: ' + page.url());

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      const s = await page.evaluate(readStep);
      console.log('  step ' + step + ' ' + s.hash + (s.question ? '  "' + s.question + '"' : ''));

      const isFinal = isFinalStep(s.fields);
      await fillStepFields(page, s.fields, lead);

      if (isFinal) {
        trustedFormCertUrl = await waitForTrustedFormCert(page);
        console.log('  TrustedForm certificate: ' + trustedFormCertUrl);

        const submit = page.getByText('Submit', { exact: true }).first();
        if (!(await submit.count())) throw new Error('Submit control not found on ' + s.hash);
        await submit.click();
        await page.waitForTimeout(9000).catch(() => {});
        finalUrl = page.url();
        const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim();
        outcome = body.slice(0, 260);
        console.log('  post-submit URL: ' + finalUrl);
        console.log('  post-submit page: ' + outcome);

        const stillOnForm = /verify-information/.test(finalUrl)
          && await page.locator(CSS_ID('email')).isVisible().catch(() => false);
        if (stillOnForm) throw new Error('Funnel did not advance past the contact step: ' + outcome);
        break;
      }

      let clicked = false;
      const next = page.locator('a.btn-next').first();
      if (await next.count() && await next.isVisible().catch(() => false)) {
        await next.click().catch(() => {});
        clicked = true;
      } else {
        const wanted = answers[s.hash];
        const pick = (wanted && s.choices.find((c) => c.toLowerCase() === String(wanted).toLowerCase()))
          || (wanted && s.choices.find((c) => c.toLowerCase().startsWith(String(wanted).toLowerCase())))
          || s.choices[0];
        if (pick) {
          await page.getByText(pick, { exact: true }).first().click().catch(() => {});
          clicked = true;
          console.log('    -> ' + pick);
        }
      }
      if (!clicked) throw new Error('No control to advance step ' + s.hash);

      await page.waitForTimeout(2500);
      const after = await page.evaluate(() => location.hash || '#/');
      if (after === s.hash) throw new Error('Funnel stalled at ' + s.hash + ' (validation rejected the answer?)');
    }

    if (!trustedFormCertUrl) throw new Error('Never reached the contact step; no TrustedForm certificate captured.');

    const cityMatch = observedGeo && normalizeProxyToken(observedGeo.city) === normalizeProxyToken(location.city);
    const stateMatch = observedGeo && normalizeProxyToken(observedGeo.regionName) === normalizeProxyToken(location.stateName);

    console.log('');
    console.log('===== PRODUCTION FUNNEL RESIDENTIAL TEST RESULT =====');
    console.log('Target URL: ' + TARGET_URL);
    console.log('Resolved ZIP: ' + location.zip);
    console.log('Resolved City: ' + location.city);
    console.log('Resolved State: ' + location.state + ' (' + location.stateName + ')');
    console.log('Proxy Host: ' + PROXY_HOST + ':' + PROXY_PORT);
    console.log('Observed Browser Public IP: ' + observedIp);
    console.log('Observed IP Location: ' + (observedGeo ? observedGeo.city + ', ' + observedGeo.regionName : 'unknown'));
    console.log('Observed IP ISP: ' + (observedGeo ? observedGeo.isp : 'unknown'));
    console.log('IP matches submitted ZIP: ' + (cityMatch && stateMatch ? 'YES (city + state)' : stateMatch ? 'state only' : 'NO'));
    console.log('IPRoyal Targeting Used: ' + selection.tier);
    console.log('TrustedForm Certificate: ' + trustedFormCertUrl);
    console.log('TrustedForm Certificate ID: ' + certIdFromUrl(trustedFormCertUrl));
    console.log('Post-submit URL: ' + finalUrl);
    console.log('Post-submit page: ' + outcome);
    console.log('====================================================');
    console.log('');
    if (capturePath) {
      const count = writeCapture(capturePath, {
        certUrl: trustedFormCertUrl, observedIp, observedGeo, finalUrl, events: captured,
      });
      console.log('TrustedForm capture written to ' + capturePath + ' (' + count + ' events)');
    }
    console.log('Production funnel submission completed successfully.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exitCode = 1;
});
