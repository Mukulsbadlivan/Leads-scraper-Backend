/**
 * companyNormalizer.ts — Normalizes company names by removing corporate suffixes,
 * punctuation, and standardizing casing for deduplication.
 */

export function normalizeCompanyName(name: string): string {
  if (!name) return "";

  // 1. Lowercase and trim
  let clean = name.toLowerCase().trim();

  // 2. Remove common corporate suffixes (ignoring trailing dots)
  // Ordered by length descending or specific patterns to prevent partial replacements
  const suffixes = [
    /\bpvt\s*ltd\b/g,
    /\bpvt\.\s*ltd\./g,
    /\bpvt\.\s*ltd\b/g,
    /\bprivate\s*limited\b/g,
    /\blimited\b/g,
    /\bl\.l\.c\./g,
    /\bl\.t\.d\./g,
    /\bi\.n\.c\./g,
    /\bllc\b/g,
    /\bltd\b/g,
    /\binc\b/g
  ];

  for (const regex of suffixes) {
    clean = clean.replace(regex, "");
  }

  // 3. Remove all punctuation characters except spaces
  clean = clean.replace(/[^\w\s]/g, "");

  // 4. Collapse multiple whitespaces and trim again
  clean = clean.replace(/\s+/g, " ").trim();

  return clean;
}
