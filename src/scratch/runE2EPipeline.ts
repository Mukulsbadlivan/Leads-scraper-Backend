/**
 * runE2EPipeline.ts — End-to-end pipeline run script to generate real documents.
 * Discover, deduplicate, enrich, score, fetch news, extract events, and print.
 */
import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeConnection } from "../database/connection.ts";
import { initStartupDb } from "../database/initStartupDb.ts";
import { runStartupDiscovery } from "../services/startup/StartupDiscovery.ts";
import { deduplicateStartupCompanies } from "../services/startup/StartupDeduplicator.ts";
import { enrichStartupBatch } from "../services/startup/StartupEnricher.ts";
import { scoreAndSaveStartupLead } from "../services/startup/StartupScorer.ts";
import { runNewsCollection } from "../services/companyNews/NewsCollector.ts";
import { deduplicateCompanyNews } from "../services/companyNews/NewsDeduplicator.ts";
import { extractAndSaveEvents } from "../services/companyNews/NewsEnricher.ts";
import { listStartupCompaniesForEnrichment } from "../database/repositories/StartupCompanyRepository.ts";
import { findExecutivesByCompany } from "../database/repositories/StartupExecutiveRepository.ts";
import { ObjectId } from "mongodb";

async function main() {
  const runId = uuidv4();
  console.log(`🚀 Starting E2E pipeline run with Run ID: ${runId}`);
  
  // 1. Setup DB
  const db = await getDb();
  await initStartupDb();
  
  // 2. Discover companies (Request 10 to ensure we get at least 5)
  console.log("\n🔍 Phase 1: Discovering startup companies...");
  const discovery = await runStartupDiscovery({
    sources: ["yc", "rss"],
    maxCompanies: 8
  });
  console.log(`✓ Discovered ${discovery.discovered} companies.`);
  
  // 3. Deduplicate
  console.log("\n🧹 Phase 2: Deduplicating startups...");
  await deduplicateStartupCompanies();
  
  // 4. Get the discovered companies for enrichment
  const companies = await db.collection("startup_companies")
    .find({})
    .sort({ createdAt: -1 })
    .limit(6)
    .toArray();
    
  if (companies.length < 5) {
    console.warn(`⚠️ Warning: Only found ${companies.length} companies. Seed some extra names to guarantee 5.`);
    // Seed a couple of YC companies if discovery returned less than 5
    const fallbacks = [
      { companyName: "Kipwise", website: "https://kipwise.com", industry: "SaaS", sector: "Technology", isYCBacked: true, ycBatch: "S18" },
      { companyName: "OpenPhone", website: "https://openphone.com", industry: "SaaS", sector: "Technology", isYCBacked: true, ycBatch: "S18" },
      { companyName: "Zeplin", website: "https://zeplin.io", industry: "Developer Tools", sector: "Technology", isYCBacked: true, ycBatch: "Y15" }
    ];
    for (const fb of fallbacks) {
      await db.collection("startup_companies").updateOne(
        { website: fb.website },
        { $setOnInsert: { ...fb, createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true }
      );
    }
  }

  // Refetch
  const activeCompanies = await db.collection("startup_companies")
    .find({})
    .sort({ createdAt: -1 })
    .limit(6)
    .toArray();
    
  console.log(`✓ Active startups under test: ${activeCompanies.length}`);
  
  // 5. Enrich executive profiles (Founders, CEOs)
  console.log("\n👥 Phase 3: Enriching founders and executive profiles...");
  const enrichment = await enrichStartupBatch(activeCompanies as any);
  console.log(`✓ Enriched: ${enrichment.totalEnriched} companies, found ${enrichment.totalExecutives} executives.`);
  
  // 6. Score and save startup leads
  console.log("\n📈 Phase 4: Scoring startups and saving leads...");
  for (const company of activeCompanies) {
    if (!company._id) continue;
    const executives = await findExecutivesByCompany(company._id as ObjectId);
    await scoreAndSaveStartupLead(company as any, executives);
  }
  console.log("✓ Startup leads generated.");
  
  // 7. Collect recent news
  console.log("\n📰 Phase 5: Fetching recent news articles...");
  const companyIds = activeCompanies.map(c => c._id!.toString());
  const news = await runNewsCollection({
    sources: ["google_news", "rss"],
    companyIds,
    lookbackDays: 14
  });
  console.log(`✓ Collected ${news.articlesCollected} articles, inserted ${news.articlesInserted}.`);
  
  // 8. Deduplicate news & extract events
  console.log("\n🧹 Phase 6: News deduplication and event classification...");
  await deduplicateCompanyNews();
  
  const recentArticles = await db.collection("company_news")
    .find({ startupCompanyId: { $in: activeCompanies.map(c => c._id) } })
    .toArray();
    
  let fundingCreated = 0;
  let hiringCreated = 0;
  let growthCreated = 0;
  
  for (const article of recentArticles) {
    const events = await extractAndSaveEvents(article as any);
    fundingCreated += events.eventsCreated; // our event counts
  }
  console.log("✓ Event classification completed.");
  
  // 9. Query and fetch sample documents from each of the collections
  console.log("\n==================================================");
  console.log("📊 PRINTING RESULTS FROM MONGODB");
  console.log("==================================================\n");
  
  // Get 1 company
  const sampleCompany = await db.collection("startup_companies").findOne({
    _id: { $in: activeCompanies.map(c => c._id) }
  });
  console.log(`--- startup_companies ---`);
  console.log(JSON.stringify(sampleCompany, null, 2));
  console.log();
  
  // Get executive linked to this company
  if (sampleCompany) {
    const sampleExecutive = await db.collection("startup_executives").findOne({
      startupCompanyId: sampleCompany._id
    });
    console.log(`--- startup_executives ---`);
    console.log(JSON.stringify(sampleExecutive, null, 2));
    console.log();

    const sampleLead = await db.collection("startup_leads").findOne({
      startupCompanyId: sampleCompany._id
    });
    console.log(`--- startup_leads ---`);
    console.log(JSON.stringify(sampleLead, null, 2));
    console.log();
  }
  
  // Get news article
  const sampleNews = await db.collection("company_news").findOne({
    startupCompanyId: { $in: activeCompanies.map(c => c._id) }
  });
  console.log(`--- company_news ---`);
  console.log(JSON.stringify(sampleNews, null, 2));
  console.log();

  if (sampleNews) {
    const sampleFunding = await db.collection("funding_events").findOne({
      newsId: sampleNews._id
    });
    console.log(`--- funding_events ---`);
    console.log(JSON.stringify(sampleFunding, null, 2));
    console.log();
    
    const sampleHiring = await db.collection("hiring_events").findOne({
      newsId: sampleNews._id
    });
    console.log(`--- hiring_events ---`);
    console.log(JSON.stringify(sampleHiring, null, 2));
    console.log();
  }
  
  // 10. Summary Metrics
  const stats = {
    totalStartups: await db.collection("startup_companies").countDocuments(),
    totalExecutives: await db.collection("startup_executives").countDocuments(),
    totalNews: await db.collection("company_news").countDocuments(),
    totalFunding: await db.collection("funding_events").countDocuments(),
    totalHiring: await db.collection("hiring_events").countDocuments()
  };
  
  console.log("--- Pipeline Run Summary Metrics ---");
  console.log(JSON.stringify(stats, null, 2));
}

main()
  .then(() => closeConnection())
  .catch(async (err) => {
    console.error("Pipeline run error:", err);
    await closeConnection();
  });
