-- Admin force-restart for a game server, delivered by POLL rather than push.
--
-- /admin/servers already has a Restart button, but it sends `quit` over RCON —
-- which is useless in the failure mode that actually takes servers down. When
-- the engine wedges (fatal game error -> game module gone, process spinning) it
-- stops servicing UDP entirely: getinfo, getstatus and RCON all go unanswered.
-- EU Warfork sat like that for 38 hours on 2026-08-08 and no admin action could
-- have reached it.
--
-- So the panel does not try to reach the box. It raises a flag here, and each
-- box's healthcheck watchdog (server/gamehealth.sh) collects it on its next run
-- via GET /api/game/ops, authenticated with the per-server ingest token. The
-- watchdog is a separate process from the engine, so it still works when the
-- engine does not — and because the poll is OUTBOUND, this reaches the US box
-- with no inbound port, no Docker socket and no new shared secret.
--
-- Delivery is AT MOST ONCE: the endpoint clears restart_requested_at as it
-- answers. A request that is collected but somehow not carried out is not
-- retried forever (which would wedge a box in a restart loop) — the admin
-- clicks again. requested/acked are kept apart so the admin UI can show
-- "requested 40s ago, not yet picked up" versus "picked up".

-- Up Migration
ALTER TABLE server ADD COLUMN IF NOT EXISTS restart_requested_at BIGINT;
ALTER TABLE server ADD COLUMN IF NOT EXISTS restart_requested_by TEXT;
ALTER TABLE server ADD COLUMN IF NOT EXISTS restart_acked_at     BIGINT;

-- Down Migration
ALTER TABLE server DROP COLUMN IF EXISTS restart_requested_at;
ALTER TABLE server DROP COLUMN IF EXISTS restart_requested_by;
ALTER TABLE server DROP COLUMN IF EXISTS restart_acked_at;
