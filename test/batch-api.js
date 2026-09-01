'use strict';
//
// Integration tests for the batch CSV API (routes/batch.js).
//
// Auth is stubbed so these exercise the route logic rather than JWT, which has
// its own tests. That the real routes are actually behind auth is verified
// separately against the deployed server.
//
// Nothing here starts a batch: /start is only exercised for its refusal paths,
// because succeeding would submit real leads to the live funnel.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok  ' + name); }
  catch (error) { failures.push({ name, error }); console.log('  FAIL ' + name + ': ' + error.message); }
}

// Point the router's report dir at a scratch directory before requiring it.
const REPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-api-'));
process.env.BEHAVIOR_REPORT_DIR = REPORT_DIR;

// Stub the auth middleware in the require cache, so the router under test gets
// a caller without needing a database or a signed token.
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    authenticateToken: (req, res, next) => { req.user = { email: 'tester@example.com' }; next(); },
    requirePermission: () => (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
  },
};

const express = require('express');
const batchRouter = require('../routes/batch');

const app = express();
app.use('/api/batch', batchRouter);
const server = http.createServer(app);

const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-leads.csv'), 'utf8');

function request(method, url, body) {
  const port = server.address().port;
  return fetch('http://127.0.0.1:' + port + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({
    status: r.status,
    body: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text(),
  }));
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('batch API tests (report dir ' + REPORT_DIR + ')');
  let batchId = null;

  await test('preview accepts a CSV and returns one row per record', async () => {
    const res = await request('POST', '/api/batch/preview', { filename: 'sample.csv', content: CSV });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.usable, 6);
    assert.strictEqual(res.body.rows.length, 6);
    batchId = res.body.batchId;
    assert.ok(batchId, 'no batchId returned');
  });

  await test('preview sanitizes rather than echoing the raw input', async () => {
    const res = await request('POST', '/api/batch/preview', { filename: 's.csv', content: CSV });
    const dana = res.body.rows[0];
    assert.strictEqual(dana.phone, '5513326220', 'phone not normalized: ' + dana.phone);
    assert.strictEqual(dana.dob, '07/09/1982');
    assert.strictEqual(dana.gender, 'female');
    const priya = res.body.rows[2];
    assert.strictEqual(priya.dob, '03/22/1974', 'YYYY-MM-DD not converted');
    assert.strictEqual(priya.phone, '2135550177', 'leading 1 not dropped');
  });

  await test('preview shows the generated qualification values', async () => {
    const res = await request('POST', '/api/batch/preview', { filename: 's.csv', content: CSV });
    for (const row of res.body.rows) {
      const g = row.generated;
      assert.ok(['Yes', 'No'].includes(g.homeowner), 'homeowner ' + g.homeowner);
      assert.strictEqual(g.military, 'No');
      assert.strictEqual(g.coverageAmount, '$25,000 (Funeral Expenses)');
      assert.ok(/^\d'\d{1,2}" \(\d{2} in\)$/.test(g.height), 'height ' + g.height);
      assert.ok(/^\d{3} lbs$/.test(g.weight), 'weight ' + g.weight);
    }
    assert.ok(/normalized to 100/.test(res.body.distributions), 'distributions not disclosed');
  });

  await test('preview flags rows that are not recognized as test data', async () => {
    const real = 'First_Name,Last_Name,Gender,Age,Address,City,State,Zip,Phone,Email,DOB\n'
      + 'John,Smith,Male,40,1 Main St,Jersey City,NJ,07302,5513326220,john.smith@gmail.com,01/01/1985\n';
    const res = await request('POST', '/api/batch/preview', { filename: 'real.csv', content: real });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.nonTestRecords, 1);
    assert.strictEqual(res.body.rows[0].recognizedAsTestRecord, false);
  });

  await test('preview reports unusable rows instead of submitting them', async () => {
    const bad = 'First_Name,Last_Name,Gender,Age,Address,City,State,Zip,Phone,Email,DOB\n'
      + 'Bad,TestLead,Male,40,1 Main St,Jersey City,NJ,07302,555,bad.testlead@example.com,4/15/85\n';
    const res = await request('POST', '/api/batch/preview', { filename: 'bad.csv', content: bad });
    assert.strictEqual(res.body.usable, 0);
    assert.strictEqual(res.body.rejected.length, 1);
    assert.ok(/digits|ambiguous/.test(res.body.rejected[0].error), res.body.rejected[0].error);
  });

  await test('preview rejects a CSV with missing headers', async () => {
    const res = await request('POST', '/api/batch/preview', { filename: 'x.csv', content: 'a,b\n1,2\n' });
    assert.strictEqual(res.status, 400);
    assert.ok(/missing required column/i.test(res.body.message), res.body.message);
    // The operator has to be able to fix the file from the message alone.
    assert.ok(/birthdate/i.test(res.body.message), res.body.message);
    assert.ok(/Found: a, b/.test(res.body.message), res.body.message);
  });

  await test('preview accepts the header spellings other exports use', async () => {
    const aliased = 'first name,LAST NAME,sex,Age,Street Address,City,State,Zip Code,'
      + 'Phone Number,Email Address,birthDate\n'
      + 'Jane,TestLead,F,35,2 Oak Ave,Newark,NJ,07102,(551) 332-6221,'
      + 'jane.testlead@example.com,1990-07-04\n';
    const res = await request('POST', '/api/batch/preview', { filename: 'aliased.csv', content: aliased });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.usable, 1);
    assert.strictEqual(res.body.rejected.length, 0);
    assert.strictEqual(res.body.rows[0].dob, '07/04/1990');
    assert.strictEqual(res.body.rows[0].phone, '5513326221');
  });

  await test('preview rejects an empty body', async () => {
    const res = await request('POST', '/api/batch/preview', { filename: 'x.csv', content: '   ' });
    assert.strictEqual(res.status, 400);
  });

  await test('start refuses non-test records without an explicit acknowledgement', async () => {
    const real = 'First_Name,Last_Name,Gender,Age,Address,City,State,Zip,Phone,Email,DOB\n'
      + 'John,Smith,Male,40,1 Main St,Jersey City,NJ,07302,5513326220,john.smith@gmail.com,01/01/1985\n';
    const up = await request('POST', '/api/batch/preview', { filename: 'real.csv', content: real });
    const res = await request('POST', '/api/batch/' + up.body.batchId + '/start', {});
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.ok(/not recognized as test records/i.test(res.body.message), res.body.message);
    assert.strictEqual(res.body.nonTestRecords.length, 1);
  });

  await test('start rejects an unknown batch', async () => {
    const res = await request('POST', '/api/batch/does-not-exist/start', {});
    assert.strictEqual(res.status, 404);
  });

  await test('a path-traversal batch id is refused, not resolved', async () => {
    for (const id of ['..', '../../etc', '.%2e%2f', 'a/b']) {
      const res = await request('GET', '/api/batch/' + encodeURIComponent(id) + '/status');
      assert.ok(res.status === 400 || res.status === 404,
        'id "' + id + '" returned ' + res.status);
    }
  });

  await test('status reports an uploaded batch that has not been started', async () => {
    const res = await request('GET', '/api/batch/' + batchId + '/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.phase, 'uploaded');
  });

  await test('download 404s until a batch has produced output', async () => {
    const res = await request('GET', '/api/batch/' + batchId + '/download');
    assert.strictEqual(res.status, 404);
  });

  await test('the listing shows uploaded batches, newest first', async () => {
    const res = await request('GET', '/api/batch');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.batches.length >= 5, 'got ' + res.body.batches.length);
    assert.ok(res.body.batches.every((b) => b.batchId && b.uploadedAt));
    const dates = res.body.batches.map((b) => b.uploadedAt);
    assert.deepStrictEqual(dates, [...dates].sort().reverse(), 'not newest-first');
    assert.strictEqual(res.body.activeBatchId, null);
  });

  await test('an oversized CSV is refused', async () => {
    const huge = 'First_Name,Last_Name,Gender,Age,Address,City,State,Zip,Phone,Email,DOB\n'
      + 'x'.repeat(3 * 1024 * 1024);
    const res = await request('POST', '/api/batch/preview', { filename: 'huge.csv', content: huge });
    assert.ok(res.status === 413 || res.status === 400, 'got ' + res.status);
  });

  console.log('');
  console.log(passed + ' passed, ' + failures.length + ' failed');
  server.close();
  fs.rmSync(REPORT_DIR, { recursive: true, force: true });
  if (failures.length) {
    for (const f of failures) console.error('\n' + f.name + '\n' + f.error.stack);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
