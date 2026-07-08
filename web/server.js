// Race stats web server: hosts the livesow SQLite database behind a small REST
// API and serves the static frontend that consumes it.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "db.sqlite");

console.log(`Opening database at ${DB_PATH} ...`);
const race = openDatabase(DB_PATH);

const app = express();
app.disable("x-powered-by");

// Tiny request logger.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) console.log(`${req.method} ${req.originalUrl}`);
  next();
});

const api = express.Router();

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

api.get("/overview", (_req, res) => res.json(race.overview()));

api.get("/maps", (req, res) => {
  res.json(race.maps(req.query));
});

api.get("/maps/:id", (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  const detail = race.mapDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "map not found" });
  res.json(detail);
});

api.get("/players", (req, res) => {
  res.json(race.players(req.query));
});

api.get("/players/:id", (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  const detail = race.playerDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "player not found" });
  res.json(detail);
});

api.get("/search", (req, res) => {
  res.json(race.search(req.query.q || "", { limit: 8 }));
});

api.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api", api);

// Static frontend.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// SPA fallback for client-side routes (non-API, non-asset).
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.includes(".")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Race stats server listening on http://0.0.0.0:${PORT}`);
});
