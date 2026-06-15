// @ts-nocheck
// ─── Browser Context Pool ─────────────────────────────────────────────────────
// Manages a fixed pool of Playwright browser contexts to avoid repeatedly
// launching Chromium instances.
//
// Architecture:
//   - Single browser instance (passed in from the Orchestrator)
//   - Up to BROWSER_POOL_SIZE reusable contexts
//   - acquire() blocks until a context is free
//   - release() returns the context to the pool (clears cookies)
//
// Render Free Tier safe default: BROWSER_POOL_SIZE=2

import { Browser, BrowserContext } from "playwright";
import { perfStart, perfEnd } from "./perf.ts";

const MAX_CONTEXTS = parseInt(process.env.BROWSER_POOL_SIZE || "2", 10);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface PoolEntry {
  context: BrowserContext;
  inUse: boolean;
  acquiredAt?: number;
  acquiredFrom?: string;
}

export class BrowserPool {
  private browser: Browser;
  private pool: PoolEntry[] = [];
  private waiters: Array<(ctx: BrowserContext) => void> = [];

  constructor(browser: Browser) {
    this.browser = browser;
  }

  /**
   * Pre-warm the pool by creating contexts up-front.
   * Call after BrowserPool is instantiated.
   */
  async init(): Promise<void> {
    const t = perfStart("BrowserPool.init");
    const promises = [];
    for (let i = 0; i < MAX_CONTEXTS; i++) {
      promises.push(this._createContext());
    }
    await Promise.allSettled(promises);
    perfEnd(t);
    console.log(`[BrowserPool] ✅ Initialized ${this.pool.length}/${MAX_CONTEXTS} contexts (BROWSER_POOL_SIZE=${MAX_CONTEXTS})`);
  }

  private async _createContext(): Promise<void> {
    try {
      const context = await Promise.race([
        this.browser.newContext({
          userAgent: USER_AGENT,
          viewport: { width: 1280, height: 800 },
          // Block images/fonts to reduce memory and speed up page loads
          extraHTTPHeaders: {
            "Accept-Language": "en-US,en;q=0.9",
          },
        }),
        new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error("BrowserPool newContext timeout (15s)")), 15000)
        )
      ]);
      // Abort image/font/media requests to conserve memory
      await context.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,otf,mp4,mp3}", (route) =>
        route.abort()
      );
      this.pool.push({ context, inUse: false });
    } catch (err) {
      console.warn(`[BrowserPool] ⚠️ Failed to create context: ${err.message}`);
    }
  }

  private _checkLeaks(): void {
    const now = Date.now();
    this.pool.forEach((e, idx) => {
      if (e.inUse && e.acquiredAt && (now - e.acquiredAt > 90000)) {
        console.warn(`[BrowserPool] ⚠️ Leak detected? Context #${idx} has been held for ${Math.round((now - e.acquiredAt) / 1000)}s. Acquired from: ${e.acquiredFrom}`);
      }
    });
  }

  async acquire(timeoutMs = 30000): Promise<BrowserContext> {
    if (this.pool.length === 0) {
      throw new Error("[BrowserPool] Cannot acquire context: Pool is empty or failed to initialize.");
    }

    this._checkLeaks();

    const stack = new Error().stack || "";
    const acquiredFrom = stack.split("\n").slice(2, 4).map(l => l.trim()).join(" -> ");

    // Look for a free context in the pool
    const entry = this.pool.find((e) => !e.inUse);
    if (entry) {
      entry.inUse = true;
      entry.acquiredAt = Date.now();
      entry.acquiredFrom = acquiredFrom;
      console.log(`[BrowserPool] 🔒 Context acquired (${this._usedCount()}/${this.pool.length} in use) from: ${acquiredFrom}`);
      return entry.context;
    }

    // All contexts are busy — wait for one to be released
    console.log(`[BrowserPool] ⏳ All contexts busy, waiting... (${this._usedCount()}/${this.pool.length}) from: ${acquiredFrom}`);
    return new Promise<BrowserContext>((resolve, reject) => {
      const wrappedResolve = (ctx: BrowserContext) => {
        clearTimeout(timer);
        const e = this.pool.find((x) => x.context === ctx);
        if (e) {
          e.inUse = true;
          e.acquiredAt = Date.now();
          e.acquiredFrom = acquiredFrom;
          console.log(`[BrowserPool] 🔒 Context acquired after wait (${this._usedCount()}/${this.pool.length} in use) from: ${acquiredFrom}`);
        }
        resolve(ctx);
      };

      const timer = setTimeout(() => {
        // Remove from waiters list to prevent leak
        const idx = this.waiters.indexOf(wrappedResolve);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error(`[BrowserPool] Timeout waiting for browser context (${timeoutMs}ms). Requested from: ${acquiredFrom}`));
      }, timeoutMs);

      this.waiters.push(wrappedResolve);
    });
  }

  /**
   * Release a context back to the pool.
   * Clears cookies and storage so the next caller gets a clean slate.
   */
  async release(context: BrowserContext): Promise<void> {
    const entry = this.pool.find((e) => e.context === context);
    if (!entry) {
      // Context not from this pool — just close it
      try { await context.close(); } catch { /* ignore */ }
      return;
    }

    // Reset context state for the next user
    try {
      await context.clearCookies();
    } catch { /* non-fatal */ }

    const heldDuration = entry.acquiredAt ? Date.now() - entry.acquiredAt : 0;
    const acquiredFrom = entry.acquiredFrom || "unknown";

    entry.inUse = false;
    entry.acquiredAt = undefined;
    entry.acquiredFrom = undefined;
    console.log(`[BrowserPool] 🔓 Context released (held for ${heldDuration}ms, acquired from: ${acquiredFrom}) (${this._usedCount()}/${this.pool.length} in use)`);

    // Wake up a waiter if any are queued
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(entry.context);
    }
  }

  /**
   * Run a callback with an automatically acquired + released context.
   * This is the safest way to use the pool.
   */
  async withContext<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    const ctx = await this.acquire();
    try {
      return await fn(ctx);
    } finally {
      await this.release(ctx);
    }
  }

  /**
   * Close all pooled contexts and the browser.
   */
  async close(): Promise<void> {
    await Promise.allSettled(this.pool.map((e) => e.context.close().catch(() => {})));
    this.pool = [];
    console.log("[BrowserPool] 🛑 All contexts closed");
  }

  private _usedCount(): number {
    return this.pool.filter((e) => e.inUse).length;
  }
}
