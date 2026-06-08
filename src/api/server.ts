/**
 * server.ts — Express API server for the ICP Lead Intelligence platform.
 *
 * Run with: npm run api
 *
 * Startup sequence:
 *   1. Connect MongoDB   (fatal if unavailable)
 *   2. Connect Redis     (fatal if unavailable — queue won't work without it)
 *   3. Verify queue      (ping BullMQ scrape-jobs queue)
 *   4. Start HTTP server
 *
 * Does NOT execute any scraping logic — that lives in src/workers/scrapeWorker.ts
 */
import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { initDb } from "../database/initDb.ts";
import { closeConnection } from "../database/connection.ts";
import {
  validateRedisConnection,
  checkRedisHealth,
  closeRedisConnection,
  resolveRedisConfig,
} from "../queue/redis.ts";
import { scrapeQueue } from "../queue/scrapeQueue.ts";
import { scraperRouter } from "./routes/scraper.ts";
import { dataQualityRouter } from "./routes/dataQuality.ts";
import { dataExplorerRouter } from "./routes/dataExplorer.ts";
import { ensureLogIndexes, logger } from "../logging/logger.ts";

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const PORT = Number(process.env.PORT || process.env.API_PORT || "3000");

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS || "http://localhost:3001,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*")) {
        return callback(null, true);
      }
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ─── Body Parsing ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Request Logging ──────────────────────────────────────────────────────────

app.use((req: Request, _res: Response, next: NextFunction) => {
  _res.on("finish", () => {
    logger.apiRequest(req.method, req.path, _res.statusCode).catch(() => {});
  });
  next();
});

// ─── Health Endpoint ──────────────────────────────────────────────────────────

/**
 * GET /api/health
 *
 * Returns a JSON snapshot of every critical dependency's health.
 * Safe to call at any time — never throws, always returns 200 or 503.
 *
 * Response shape:
 * {
 *   mongodb: "connected" | "disconnected",
 *   redis:   "connected" | "disconnected",
 *   queue:   "ready"     | "unavailable",
 *   uptime:  number,      // process uptime in seconds
 *   timestamp: string     // ISO 8601
 * }
 */
app.get("/api/health", async (_req: Request, res: Response) => {
  // ── Redis ───────────────────────────────────────────────────────────────
  const redisStatus = await checkRedisHealth();

  // ── MongoDB ─────────────────────────────────────────────────────────────
  let mongoStatus: "connected" | "disconnected" = "disconnected";
  try {
    const { getDb } = await import("../database/connection.ts");
    const db = await getDb();
    await db.command({ ping: 1 });
    mongoStatus = "connected";
  } catch {
    mongoStatus = "disconnected";
  }

  // ── Queue ────────────────────────────────────────────────────────────────
  let queueStatus: "ready" | "unavailable" = "unavailable";
  if (redisStatus === "connected") {
    try {
      await scrapeQueue.getWaitingCount(); // lightweight queue probe
      queueStatus = "ready";
    } catch {
      queueStatus = "unavailable";
    }
  }

  const allHealthy =
    mongoStatus === "connected" &&
    redisStatus === "connected" &&
    queueStatus === "ready";

  return res.status(allHealthy ? 200 : 503).json({
    mongodb: mongoStatus,
    redis: redisStatus,
    queue: queueStatus,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Keep the old /health path as an alias for backwards compatibility
app.get("/health", (_req: Request, res: Response) =>
  res.redirect(307, "/api/health")
);

// ─── API Routes ───────────────────────────────────────────────────────────────

app.use("/api/scraper", scraperRouter);
app.use("/api/data-quality", dataQualityRouter);
app.use("/", dataExplorerRouter);

// ─── 404 ─────────────────────────────────────────────────────────────────────

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[API] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const LINE = "─".repeat(50);
  console.log(`\n${LINE}`);
  console.log("  ICP Lead Intelligence — API Server");
  console.log(LINE);

  // ── 1. MongoDB ─────────────────────────────────────────────────────────────
  try {
    await initDb();
    await ensureLogIndexes();
    console.log("  ✓ MongoDB Connected");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // MongoDB is not strictly required for the API to start (CSV mode works),
    // but we surface the error clearly for ops visibility.
    console.error(`  ✗ MongoDB  — ${message}`);
    console.warn("    Continuing — DB-dependent routes will return 500 until MongoDB is available.");
  }

  // ── 2. Redis (warn if unreachable — don't hard-crash on missing config) ──────
  const redisCfg = resolveRedisConfig();
  console.log(`  ↳ Redis target: ${redisCfg.displayHost}`);
  let redisAvailable = false;
  try {
    await validateRedisConnection(8_000);
    redisAvailable = true;
    console.log("  ✓ Redis Connected");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`\n  ⚠ Redis unavailable — queue features disabled.`);
    console.warn(`    ${message}`);
    console.warn(`    Set REDIS_URL in Render environment variables to enable scrape jobs.\n`);
    // Server continues — health endpoint and read-only routes still work
  }

  // ── 3. Queue ───────────────────────────────────────────────────────────────
  try {
    await scrapeQueue.getWaitingCount(); // verifies queue can communicate with Redis
    console.log("  ✓ Queue Ready    →  scrape-jobs");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Queue failure after Redis connected is unexpected — log and continue
    console.warn(`  ⚠ Queue probe failed — ${message}`);
  }

  console.log(LINE);

  // ── 4. HTTP Server ─────────────────────────────────────────────────────────
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  API server listening on http://0.0.0.0:${PORT}`);
    console.log(`  CORS origins:      ${ALLOWED_ORIGINS.join(", ")}`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST  /api/scraper/start`);
    console.log(`    GET   /api/scraper/status`);
    console.log(`    GET   /api/scraper/status/:id`);
    console.log(`    GET   /api/scraper/history`);
    console.log(`    POST  /api/scraper/retry/:id`);
    console.log(`    POST  /api/scraper/stop`);
    console.log(`    GET   /api/scraper/queue/metrics`);
    console.log(`    GET   /api/health`);
    console.log();
  });

  // ── 5. Graceful Shutdown ───────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    console.log(`\n[API] ${signal} received — shutting down gracefully...`);
    server.close(async () => {
      await closeRedisConnection();
      await closeConnection();
      console.log("[API] Server stopped.");
      process.exit(0);
    });
    // Force-kill if not done within 10 s
    setTimeout(() => {
      console.error("[API] Shutdown timed out — forcing exit.");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("[API] Fatal startup error:", err);
  process.exit(1);
});

export default app;
