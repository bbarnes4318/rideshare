'use strict';
//
// Records which submit/click listeners a page ends up with, and which of them
// actually run. Shared by scripts/diagnoseTrustedFormSubmitHooks.js and by
// scripts/submitWithResidentialProxy.js --probe-listeners.
//
// It wraps addEventListener to RECORD and then calls through. Nothing is
// blocked, replaced or stubbed, so the page and the TrustedForm SDK behave
// exactly as they otherwise would -- but a run using this is instrumented, and
// the A/B captures are taken without it.

const LISTENER_PROBE = () => {
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
        : '')
    );
  };

  // The TrustedForm SDK is the only script on the page served from
  // cdn.trustedform.com, so a stack frame naming that host identifies it.
  const originIsTrustedForm = () => /trustedform/i.test(new Error().stack || '');

  // Also record every request the PAGE itself tries to make to TrustedForm.
  //
  // This separates two very different failures that look identical in a
  // capture: the SDK deciding not to send a submission event, and the SDK
  // sending one that the capture missed. Playwright's page.on('request') sees
  // the network; this sees the intent.
  window.__tfProbe.attempts = [];
  const note = (via, url, bytes) => {
    if (!/trustedform/i.test(String(url))) return;
    window.__tfProbe.attempts.push({ via, url: String(url).split('?')[0], bytes: bytes || 0 });
  };

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      note('fetch', url, init && init.body ? String(init.body).length : 0);
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tfUrl = url;
    return originalOpen.apply(this, arguments);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    note('xhr', this.__tfUrl, body ? String(body).length : 0);
    return originalSend.apply(this, arguments);
  };

  if (navigator.sendBeacon) {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      note('beacon', url, data ? (data.size || String(data).length) : 0);
      return originalBeacon(url, data);
    };
  }

  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type !== 'submit' && type !== 'click') {
      return original.call(this, type, listener, options);
    }
    const record = { type, target: describe(this), trustedForm: originIsTrustedForm() };
    window.__tfProbe.registrations.push(record);
    const wrapped = function (event) {
      window.__tfProbe.fired.push({
        type: record.type,
        target: record.target,
        trustedForm: record.trustedForm,
        defaultPrevented: event.defaultPrevented,
      });
      return listener.apply(this, arguments);
    };
    return original.call(this, type, wrapped, options);
  };
};

const readListenerProbe = (page) =>
  page.evaluate(() => window.__tfProbe || { registrations: [], fired: [] });

module.exports = { LISTENER_PROBE, readListenerProbe };
