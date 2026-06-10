/**
 * NewsDeduplicator.ts — Deduplication for company_news collection.
 *
 * Primary dedup: contentHash (SHA-256 of title + url) — enforced by unique index.
 * Secondary dedup: finds near-duplicate titles and flags them.
 *
 * ISOLATED — only operates on company_news collection.
 */
import { createHash } from "crypto";
import { getDb } from "../../database/connection.ts";

const COMPANY_NEWS = "company_news";

export interface NewsDeduplicationSummary {
  totalScanned: number;
  exactDuplicatesRemoved: number;
  nearDuplicateGroups: number;
  errors: string[];
}

/** Creates a normalized title for near-duplicate detection. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 8) // Use first 8 words as fingerprint
    .join(" ");
}

/**
 * Runs a deduplication sweep on company_news.
 * Removes exact URL duplicates (should be caught by unique index, but belt-and-suspenders).
 * Flags near-duplicate titles (same first 8 words) and removes older ones.
 */
export async function deduplicateCompanyNews(): Promise<NewsDeduplicationSummary> {
  const summary: NewsDeduplicationSummary = {
    totalScanned: 0,
    exactDuplicatesRemoved: 0,
    nearDuplicateGroups: 0,
    errors: [],
  };

  try {
    const db = await getDb();
    const col = db.collection(COMPANY_NEWS);

    summary.totalScanned = await col.countDocuments({});

    // Stage 1: Exact URL dedup (catches cases where contentHash index was bypassed)
    const urlDuplicates = await col
      .aggregate([
        { $group: { _id: "$url", ids: { $push: "$_id" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    for (const group of urlDuplicates) {
      try {
        // Keep the oldest document (first discovered), remove the rest
        const [, ...toRemove] = group.ids;
        await col.deleteMany({ _id: { $in: toRemove } });
        summary.exactDuplicatesRemoved += toRemove.length;
      } catch (err: any) {
        summary.errors.push(`URL dedup: ${err.message}`);
      }
    }

    // Stage 2: Near-duplicate detection by normalized title prefix
    const recentArticles = await col
      .find({}, { projection: { _id: 1, title: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .limit(5000)
      .toArray();

    const titleMap = new Map<string, typeof recentArticles>();
    for (const doc of recentArticles) {
      const norm = normalizeTitle(doc.title || "");
      if (!norm) continue;
      if (!titleMap.has(norm)) titleMap.set(norm, []);
      titleMap.get(norm)!.push(doc);
    }

    for (const [, docs] of titleMap) {
      if (docs.length < 2) continue;
      try {
        summary.nearDuplicateGroups++;
        // Sort by createdAt ascending — keep oldest, remove rest
        docs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const [, ...nearDups] = docs;
        await col.deleteMany({ _id: { $in: nearDups.map((d) => d._id) } });
      } catch (err: any) {
        summary.errors.push(`Near-dup: ${err.message}`);
      }
    }
  } catch (err: any) {
    summary.errors.push(`Sweep failed: ${err.message}`);
  }

  console.log(
    `[NewsDeduplicator] Scanned ${summary.totalScanned}, ` +
    `removed ${summary.exactDuplicatesRemoved} exact, ` +
    `found ${summary.nearDuplicateGroups} near-duplicate groups.`
  );

  return summary;
}
