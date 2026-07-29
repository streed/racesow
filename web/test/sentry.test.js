// Redaction contract for the Sentry beforeSend/beforeSendTransaction hook.
// This site handles ingest tokens (Authorization: Bearer ...), the rs_admin
// session cookie, and rcon passwords in request bodies — none of which may ever
// leave the process in an error/trace event. Importing instrument.mjs here is
// side-effect-free: Sentry.init only runs when SENTRY_DSN is set, and it is not
// in the test env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub, SENSITIVE_HEADERS } from "../instrument.mjs";

test("scrub redacts secret-bearing headers, keeps benign ones", () => {
  const event = {
    request: {
      method: "POST",
      url: "https://racesow.org/api/ingest",
      headers: {
        Authorization: "Bearer super-secret-ingest-token",
        Cookie: "rs_admin=deadbeefsession",
        "Set-Cookie": "rs_admin=rotated",
        "User-Agent": "racesow-collector/1.0",
        "X-Forwarded-For": "203.0.113.7",
      },
    },
  };
  const out = scrub(event);
  assert.equal(out.request.headers.Authorization, "[Filtered]");
  assert.equal(out.request.headers.Cookie, "[Filtered]");
  assert.equal(out.request.headers["Set-Cookie"], "[Filtered]");
  // Non-sensitive headers survive for debugging context.
  assert.equal(out.request.headers["User-Agent"], "racesow-collector/1.0");
  assert.equal(out.request.headers["X-Forwarded-For"], "203.0.113.7");
});

test("scrub matches header names case-insensitively", () => {
  for (const name of ["AUTHORIZATION", "authorization", "Cookie", "COOKIE"]) {
    const out = scrub({ request: { headers: { [name]: "x" } } });
    assert.equal(out.request.headers[name], "[Filtered]", `${name} not filtered`);
  }
});

test("scrub drops request body, parsed cookies, and the user block", () => {
  const out = scrub({
    request: {
      headers: {},
      data: { password: "hunter2", rconPassword: "topsecret", command: "say hi" },
      cookies: { rs_admin: "sessionvalue" },
    },
    user: { id: "42", ip_address: "203.0.113.7" },
  });
  assert.equal(out.request.data, undefined);
  assert.equal(out.request.cookies, undefined);
  assert.equal(out.user, undefined);
});

test("scrub tolerates events with no request/headers", () => {
  assert.doesNotThrow(() => scrub({}));
  assert.doesNotThrow(() => scrub({ request: {} }));
  const out = scrub({ message: "boom" });
  assert.equal(out.message, "boom");
});

test("SENSITIVE_HEADERS covers the app's secret-bearing headers", () => {
  for (const h of ["authorization", "cookie", "set-cookie", "proxy-authorization"]) {
    assert.ok(SENSITIVE_HEADERS.has(h), `${h} missing from denylist`);
  }
});
