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
    // A stalled-but-connected Redis would otherwise queue commands without
    // bound (every request enqueues a GET + SET). Excess commands reject,
    // which every call site already treats as a miss.
    commandsQueueMaxLength: 1000,
    disableOfflineQueue: true,
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
// In-process single-flight: while one request ("leader") is re-running the
// handler for a missed key, concurrent requests for the same key wait for the
// leader's body instead of re-executing the (possibly expensive) handler once
// each. Per-process, so worst case across the two replicas is 2 concurrent
// rebuilds of a hot key instead of one per queued request. Entries settle (and
// are deleted) when the leader's response finishes for ANY reason, so a
// crashed or non-200 leader releases the followers to run the handler solo.
const inflight = new Map(); // cacheKey -> Promise<{ct, b} | null>
const FOLLOW_TIMEOUT_MS = 10_000; // heaviest handler bound; past this, go solo

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
    // `settle` (leader mode) reports the outcome to waiting followers: the
    // cacheable body, or null when there is nothing for them to reuse.
    const installStore = (settle) => {
      const orig = res.send.bind(res);
      let settled = false;
      const finish = (val) => {
        if (settle && !settled) { settled = true; settle(val); }
      };
      res.send = (body) => {
        try {
          if (res.statusCode === 200) {
            if (edgeCC) res.set("Cache-Control", edgeCC);
            if (typeof body === "string") {
              const ct = res.get("Content-Type") || "application/json; charset=utf-8";
              finish({ ct, b: body });
              if (ready) {
                // Fire-and-forget; a failed SET must not affect the response.
                client.set(cacheKey, JSON.stringify({ ct, b: body }), { EX: ttlSeconds }).catch(() => {});
              }
            }
          }
        } catch { /* never let caching break the response */ }
        finish(null);
        res.set("X-Cache", "MISS");
        return orig(body);
      };
      // Errored/aborted requests never reach send — release followers anyway.
      res.on("close", () => finish(null));
    };

    // Run the handler ourselves as the shared leader for this key.
    const lead = () => {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      inflight.set(cacheKey, p);
      installStore((val) => {
        inflight.delete(cacheKey);
        resolve(val);
      });
      next();
    };

    const serve = (obj) => {
      res.set("Content-Type", obj.ct || "application/json; charset=utf-8");
      if (edgeCC) res.set("Cache-Control", edgeCC); // always a stored/shared 200
      res.set("X-Cache", "HIT");
      res.send(obj.b);
    };

    // Coalesce onto an in-flight rebuild of the same key if one exists.
    const joined = inflight.get(cacheKey);
    if (joined) {
      withTimeout(joined, FOLLOW_TIMEOUT_MS)
        .then((obj) => {
          if (obj) return serve(obj);
          installStore(null); // leader produced nothing reusable — go solo
          next();
        })
        .catch(() => { installStore(null); next(); });
      return;
    }

    if (!client || !ready) return lead();

    withTimeout(client.get(cacheKey), GET_TIMEOUT_MS)
      .then((hit) => {
        if (typeof hit === "string") {
          let obj;
          try { obj = JSON.parse(hit); } catch { return lead(); }
          return serve(obj);
        }
        lead();
      })
      .catch(() => lead());
  };
}

// Explicit invalidation for the rare key that can't wait out its TTL: the
// game-facing ranks blob must reflect a new record immediately, so the ingest
// path evicts its key here. `keyString` MUST equal the value the cache()
// middleware stored (i.e. the same string the route's key fn produced — the
// "resp:" prefix is added here). No-op when Redis is absent/unready, so a down
// cache is never an error — the short TTL still bounds staleness.
export function invalidate(keyString) {
  if (!client || !ready) return;
  client.del("resp:" + keyString).catch(() => {});
}
