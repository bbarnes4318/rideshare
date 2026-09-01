#!/usr/bin/env node
'use strict';

//
// Read the live funnel's actual answer vocabulary: the exact text of every
// choice control and the exact option values of every select, step by step.
//
// The batch harness has to map experimental distributions (credit tier, height,
// ...) onto whatever strings this form really uses, and guessing them is how a
// run silently ends up selecting the first option instead of the intended one.
//
// This never submits: it stops at the contact step, so no lead is created. It
// also runs without the proxy by default, because the vocabulary is static and
// there is no reason to spend residential traffic reading it.
//

require('dotenv').config();

const { chromium } = require('playwright-core');
const core = require('./lib/funnelCore');

const MAX_STEPS = Number(process.env.FUNNEL_MAX_STEPS || 30);

async function main() {
  const browser = await chromium.launch({
    executablePath: core.resolveBrowserPath(),
    headless: process.env.HEADLESS !== 'false',
    args: core.LAUNCH_ARGS,
  });

  try {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago' });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    await page.goto(core.TARGET_URL, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(4000);
    console.log('funnel: ' + page.url());
    console.log('');

    const lead = {
      zip: core.arg('zip', '07302'),
      birthMonth: 7, birthDay: '09', birthYear: '1982',
      height: '70', weight: '160', address: '88 Morgan St',
      fname: 'Probe', lname: 'ReadOnly',
      email: 'probe@example.com', phone: '5555555555',
    };
    const answers = core.buildAnswers();

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      const s = await page.evaluate(core.readStep);

      if (core.isFinalStep(s.fields)) {
        console.log('step ' + step + '  ' + s.hash + '   [contact step - stopping, nothing submitted]');
        break;
      }

      console.log('step ' + step + '  ' + s.hash + (s.question ? '   "' + s.question + '"' : ''));
      for (const f of s.fields) {
        const id = f.id || f.name;
        if (f.tag === 'select') {
          const opts = (f.opts || []).filter((v) => v !== '');
          console.log('    select ' + id + '  (' + opts.length + ' options)');
          console.log('      ' + JSON.stringify(opts.slice(0, 40)));
        } else {
          console.log('    input  ' + id + '  type=' + f.type + (f.ph ? '  placeholder="' + f.ph + '"' : ''));
        }
      }
      if (s.choices.length) console.log('    choices ' + JSON.stringify(s.choices));

      // --deep <hash>: full control inventory for one step, hidden ones too.
      // readStep only reports visible fields, so a control that is present but
      // not matched by it (a slider, a custom widget) is invisible in the normal
      // listing and silently never gets a value.
      if (core.arg('deep', null) && s.hash === core.arg('deep')) {
        const deep = await page.evaluate(() => {
          const vis = (e) => !!(e.offsetParent || e.getClientRects().length);
          return [...document.querySelectorAll('input,select,textarea,[role=slider],[ng-model]')].map((e) => ({
            tag: e.tagName.toLowerCase(),
            type: e.type || null,
            id: e.id || null,
            name: e.name || null,
            ngModel: e.getAttribute('ng-model'),
            role: e.getAttribute('role'),
            min: e.min || null,
            max: e.max || null,
            step: e.step || null,
            value: typeof e.value === 'string' ? e.value.slice(0, 40) : null,
            visible: vis(e),
            cls: (e.className || '').toString().slice(0, 60),
            ariaMin: e.getAttribute('aria-valuemin'),
            ariaMax: e.getAttribute('aria-valuemax'),
            ariaNow: e.getAttribute('aria-valuenow'),
            tabIndex: e.getAttribute('tabindex'),
          }));
        });
        const readout = await page.evaluate(() => {
          const el = [...document.querySelectorAll('.rz-bubble,.rz-model-value,span,div')]
            .filter((e) => (e.offsetParent || e.getClientRects().length)
              && /^\s*\d{2,3}\s*(lbs?|pounds)?\s*$/i.test(e.textContent || ''))
            .map((e) => (e.textContent || '').trim());
          return [...new Set(el)].slice(0, 6);
        });
        console.log('      numeric readouts on page: ' + JSON.stringify(readout));
        console.log('    --- deep inventory of ' + s.hash + ' ---');
        for (const c of deep) console.log('      ' + JSON.stringify(c));
        console.log('    --- end deep ---');
      }

      // Advance exactly the way the proven runner does.
      for (const f of s.fields) {
        const plan = core.planField(f, lead);
        if (!plan) continue;
        if (plan.kind === 'select') await page.locator(plan.selector).selectOption(plan.value).catch(() => {});
        else await page.locator(plan.selector).fill(plan.value).catch(() => {});
      }

      const next = page.locator('a.btn-next').first();
      if (await next.count() && await next.isVisible().catch(() => false)) {
        await next.click().catch(() => {});
      } else {
        const wanted = answers[s.hash];
        const pick = (wanted && s.choices.find((c) => c.toLowerCase() === String(wanted).toLowerCase()))
          || (wanted && s.choices.find((c) => c.toLowerCase().startsWith(String(wanted).toLowerCase())))
          || s.choices[0];
        if (!pick) { console.log('    !! no control to advance'); break; }
        await page.getByText(pick, { exact: true }).first().click().catch(() => {});
      }

      await page.waitForTimeout(2500);
      const after = await page.evaluate(() => location.hash || '#/');
      if (after === s.hash) { console.log('    !! stalled at ' + s.hash); break; }
      console.log('');
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exitCode = 1;
});
