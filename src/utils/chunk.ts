// @ts-nocheck
// ─── Array Chunking Utility ───────────────────────────────────────────────────

/**
 * Splits an array into chunks of a given size.
 *
 * @example
 * chunk([1,2,3,4,5], 2) → [[1,2],[3,4],[5]]
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("chunk size must be > 0");
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
