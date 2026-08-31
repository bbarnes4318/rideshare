'use strict';

const http = require('http');

/**
 * Probe the IPRoyal HTTP proxy with a raw CONNECT request.
 *
 * This is deliberately independent of Playwright so that a proxy/account
 * problem can be told apart from a browser problem. The proxy answers the
 * CONNECT with a status line before any tunnel exists, which is the clearest
 * signal available:
 *
 *   200 -> tunnel established, proxy is usable
 *   407 -> credentials rejected
 *   402 -> credentials fine, but the IPRoyal account has no balance/traffic
 */
function probeProxyConnect({ host, port, username, password, target, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const request = http.request({
      host,
      port,
      method: 'CONNECT',
      path: target,
      headers: {
        'Proxy-Authorization': `Basic ${auth}`,
        Host: target,
      },
      timeout: timeoutMs,
    });

    const done = (result) => {
      request.destroy();
      resolve(result);
    };

    request.on('connect', (res, socket) => {
      socket.destroy();
      done({ ok: res.statusCode === 200, statusCode: res.statusCode, statusMessage: res.statusMessage });
    });

    // A non-2xx CONNECT is delivered as a normal response, not a 'connect' event.
    request.on('response', (res) => {
      res.resume();
      done({ ok: false, statusCode: res.statusCode, statusMessage: res.statusMessage });
    });

    request.on('timeout', () => done({ ok: false, error: `CONNECT timed out after ${timeoutMs}ms` }));
    request.on('error', (error) => done({ ok: false, error: error.message }));

    request.end();
  });
}

function describeProxyFailure(probe) {
  if (probe.statusCode === 402) {
    return 'IPRoyal returned 402 Payment Required: the credentials are accepted but the account has no remaining balance/traffic. Top up the IPRoyal residential plan.';
  }
  if (probe.statusCode === 407) {
    return 'IPRoyal returned 407 Proxy Authentication Required: check IPROYAL_PROXY_USERNAME / IPROYAL_PROXY_PASSWORD.';
  }
  if (probe.statusCode) {
    return `IPRoyal returned HTTP ${probe.statusCode} ${probe.statusMessage || ''}`.trim();
  }
  return `Could not reach the IPRoyal proxy: ${probe.error}`;
}

/**
 * Best-effort geolocation of the observed egress IP.
 *
 * IPRoyal silently widens the pool when a requested city has no available
 * peers, so the only way to know whether the location target was actually
 * honoured is to look up the IP that came back. Never throws: a failed lookup
 * must not fail the submission run.
 */
function lookupIpGeo(ip, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const request = http.get(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,zip,isp,proxy,hosting`,
      { timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.status === 'success' ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

/**
 * Fetch a URL through the proxy over plain HTTP (absolute-form request line).
 *
 * Used to sample a sticky session's egress IP without paying to start Chromium,
 * so candidate sessions can be geo-checked cheaply on a shared-CPU host.
 */
function fetchThroughProxy({ host, port, username, password, url, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const request = http.request(
      {
        host,
        port,
        method: 'GET',
        path: url,
        headers: {
          Host: target.host,
          'Proxy-Authorization': `Basic ${auth}`,
          Connection: 'close',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({
          ok: res.statusCode === 200,
          statusCode: res.statusCode,
          body: body.trim(),
        }));
      },
    );
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, error: 'timeout' }); });
    request.on('error', (error) => resolve({ ok: false, error: error.message }));
    request.end();
  });
}

module.exports = { probeProxyConnect, describeProxyFailure, lookupIpGeo, fetchThroughProxy };
