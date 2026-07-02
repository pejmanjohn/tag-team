// Offline network guard. Loaded via `NODE_OPTIONS=--import <abs>/scripts/net-guard.mjs`.
// Patches globalThis.fetch so any request to a host other than the loopback
// interface is logged (to NET_GUARD_LOG) and rejected. This proves the verified
// Slack turn runs with zero external traffic.
import { appendFileSync } from 'node:fs';

const LOG_PATH = process.env.NET_GUARD_LOG;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const originalFetch = globalThis.fetch;

function hostOf(input) {
  try {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    return href ? new URL(href).hostname : '';
  } catch {
    return '';
  }
}

globalThis.fetch = async function guardedFetch(input, init) {
  const host = hostOf(input);
  if (host && !ALLOWED_HOSTS.has(host)) {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const line = `${host}\t${href}`;
    if (LOG_PATH) {
      try {
        appendFileSync(LOG_PATH, `${line}\n`);
      } catch {
        // best-effort logging only
      }
    }
    const message = `[net-guard] blocked external fetch to ${host} (${href})`;
    console.error(message);
    throw new Error(message);
  }
  return originalFetch(input, init);
};
