'use strict';

//
// A small bounded worker pool, for running batch rows several at a time.
//
// Every row of a batch is already independent: it launches its own browser
// process, selects its own IPRoyal session, and writes its own forensic record.
// Nothing was shared between rows except the `for` loop that ran them, so the
// wall clock was simply the sum of every row's 30-60 seconds - hours for a few
// hundred rows, most of it spent waiting on a network round trip or on a
// deliberate human-paced pause.
//
// This runs `concurrency` of them at once instead. It is deliberately not a
// generic async library:
//
//   * results are returned in INPUT order, whatever order they finish in, so
//     the output CSV and the forensic record still read like the input file
//   * `onSettled` fires after each row, so the caller can rewrite the CSV and
//     the progress file as work lands rather than at the end
//   * starts are staggered, because N browsers all opening the funnel on the
//     same tick is a burst no real visitor pattern produces
//

// Above this, a batch stops going faster and starts going wrong: each run is a
// full Chromium process, and the 4-vCPU/8GB host the harness runs on begins
// swapping - which stretches every session's timing and corrupts the very
// durations the experiment is measuring.
const MAX_CONCURRENCY = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Coerce an operator-supplied concurrency to a usable integer.
 *
 * Anything unparseable falls back rather than throwing: this reads values from
 * a CLI flag, an environment variable and a JSON body, and a batch should not
 * fail to start because one of them was blank.
 */
function clampConcurrency(value, { fallback = 1, max = MAX_CONCURRENCY } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    // A fallback is trusted to be sane, but still bounded by the caller's max.
    return Math.max(1, Math.min(Math.floor(fallback) || 1, max));
  }
  return Math.max(1, Math.min(Math.floor(n), max));
}

/**
 * Run every item through `run`, at most `concurrency` at a time.
 *
 * @param {object}   opts
 * @param {Array}    opts.items        Work items, in the order they should start.
 * @param {number}   opts.concurrency  How many may be in flight at once.
 * @param {number}   opts.staggerMs    Minimum gap between two starts.
 * @param {Function} opts.run          async (item, index) => value
 * @param {Function} [opts.onSettled]  async (settled, all) => void, after each item.
 * @returns {Promise<Array>} one { index, item, value, error } per input, in input order.
 */
async function runPool({ items, concurrency = 1, staggerMs = 0, run, onSettled }) {
  const total = items.length;
  const results = new Array(total).fill(null);
  if (!total) return results;

  const width = Math.min(clampConcurrency(concurrency, { max: MAX_CONCURRENCY }), total);

  let next = 0;
  // The wall-clock instant the next run may start. Shared by every worker, so
  // the stagger applies across the pool and not per worker.
  let earliestStart = 0;

  async function worker() {
    for (;;) {
      // Safe without a lock: this read-then-increment has no await between the
      // two lines, and Node runs it to completion before any other worker
      // resumes. That is the whole of the mutual exclusion this needs.
      const index = next;
      next += 1;
      if (index >= total) return;

      if (staggerMs > 0) {
        const now = Date.now();
        const waitMs = Math.max(0, earliestStart - now);
        earliestStart = Math.max(now, earliestStart) + staggerMs;
        if (waitMs > 0) await sleep(waitMs);
      }

      let value = null;
      let error = null;
      try {
        value = await run(items[index], index);
      } catch (e) {
        // One row throwing must not abandon the rest of the batch: the whole
        // point of the harness is that a failed row is recorded, not fatal.
        error = e;
      }
      results[index] = { index, item: items[index], value, error };
      if (onSettled) await onSettled(results[index], results);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

module.exports = { MAX_CONCURRENCY, clampConcurrency, runPool, sleep };
