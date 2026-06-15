// @ts-nocheck
// ─── Performance Instrumentation ─────────────────────────────────────────────
// Usage:
//   const t = perfStart("Enrichment");
//   // ... do work
//   perfEnd(t);
//
// Output:
//   [PERF] Stage: Enrichment | Duration: 4.23s

const PERF_ENABLED = process.env.PERF_LOGGING !== "false";

export interface PerfHandle {
  label: string;
  start: number;
}

/**
 * Start a performance timer for a named stage.
 * @param label  Human-readable stage name (e.g. "Portal Scraping", "Enrichment")
 */
export function perfStart(label: string): PerfHandle {
  return { label, start: Date.now() };
}

/**
 * End a performance timer and log the duration.
 * @param handle  The object returned by perfStart()
 * @returns       Duration in milliseconds
 */
export function perfEnd(handle: PerfHandle): number {
  const durationMs = Date.now() - handle.start;
  if (PERF_ENABLED) {
    const durationSec = (durationMs / 1000).toFixed(2);
    console.log(`[PERF] Stage: ${handle.label} | Duration: ${durationSec}s`);
  }
  return durationMs;
}

/**
 * Wrap an async function with automatic perf timing.
 * @param label  Stage name
 * @param fn     Async function to time
 */
export async function perfWrap<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = perfStart(label);
  try {
    return await fn();
  } finally {
    perfEnd(t);
  }
}
