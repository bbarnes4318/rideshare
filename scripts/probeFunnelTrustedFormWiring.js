#!/usr/bin/env node
'use strict';
//
// READ-ONLY probe of the LIVE affiliate funnel at quotes.nationallifecoverage.org.
// Walks to the contact step and STOPS. Never clicks Submit, never creates a lead.
//
// Re-verifies, against the live page, the facts the submission-event conclusion
// rests on: what the Submit control actually is, whether anything wraps or
// submits the contact fields, whether the loader carries use_tagged_consent, and
// whether any data-tf-element-role tags exist. See
// docs/trustedform-submission-event.md.
//
// Run it before repeating any claim in that document -- the funnel is the
// affiliate network's code and can change without notice.
//
//   node scripts/probeFunnelTrustedFormWiring.js
require('dotenv').config();
const { chromium } = require('playwright-core');
const core = require('./lib/funnelCore');

const say = (...a) => { console.log(...a); };

(async () => {
  const browser = await chromium.launch({
    executablePath: core.resolveBrowserPath(), headless: true, args: core.LAUNCH_ARGS,
  });
  const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
  page.setDefaultTimeout(30000);

  // networkidle never settles on this host (Cloudflare + tag managers hold
  // connections open), which is what hung the first attempt.
  await page.goto('https://quotes.nationallifecoverage.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  say('landed on: ' + page.url());

  say('');
  say('-- TrustedForm loader on the live funnel --');
  const tfScripts = await page.evaluate(() =>
    [...document.querySelectorAll('script')].map(s => s.src).filter(s => /trustedform/i.test(s)));
  say(tfScripts.length ? tfScripts.join('\n') : '(no trustedform script tag found)');
  say('use_tagged_consent present: ' + tfScripts.some(s => /use_tagged_consent/i.test(s)));

  const answers = core.buildAnswers();
  const lead = { zip: '07302', birthMonth: 7, birthDay: '9', birthYear: '1982',
    height: '70', weight: '160', address: '88 Morgan St',
    // The contact fields stay empty on purpose. isFinalStep() fires on the step
    // that carries them, so the walk stops before any identity value is typed
    // and long before Submit -- no lead is created by this probe.
    fname: '', lname: '', email: '', phone: '' };

  // Mirror scripts/submitProductionFunnel.js's advance logic exactly: prefer
  // a.btn-next, else getByText(choice, {exact:true}). getByRole('link') does not
  // match these controls, which is what stalled the first attempt at #/gender.
  let reached = false;
  for (let i = 1; i <= 30; i++) {
    const step = await page.evaluate(core.readStep);
    say('step ' + i + ': ' + step.hash + '  fields=' + step.fields.length + '  choices=' + JSON.stringify(step.choices));
    if (core.isFinalStep(step.fields)) { reached = true; say('-> contact step reached; STOPPING (never clicking Submit)'); break; }

    for (const f of step.fields) {
      const plan = core.planField(f, lead);
      if (!plan || !plan.value) continue;
      if (plan.kind === 'select') await page.locator(plan.selector).selectOption(plan.value).catch(() => {});
      else await page.locator(plan.selector).fill(plan.value).catch(() => {});
    }

    const next = page.locator('a.btn-next').first();
    if (await next.count() && await next.isVisible().catch(() => false)) {
      await next.click().catch(() => {});
    } else {
      const wanted = answers[step.hash];
      const pick = (wanted && step.choices.find((c) => c.toLowerCase() === String(wanted).toLowerCase()))
        || (wanted && step.choices.find((c) => c.toLowerCase().startsWith(String(wanted).toLowerCase())))
        || step.choices[0];
      if (!pick) { say('-> no control to advance ' + step.hash); break; }
      await page.getByText(pick, { exact: true }).first().click().catch(() => {});
      say('    -> ' + pick);
    }

    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => location.hash || '#/');
    if (after === step.hash) { say('-> stalled at ' + step.hash); break; }
  }

  if (reached) {
    say('');
    say('-- every anchor/button whose text is Submit, as it exists live --');
    say(await page.evaluate(() => [...document.querySelectorAll('a,button,input')]
      .filter(e => /^submit$/i.test((e.textContent || e.value || '').trim()))
      .map(e => e.outerHTML.slice(0, 500)).join('\n\n') || '(none on this step)'));

    say('');
    say('-- is there a <form> around the contact fields? --');
    say(await page.evaluate(() => {
      const email = document.querySelector('input[type=email], input[name*=mail i]');
      if (!email) return 'no email field found';
      const form = email.closest('form');
      return form ? 'YES -- <form> ancestor: ' + form.outerHTML.slice(0, 250) : 'NO <form> ancestor';
    }));

    say('');
    say('-- TrustedForm cert field on the contact step --');
    say(await page.evaluate(() => {
      const f = document.querySelector('input[name=xxTrustedFormCertUrl]');
      return f ? f.outerHTML.slice(0, 200) + '   value=' + (f.value ? 'POPULATED' : 'EMPTY') : '(no cert field)';
    }));
  }

  say('');
  say('-- data-tf-element-role attributes on the DOM as it now stands --');
  say(await page.evaluate(() => [...document.querySelectorAll('[data-tf-element-role]')]
    .map(e => e.tagName + '[' + e.getAttribute('data-tf-element-role') + ']').join(', ') || '(none)'));

  say('');
  say('PROBE COMPLETE');
  await browser.close();
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
