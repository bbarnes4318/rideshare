'use strict';
//
// Browser-side and driver-side interaction telemetry for the behavioral test
// harness.
//
// Two sources are merged into one timeline:
//
//   1. Page-side listeners, installed with addInitScript before any page
//      script runs. These are passive capture-phase listeners on the same DOM
//      events TrustedForm's own script observes (focus, blur, input, change,
//      keydown, keyup, scroll). They only read; they never call
//      preventDefault/stopPropagation and never touch any field value.
//   2. Driver-side records written by the harness itself (navigation, pauses,
//      field completion, submit, response, context close), which the page
//      cannot see.
//
// Redaction: keystroke telemetry records the *class* of a printable key, not
// the character, so a report can never be used to reconstruct an email, phone
// number or street address. Structural keys (Tab, Backspace, Enter, arrows)
// are recorded literally because they carry no field content. Set
// --telemetry-keys raw to record literal characters for a controlled run with
// synthetic data.

const PAGE_INSTRUMENTATION = ({ redactKeys }) => {
  window.__bhEvents = [];
  window.__bhStart = Date.now();

  const describe = (el) => {
    if (!el || el === document || el === window) return {};
    const id = el.id || '';
    const name = el.name || '';
    if (!id && !name) return { selector: (el.tagName || '').toLowerCase() };
    return {
      selector: id ? '#' + id : '[name="' + name + '"]',
      field: (id || name).toLowerCase(),
    };
  };

  const classify = (key) => {
    if (!key) return '<none>';
    if (key.length > 1) return key;
    if (key === ' ') return '<space>';
    if (/[0-9]/.test(key)) return '<digit>';
    if (/[a-z]/i.test(key)) return '<alpha>';
    return '<punct>';
  };

  // Read the buffer through window every time. drain() replaces
  // window.__bhEvents with a fresh array, so a captured reference would keep
  // filling the drained one and every event after the first drain would be lost.
  const push = (type, extra) => {
    const buf = window.__bhEvents || (window.__bhEvents = []);
    if (buf.length > 20000) return;
    buf.push(Object.assign({ timestamp: Date.now(), source: 'page', eventType: type }, extra));
  };

  const valueLength = (el) => (el && typeof el.value === 'string' ? el.value.length : null);

  const on = (target, type, handler) => target.addEventListener(type, handler, true);

  on(document, 'focus', (e) => push('focus', describe(e.target)));
  on(document, 'blur', (e) => push('blur', Object.assign(describe(e.target), { valueLength: valueLength(e.target) })));
  on(document, 'input', (e) => push('input', Object.assign(describe(e.target), { valueLength: valueLength(e.target) })));
  on(document, 'change', (e) => push('change', Object.assign(describe(e.target), { valueLength: valueLength(e.target) })));
  on(document, 'keydown', (e) => push('keydown', Object.assign(describe(e.target), {
    key: redactKeys ? classify(e.key) : e.key,
  })));
  on(document, 'keyup', (e) => push('keyup', Object.assign(describe(e.target), {
    key: redactKeys ? classify(e.key) : e.key,
  })));
  on(document, 'click', (e) => push('click', describe(e.target)));

  let lastScroll = window.scrollY || 0;
  let scrollPending = false;
  const flushScroll = () => {
    scrollPending = false;
    const y = window.scrollY || 0;
    const amount = y - lastScroll;
    if (amount === 0) return;
    push('scroll', {
      scrollPosition: y,
      direction: amount > 0 ? 'down' : 'up',
      amount: Math.abs(amount),
    });
    lastScroll = y;
  };
  window.addEventListener('scroll', () => {
    if (scrollPending) return;
    scrollPending = true;
    setTimeout(flushScroll, 120);
  }, true);
};

/**
 * One run's merged event timeline.
 *
 * `elapsedMs` is measured from the run's declared t0 (the funnel page load),
 * so every event in a report shares one origin regardless of which source
 * produced it.
 */
class Recorder {
  constructor() {
    this.events = [];
    this.t0 = null;
  }

  start(t0) {
    this.t0 = t0 ?? Date.now();
    return this.t0;
  }

  /** Record a driver-side event. Returns the event so callers can amend it. */
  record(eventType, extra = {}) {
    const timestamp = Date.now();
    const event = Object.assign(
      { timestamp: new Date(timestamp).toISOString(), elapsedMs: this.elapsed(timestamp), eventType, source: 'driver' },
      extra,
    );
    this.events.push(event);
    return event;
  }

  elapsed(at) {
    if (this.t0 == null) return 0;
    return Math.max(0, (at ?? Date.now()) - this.t0);
  }

  /** Pull everything the page has buffered since the last drain and merge it. */
  async drain(page) {
    let pageEvents = [];
    try {
      pageEvents = await page.evaluate(() => {
        const out = window.__bhEvents || [];
        window.__bhEvents = [];
        return out;
      });
    } catch {
      return 0; // page navigated away or closed; nothing to drain
    }
    for (const raw of pageEvents) {
      const { timestamp, ...rest } = raw;
      this.events.push(Object.assign(
        { timestamp: new Date(timestamp).toISOString(), elapsedMs: this.elapsed(timestamp) },
        rest,
      ));
    }
    return pageEvents.length;
  }

  /**
   * Chronological timeline. Page and driver events interleave by wall clock;
   * Array#sort is stable, so events sharing a millisecond keep insertion order.
   */
  timeline() {
    return [...this.events].sort((a, b) => a.elapsedMs - b.elapsedMs);
  }

  summary() {
    const count = (type) => this.events.filter((e) => e.eventType === type).length;
    return {
      interactionCount: this.events.filter((e) => e.source === 'page').length,
      keystrokeCount: count('keydown'),
      focusCount: count('focus'),
      blurCount: count('blur'),
      inputCount: count('input'),
      changeCount: count('change'),
      scrollCount: count('scroll'),
      pauseCount: count('pause'),
      clickCount: count('click'),
      eventCount: this.events.length,
    };
  }
}

module.exports = { PAGE_INSTRUMENTATION, Recorder };
