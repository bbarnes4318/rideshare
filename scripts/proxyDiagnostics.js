'use strict';

const http = require('http');

/**
 * Probe the residential gateway with a raw CONNECT request.
 *
 * This is deliberately independent of Playwright so that a proxy/account
 * problem can be told apart from a browser problem. The gateway answers the
 * CONNECT with a status line before any tunnel exists, which is the clearest
 * signal available: 200 means the tunnel is up, anything else is refused and
 * the active provider's describeFailure() explains it.
 *
 * Both vendors listen for plain HTTP proxy requests - Shifter on port 443,
 * which is a port number and not an instruction to speak TLS to the proxy.
 * Verified against p.shifter.io:443 on 2026-09-02: this raw http.request
 * CONNECT gets a 200 status line, exactly as it does from IPRoyal on 12321.
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

/**
 * Best-effort geolocation of the observed egress IP.
 *
 * Both gateways silently widen the pool when a requested city has no available
 * peers - Shifter does it unless strict-true is set, and even then its geo
 * database need not agree with ip-api's - so the only way to know where the
 * session actually landed is to look up the IP that came back. Never throws:
 * a failed lookup must not fail the submission run.
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

module.exports = { probeProxyConnect, lookupIpGeo, fetchThroughProxy };
