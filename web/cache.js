// Optional Redis response cache for the hot read endpoints.
//
// Enabled only when REDIS_URL is set. It is a *transparent* cache: if Redis is
// absent, unreachable, or slow, the middleware falls straight through to the
// live handler, so the site never depends on the cache being up. Entries are
// short-TTL (60-120s) and keyed by path + query, so records stay near-fresh
// without any explicit invalidation — a new record simply appears once the
// relevant key expires. Both web replicas share one Redis, so the cache is
// consistent across them.
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "";
// A single stalled GET must never hold up a request; skip the cache past this.
const GET_TIMEOUT_MS = 150;

let client = null;
let ready = false;

if (REDIS_URL) {
  client = createClient({
    url: REDIS_URL,
    socket: {
      // Keep reconnecting (capped backoff) so the cache self-heals after a
      // Redis blip; errors below just mark it not-ready in the meantime.
      reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
    },
  });
  client.on("error", () => { ready = false; }); // swallow — a down cache is not an error
  client.on("ready", () => { ready = true; console.log("Redis cache connected"); });
  client.on("end", () => { ready = false; });
  client.connect().catch(() => { ready = false; });
}

export const cacheEnabled = () => Boolean(client) && ready;

// Race a promise against a timeout so a wedged Redis can't slow requests.
function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("cache timeout")), ms);
    t.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Deterministic key: path + sorted query params, so ?a=1&b=2 and ?b=2&a=1 hit
// the same entry.
function defaultKey(req) {
  const q = req.query || {};
  const parts = Object.keys(q).sort().map((k) => `${k}=${q[k]}`);
  return req.path + (parts.length ? "?" + parts.join("&") : "");
}

// Express middleware: serve a cached 200 response if present, else run the
// handler and store its 200 response for ttlSeconds. Only string bodies (JSON
// via res.json, plain text via res.send) are cached; Buffer/binary bodies and
// any non-200 response pass through uncached. Adds X-Cache: HIT|MISS.
//
// opts.edge (default false): additionally emit a Cache-Control that lets
// Cloudflare EDGE-cache the 200 (the Redis layer only saves origin CPU, never
// the edge->origin network hop). s-maxage is the shared-edge TTL (matched to
// ttlSeconds), a short max-age lets a browser reuse within an SPA session, and
// stale-while-revalidate lets the edge serve a slightly stale body while it
// refreshes. This header alone does nothing until a Cloudflare Cache Rule marks
// the path eligible (JSON isn't a default-cacheable type); it is harmless
// otherwise. Only set on 200s so 404s (unknown :id) stay fresh. opts may also
// be a keyFn for backward compatibility.
export function cache(ttlSeconds, opts = {}) {
  const { key = defaultKey, edge = false } =
    typeof opts === "function" ? { key: opts } : opts;
  const edgeCC = edge
    ? `public, max-age=${Math.min(ttlSeconds, 30)}, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`
    : null;

  return (req, res, next) => {
    const cacheKey = "resp:" + key(req);

    // Wrap res.send so the edge header is applied on ANY 200 this request emits
    // (and, when Redis is up, the 200 body is stored). Used on the store path
    // and when Redis is unavailable, so edge-caching never depends on Redis.
    const installStore = () => {
      const orig = res.send.bind(res);
      res.send = (body) => {
        try {
          if (res.statusCode === 200) {
            if (edgeCC) res.set("Cache-Control", edgeCC);
            if (ready && typeof body === "string") {
              const ct = res.get("Content-Type") || "application/json; charset=utf-8";
              // Fire-and-forget; a failed SET must not affect the response.
              client.set(cacheKey, JSON.stringify({ ct, b: body }), { EX: ttlSeconds }).catch(() => {});
            }
          }
        } catch { /* never let caching break the response */ }
        res.set("X-Cache", "MISS");
        return orig(body);
      };
    };

    if (!client || !ready) { installStore(); return next(); }

    withTimeout(client.get(cacheKey), GET_TIMEOUT_MS)
      .then((hit) => {
        if (typeof hit === "string") {
          let obj;
          try { obj = JSON.parse(hit); } catch { installStore(); return next(); }
          res.set("Content-Type", obj.ct || "application/json; charset=utf-8");
          if (edgeCC) res.set("Cache-Control", edgeCC); // a HIT is always a stored 200
          res.set("X-Cache", "HIT");
          return res.send(obj.b);
        }
        installStore();
        next();
      })
      .catch(() => { installStore(); next(); });
  };
}
