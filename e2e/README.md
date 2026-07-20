# End-to-end test harness

Full-chain tests for the mod — **website → game/engine/hrace → clients
connecting** — split into a fast lane (no Docker) and a heavy lane (real
server image). CI runs both on every push/PR (`.github/workflows/ci.yml` and
`.github/workflows/e2e.yml`).

## What proves what

| Concern | Test | Lane |
|---|---|---|
| Web DB semantics + HTTP API | `cd web && npm test` | fast |
| env → `env.cfg` → launch args | `sh server/test/entrypoint.test.sh` | fast |
| Reporting natives → live web API (both directions, retry queue) | `sh e2e/run.sh` | fast |
| Mesh wire parser vs. hostile datagrams (ASan/UBSan) | `sh e2e/mirror_fuzz_run.sh` | fast |
| WR-demo filename: engine C vs. `.as`, byte-for-byte | `node --test server/test/demoname.test.mjs` | fast |
| **hrace gametype compiles at boot + a real client connects** | `sh e2e/gameserver_smoke.sh` | heavy |
| **Website + DB + game together, game→web over HTTP** | `sh e2e/fullstack_run.sh` | heavy |
| 3-node mesh: gametype compiles + peers configure | `sh server/test/verify-mesh.sh --boot-only` | heavy |
| Full mesh protocol regression (auth, dedup, caps, map vote) | `python3 e2e/mesh_regression.py` | local/manual |

## The heavy lane

The game server image (`warsow-race:2.1.2`) downloads Warsow 2.1.2 and compiles
the qfusion engine + patched game module — ~20-30 min. The e2e workflow builds
it **once** (buildx + a GitHub Actions layer cache) and every step below reuses
it, so unchanged `server/` trees rebuild in minutes.

- **`gameserver_smoke.sh`** — boots one server, waits for
  `Gametype 'Race' initialized` (the AngelScript gametype compiles at *boot*,
  so this is the only thing that catches a broken `.as` change), then runs the
  client-connect probe. Fails on any AngelScript error/exception in the log.

- **`client_connect_probe.py`** — the real Warsow connectionless client
  handshake, exactly what `connect <host>` does in-game:
  `getchallenge` → `getinfo`/`getstatus` (server-browser) → `connect …` →
  `client_connect`. Reaching `client_connect` means the server issued a
  challenge, accepted the protocol version, and allocated a client slot. It
  tries protocol candidates `1001,1` (PUBLIC_BUILD off vs. on) and succeeds on
  whichever the built binary accepts.

- **`fullstack_run.sh`** + **`docker-compose.fullstack.yml`** — postgres + web +
  the game server on one network. Asserts the web is healthy and renders its
  homepage, the game boots and a client connects, and the booted game reaches
  the live web over HTTP: its shipped console logs land in the web's
  `server_log` table (a real authenticated game→web round-trip).

Local runs build the image on first use; pass `--no-build` to require an
existing `warsow-race:2.1.2` (how CI invokes them after the shared build step).

## Other tools here

`mirror_wire_check.py` (fake mesh player / wire poker), `mesh_regression.py`
(headless RSM1 protocol suite against the live 3-node mesh), and the harness
sources (`report_harness.cpp`, `topfetch_harness.cpp`, `mirror_*`) used by the
scripts above.
