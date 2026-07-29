// Sentry initialisation. Loaded via `node --import ./instrument.mjs server.js`
// (see web/Dockerfile CMD), NOT imported from server.js: under ESM the SDK has
// to run before any instrumented module (http/express/pg) is evaluated so it
// can wrap them, and a top-of-file `import "./instrument.mjs"` in server.js
// would already be too late. The --import flag is the supported ESM entrypoint.
//
// DISABLED BY DEFAULT: with SENTRY_DSN unset the SDK is never initialised, so
// there is zero instrumentation overhead and every Sentry.* call over in
// server.js is a silent no-op. This mirrors the graceful-degrade contract the
// rest of the app already follows (REDIS_URL empty -> cache off, DISCORD_
// WEBHOOK_URL empty -> announcer dry-run).
//
// Works against sentry.io or any self-hosted instance — the DSN is all that
// distinguishes them.
import * as Sentry from "@sentry/node";

// Request fields that can carry secrets on THIS app, redacted before an event
// leaves the process (belt-and-suspenders on top of sendDefaultPii:false, which
// already drops cookies/body/IP): the Authorization header (Bearer ingest
// token, server.js), the Cookie header (rs_admin admin session), and any set-
// cookie echoed back. Bodies and parsed cookies are removed wholesale below.
export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

// beforeSend/beforeSendTransaction hook: strip anything that could leak an
// ingest token, admin session, or rcon password, plus the user block (IP).
// Exported for unit testing (web/test/sentry.test.js); importing this module
// with SENTRY_DSN unset only defines it — Sentry.init is skipped (see below).
export function scrub(event) {
  const req = event.request;
  if (req) {
    delete req.cookies; // parsed admin-session cookie
    delete req.data; // request body — never needed, may hold passwords/tokens
    if (req.headers) {
      for (const key of Object.keys(req.headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) req.headers[key] = "[Filtered]";
      }
    }
  }
  delete event.user; // no PII / client-IP attribution
  return event;
}

const dsn = (process.env.SENTRY_DSN || "").trim();

if (dsn) {
  const environment =
    process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production";
  // Fraction of requests traced for performance (0..1). Default 10%; set 0 to
  // capture errors only. Clamped so a stray value can't over-sample.
  const rawRate = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1");
  const tracesSampleRate = Number.isFinite(rawRate)
    ? Math.min(1, Math.max(0, rawRate))
    : 0.1;

  Sentry.init({
    dsn,
    environment,
    // Git SHA of the running build if the deploy passes it (optional).
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate,
    // Never attach PII (IPs, cookies, request bodies, user ids). This site
    // handles ingest tokens, admin sessions and rcon passwords, so we redact
    // secrets locally rather than trusting server-side scrubbing.
    sendDefaultPii: false,
    beforeSend: scrub,
    beforeSendTransaction: scrub,
  });

  console.log(
    `Sentry: reporting enabled (env=${environment}, traces=${tracesSampleRate}).`
  );
} else {
  console.log("Sentry: SENTRY_DSN unset — reporting disabled (no-op).");
}
