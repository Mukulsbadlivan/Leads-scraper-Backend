/**
 * redis.ts — Production-ready ioredis connection factory for BullMQ.
 *
 * Connection priority:
 *   1. REDIS_URL  (full URL — takes priority; TLS auto-detected from rediss://)
 *   2. REDIS_HOST + REDIS_PORT + REDIS_PASSWORD  (explicit split config)
 *   3. Defaults: localhost:6379
 *
 * Cloud provider support (zero code changes — set env vars only):
 *   Upstash:     REDIS_URL=rediss://:token@host.upstash.io:6379
 *   Redis Cloud: REDIS_HOST=host REDIS_PORT=port REDIS_PASSWORD=pass REDIS_TLS=true
 *   ElastiCache: REDIS_HOST=cluster.cache.amazonaws.com REDIS_TLS=true
 */
import { Redis, type RedisOptions } from "ioredis";

// ─── Config resolution ────────────────────────────────────────────────────────

/**
 * Parsed snapshot of the resolved Redis configuration.
 * Used for startup logging and the /api/health endpoint.
 */
export interface RedisConfig {
  /** The resolved connection URL (or synthesised from host/port) */
  url: string;
  /** Sanitised host string — password redacted */
  displayHost: string;
  /** True when TLS is active */
  tls: boolean;
  /** True when connecting via a full REDIS_URL */
  usingUrl: boolean;
}

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    // URL may look like: rediss://:password@host.upstash.io:6379
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "localhost",
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    };
  } catch {
    return { host: "localhost", port: 6379 };
  }
}

/**
 * Resolves the active Redis configuration from environment variables.
 * Call once at startup to display/log the resolved config.
 */
export function resolveRedisConfig(): RedisConfig {
  const envUrl = (process.env.REDIS_URL || "").trim();

  // Treat empty string the same as unset — fall through to host/port config
  if (envUrl) {
    const isTls = envUrl.startsWith("rediss://");
    const { host, port } = parseRedisUrl(envUrl);
    // Redact password from display string
    const displayHost = `${host}:${port}${isTls ? " (TLS)" : ""}`;
    return {
      url: envUrl,
      displayHost,
      tls: isTls,
      usingUrl: true,
    };
  }

  const host = process.env.REDIS_HOST || "localhost";
  const port = parseInt(process.env.REDIS_PORT || "6379", 10);
  const tls = process.env.REDIS_TLS === "true";
  const db = process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0;

  const proto = tls ? "rediss" : "redis";
  const password = process.env.REDIS_PASSWORD;
  const auth = password ? `:${password}@` : "";
  const dbSuffix = db > 0 ? `/${db}` : "";

  return {
    url: `${proto}://${auth}${host}:${port}${dbSuffix}`,
    displayHost: `${host}:${port}${tls ? " (TLS)" : ""}`,
    tls,
    usingUrl: false,
  };
}

// ─── Options builder ──────────────────────────────────────────────────────────

/**
 * BullMQ-compatible options that apply to every connection:
 *   - maxRetriesPerRequest: null  (required by BullMQ)
 *   - enableReadyCheck: false     (required by BullMQ for Upstash/serverless)
 */
const BULLMQ_REQUIRED: Pick<RedisOptions, "maxRetriesPerRequest" | "enableReadyCheck"> = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

function buildOptions(retryCount = { value: 0 }): RedisOptions {
  const envUrl = (process.env.REDIS_URL || "").trim();

  // ── URL-based config (Upstash, Redis Cloud, etc.) ────────────────────────
  if (envUrl) {
    const isTls = envUrl.startsWith("rediss://");
    return {
      ...BULLMQ_REQUIRED,
      ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
      retryStrategy(times: number) {
        retryCount.value = times;
        if (times >= 10) return null; // stop retrying after 10 attempts
        const delay = Math.min(times * 1000, 30_000);
        const { host, port } = parseRedisUrl(envUrl);
        console.warn(
          `[Redis] ⚠️  Reconnecting in ${delay}ms — attempt ${times} — host: ${host}:${port}`
        );
        return delay;
      },
    };
  }

  // ── Split-config (host/port/password) ────────────────────────────────────
  const host = process.env.REDIS_HOST || "localhost";
  const port = parseInt(process.env.REDIS_PORT || "6379", 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const db = process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0;
  const tls = process.env.REDIS_TLS === "true";

  return {
    host,
    port,
    password,
    db,
    ...BULLMQ_REQUIRED,
    ...(tls ? { tls: { rejectUnauthorized: false } } : {}),
    retryStrategy(times: number) {
      retryCount.value = times;
      if (times >= 10) return null; // stop retrying after 10 attempts
      const delay = Math.min(times * 1000, 30_000);
      console.warn(
        `[Redis] ⚠️  Reconnecting in ${delay}ms — attempt ${times} — host: ${host}:${port}`
      );
      return delay;
    },
  };
}

// ─── Singleton connection ─────────────────────────────────────────────────────

let redisInstance: Redis | null = null;

/**
 * Returns the singleton Redis connection used for health checks and
 * direct Redis operations. Do NOT pass this to BullMQ — use
 * `createRedisConnection()` instead (BullMQ needs its own connections).
 */
export function getRedisConnection(): Redis {
  if (redisInstance) return redisInstance;

  const retryCount = { value: 0 };
  const envUrl = (process.env.REDIS_URL || "").trim();
  const options = buildOptions(retryCount);

  if (envUrl) {
    redisInstance = new Redis(envUrl, options);
  } else {
    redisInstance = new Redis(options);
  }

  const cfg = resolveRedisConfig();

  redisInstance.on("connect", () => {
    console.log(`  ✓ Redis Connected  →  ${cfg.displayHost}`);
  });

  redisInstance.on("error", (err: Error) => {
    // Surface the full error message, host, and retry count
    console.error(
      `[Redis] ✗ Error — host: ${cfg.displayHost} | attempt: ${retryCount.value} | ${err.message}`
    );
  });

  redisInstance.on("reconnecting", () => {
    console.warn(
      `[Redis] ↺ Reconnecting — host: ${cfg.displayHost} | attempt: ${retryCount.value}`
    );
  });

  redisInstance.on("ready", () => {
    console.log(`[Redis] ✓ Ready — host: ${cfg.displayHost}`);
  });

  return redisInstance;
}

/**
 * Creates a FRESH dedicated Redis connection for a BullMQ Queue/Worker/QueueEvents.
 * BullMQ requires one connection per construct — never share the singleton.
 */
export function createRedisConnection(): Redis {
  const envUrl = (process.env.REDIS_URL || "").trim();
  const options = buildOptions();

  if (envUrl) {
    return new Redis(envUrl, options);
  }
  return new Redis(options);
}

// ─── Startup validation ───────────────────────────────────────────────────────

/**
 * Validates the Redis connection by pinging the server.
 * Throws an error with a descriptive message if the connection fails.
 * Intended to be called at startup — if Redis is unreachable the process exits.
 *
 * @param timeoutMs  How long to wait for the ping response (default: 5000ms)
 */
export async function validateRedisConnection(timeoutMs = 5_000): Promise<void> {
  const cfg = resolveRedisConfig();
  const redis = getRedisConnection();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `Redis connection timed out after ${timeoutMs}ms — host: ${cfg.displayHost}`
          )
        ),
      timeoutMs
    )
  );

  try {
    const pong = await Promise.race([redis.ping(), timeout]);
    if (pong !== "PONG") {
      throw new Error(`Unexpected ping response: ${pong}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[Redis] ✗ Connection failed — host: ${cfg.displayHost}\n` +
      `  Error: ${message}\n` +
      `  Check: REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_PASSWORD env vars.`
    );
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * Returns "connected" if Redis can be pinged, "disconnected" otherwise.
 * Non-throwing — safe to call inside the /api/health route.
 */
export async function checkRedisHealth(): Promise<"connected" | "disconnected"> {
  try {
    const redis = getRedisConnection();
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
    ]);
    return pong === "PONG" ? "connected" : "disconnected";
  } catch {
    return "disconnected";
  }
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

/**
 * Gracefully closes the singleton Redis connection.
 * Call on process shutdown (SIGTERM / SIGINT).
 */
export async function closeRedisConnection(): Promise<void> {
  if (!redisInstance) return;
  try {
    await redisInstance.quit();
  } catch {
    redisInstance.disconnect();
  }
  redisInstance = null;
  console.log("[Redis] 🔌 Connection closed.");
}

// Lazy singleton — exported for direct use (health checks, scripts)
export const redisConnection = getRedisConnection();
