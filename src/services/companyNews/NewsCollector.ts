/**
 * NewsCollector.ts — Collects company news from multiple free and paid sources.
 *
 * Sources (all gracefully degraded):
 *   Free: Google News RSS, TechCrunch RSS, VentureBeat RSS
 *   Paid: NewsAPI.org (NEWS_API_KEY), Bing News (BING_NEWS_API_KEY)
 *
 * ISOLATED — writes only to company_news collection.
 */
import https from "https";
import { ObjectId } from "mongodb";
import { getDb } from "../../database/connection.ts";
import {
  insertCompanyNews,
  buildContentHash,
  newsHashExists,
} from "../../database/repositories/CompanyNewsRepository.ts";
import { NewsEventType } from "../../database/models/CompanyNews.ts";
import { classifyNewsArticle } from "./NewsClassifier.ts";
import { linkNewsToCompany } from "./NewsEnricher.ts";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 StartupNewsBot/1.0" }, timeout: timeoutMs },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      }
    );
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

export interface RawArticle {
  title: string;
  url: string;
  publishedAt?: Date;
  source: string;
  rawText?: string;
  companyName?: string;
}

// ─── RSS Parsing ──────────────────────────────────────────────────────────────

function parseRSSFeed(xml: string, sourceName: string): RawArticle[] {
  const articles: RawArticle[] = [];
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  for (const item of items) {
    const content = item[1];
    const title = (content.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? "")
      .replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const url = (content.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim();
    const pubDate = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();

    if (!title || !url) continue;
    // Only keep startup/funding/hiring relevant articles
    if (!/raises?|funding|series|seed|hires?|appoints?|acqui|launch|expand|growth|startup|venture/i.test(title)) {
      continue;
    }

    articles.push({
      title,
      url,
      publishedAt: pubDate ? new Date(pubDate) : new Date(),
      source: sourceName,
    });
  }
  return articles;
}

// ─── Free RSS Sources ─────────────────────────────────────────────────────────

async function collectFromRSS(lookbackDays: number): Promise<RawArticle[]> {
  const feeds = [
    { url: "https://techcrunch.com/tag/startups/feed/", name: "TechCrunch" },
    { url: "https://techcrunch.com/tag/funding/feed/", name: "TechCrunch" },
    { url: "https://venturebeat.com/category/business/feed/", name: "VentureBeat" },
    { url: "https://feeds.feedburner.com/venturebeat/SZYF", name: "VentureBeat" },
  ];

  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const articles: RawArticle[] = [];

  for (const feed of feeds) {
    try {
      await sleep(500);
      const xml = await fetchText(feed.url, 10_000);
      if (!xml) continue;
      const parsed = parseRSSFeed(xml, feed.name);
      // Filter by date
      articles.push(...parsed.filter((a) => !a.publishedAt || a.publishedAt >= cutoff));
    } catch (err: any) {
      console.warn(`[NewsCollector] RSS ${feed.name} error:`, err.message);
    }
  }
  return articles;
}

// ─── Google News RSS ──────────────────────────────────────────────────────────

async function collectFromGoogleNews(companyNames: string[]): Promise<RawArticle[]> {
  const articles: RawArticle[] = [];
  const queries = [
    "startup funding announcement",
    "new CTO CEO CFO appointed",
    "series A B C funding round",
    ...companyNames.slice(0, 10).map((n) => `"${n}" funding OR hiring`),
  ];

  for (const query of queries) {
    try {
      await sleep(700);
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const xml = await fetchText(url, 8_000);
      if (!xml) continue;
      articles.push(...parseRSSFeed(xml, "GoogleNews"));
    } catch (err: any) {
      console.warn(`[NewsCollector] Google News error for query "${query}":`, err.message);
    }
  }
  return articles;
}

// ─── NewsAPI.org (optional paid) ──────────────────────────────────────────────

async function collectFromNewsAPI(lookbackDays: number): Promise<RawArticle[]> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return [];

  const articles: RawArticle[] = [];
  try {
    const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const queries = ["startup funding", "series A funding", "new CTO appointed", "startup acquisition"];

    for (const q of queries) {
      await sleep(1000);
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&from=${from}&sortBy=publishedAt&language=en&pageSize=20&apiKey=${apiKey}`;
      const raw = await fetchText(url, 10_000);
      const parsed = JSON.parse(raw || "{}");
      for (const art of parsed?.articles ?? []) {
        if (!art.title || !art.url) continue;
        articles.push({
          title: art.title,
          url: art.url,
          publishedAt: art.publishedAt ? new Date(art.publishedAt) : undefined,
          source: art.source?.name ?? "NewsAPI",
          rawText: art.description ?? art.content ?? "",
        });
      }
    }
  } catch (err: any) {
    console.warn("[NewsCollector] NewsAPI error:", err.message);
  }
  return articles;
}

// ─── Main Collection Orchestrator ─────────────────────────────────────────────

export interface NewsCollectionOptions {
  sources?: string[];
  companyIds?: string[];
  lookbackDays?: number;
  onProgress?: (msg: string, count: number) => void;
}

export interface NewsCollectionResult {
  articlesCollected: number;
  articlesInserted: number;
  duplicatesSkipped: number;
  errors: string[];
}

/**
 * Runs the news collection pipeline. Classifies and links each article.
 * Returns a summary of what was collected.
 */
export async function runNewsCollection(
  opts: NewsCollectionOptions = {}
): Promise<NewsCollectionResult> {
  const lookbackDays = opts.lookbackDays ?? 7;
  const sources = opts.sources ?? ["rss", "google_news", "newsapi"];
  const result: NewsCollectionResult = {
    articlesCollected: 0,
    articlesInserted: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  const allArticles: RawArticle[] = [];

  // Optionally load company names for targeted search
  let companyNames: string[] = [];
  if (opts.companyIds?.length) {
    try {
      const db = await getDb();
      const companies = await db
        .collection("startup_companies")
        .find(
          { _id: { $in: opts.companyIds.map((id) => new ObjectId(id)) } },
          { projection: { companyName: 1 } }
        )
        .toArray();
      companyNames = companies.map((c: any) => c.companyName).filter(Boolean);
    } catch { /* non-fatal */ }
  }

  for (const source of sources) {
    opts.onProgress?.(`Collecting from ${source}...`, allArticles.length);
    try {
      let batch: RawArticle[] = [];
      if (source === "rss") batch = await collectFromRSS(lookbackDays);
      else if (source === "google_news") batch = await collectFromGoogleNews(companyNames);
      else if (source === "newsapi") batch = await collectFromNewsAPI(lookbackDays);
      allArticles.push(...batch);
    } catch (err: any) {
      result.errors.push(`${source}: ${err.message}`);
    }
  }

  result.articlesCollected = allArticles.length;

  // Classify + deduplicate + insert
  for (const article of allArticles) {
    try {
      const hash = buildContentHash(article.title, article.url);
      if (await newsHashExists(hash)) {
        result.duplicatesSkipped++;
        continue;
      }

      const classification = classifyNewsArticle(article.title, article.rawText ?? "");
      const companyLinks = await linkNewsToCompany(article.title, article.url);

      const inserted = await insertCompanyNews({
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        source: article.source,
        rawText: article.rawText?.slice(0, 2000),
        eventType: classification.eventType,
        eventSubtype: classification.eventSubtype,
        classificationConfidence: classification.confidence,
        startupCompanyId: companyLinks.startupCompanyId,
        existingCompanyId: companyLinks.existingCompanyId,
        companyName: companyLinks.companyName || article.companyName,
        contentHash: hash,
        sourceTracking: [{ source: article.source, fetchedAt: new Date() }],
      });

      if (inserted) result.articlesInserted++;
    } catch (err: any) {
      result.errors.push(`Article "${article.title.slice(0, 40)}": ${err.message}`);
    }
  }

  console.log(
    `[NewsCollector] Collected ${result.articlesCollected}, ` +
    `inserted ${result.articlesInserted}, ` +
    `skipped ${result.duplicatesSkipped} duplicates.`
  );

  return result;
}
