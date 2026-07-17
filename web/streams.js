// Live-stream registry: which enrolled game servers have a watchable video
// stream, and where to play it.
//
// A server's HLS URL is trusted config (never client-supplied): each game box
// runs its own tv-capture encoder that publishes an HLS playlist to a known
// host, and the site only needs to know that URL per server id. The stream is
// ALWAYS up when configured — it shows live gameplay, or the branded RACESOW
// "waiting for racers" card when the server is empty — so a configured URL is
// enough to render the player.
//
// URLs come from the STREAM_URLS env, a comma/semicolon/newline list of
// `<serverId>=<hlsUrl>` pairs, e.g.
//   STREAM_URLS="1=https://stream-eu.racesow.org/hls/eu/index.m3u8,2=https://stream-us.racesow.org/hls/us/index.m3u8"
//
// The encoder additionally POSTs a lightweight heartbeat (see the /api/streams
// health route) carrying live status + the current spectated player (POV) and
// map. That refines the UI ("● LIVE · watching X") and lets the API mark a
// stream stale, but is optional — absent heartbeats just yield status "unknown".

const URL_RE = /^https?:\/\/[^\s]+$/i;

export function parseStreamConfig(raw) {
  const map = new Map();
  if (typeof raw !== "string" || !raw.trim()) return map;
  for (const part of raw.split(/[,\n;]+/)) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const id = parseInt(s.slice(0, eq).trim(), 10);
    const url = s.slice(eq + 1).trim();
    if (Number.isFinite(id) && URL_RE.test(url)) map.set(id, url);
  }
  return map;
}

export function createStreamRegistry({ config = process.env.STREAM_URLS, ttlMs = 30_000, now = () => Date.now() } = {}) {
  const urls = parseStreamConfig(config);   // serverId -> hls url (trusted)
  const beats = new Map();                   // serverId -> { status, players, map, pov, at }

  function fresh(b) { return b && (now() - b.at) < ttlMs; }

  return {
    // Playback info for one server, or null when it has no stream configured.
    for(serverId) {
      const hls = urls.get(serverId);
      if (!hls) return null;
      const b = beats.get(serverId);
      const live = fresh(b);
      return {
        hls,
        status: live ? (b.status || "live") : "unknown",
        pov: live ? (b.pov || null) : null,
        players: live && Number.isFinite(b.players) ? b.players : null,
      };
    },

    // Record an encoder heartbeat. Only the (trusted) configured URL is used for
    // playback; the heartbeat never sets the URL, so it can't redirect viewers.
    recordHeartbeat(serverId, { status, players, map, pov } = {}) {
      if (!urls.has(serverId)) return false;   // ignore beats for unconfigured ids
      beats.set(serverId, {
        status: typeof status === "string" ? status.slice(0, 16) : "live",
        players: Number.isFinite(players) ? players : null,
        map: typeof map === "string" ? map.slice(0, 64) : null,
        pov: typeof pov === "string" ? pov.slice(0, 64) : null,
        at: now(),
      });
      return true;
    },

    configuredIds() { return [...urls.keys()]; },
    has(serverId) { return urls.has(serverId); },
  };
}
