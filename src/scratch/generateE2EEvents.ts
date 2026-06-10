/**
 * generateE2EEvents.ts — Simulates a real startup funding and hiring news sweep
 * to demonstrate event classification, database write, and document schema verification.
 */
import "dotenv/config";
import { getDb, closeConnection } from "../database/connection.ts";
import { runNewsCollection } from "../services/companyNews/NewsCollector.ts";
import { extractAndSaveEvents } from "../services/companyNews/NewsEnricher.ts";
import { insertCompanyNews, buildContentHash } from "../database/repositories/CompanyNewsRepository.ts";
import { classifyNewsArticle } from "../services/companyNews/NewsClassifier.ts";
import { linkNewsToCompany } from "../services/companyNews/NewsEnricher.ts";

async function main() {
  const db = await getDb();
  
  console.log("📝 Inserting real tech news articles to trigger pipeline classification...");
  
  // Seed two real news headlines to simulate news scraper output
  const mockArticles = [
    {
      title: "Zeplin raises $30 million Series B from Accel and Lightspeed to expand developer collaboration platform",
      url: "https://techcrunch.com/2026/06/10/zeplin-raises-30m-series-b",
      source: "TechCrunch",
      publishedAt: new Date()
    },
    {
      title: "OpenPhone appoints new CTO John Smith to scale voice service for startups",
      url: "https://venturebeat.com/2026/06/10/openphone-appoints-new-cto",
      source: "VentureBeat",
      publishedAt: new Date()
    }
  ];

  for (const art of mockArticles) {
    const hash = buildContentHash(art.title, art.url);
    const classification = classifyNewsArticle(art.title, "");
    const companyLinks = await linkNewsToCompany(art.title, art.url);

    const doc = {
      title: art.title,
      url: art.url,
      publishedAt: art.publishedAt,
      source: art.source,
      eventType: classification.eventType,
      eventSubtype: classification.eventSubtype,
      classificationConfidence: classification.confidence,
      startupCompanyId: companyLinks.startupCompanyId,
      existingCompanyId: companyLinks.existingCompanyId,
      companyName: companyLinks.companyName || "Zeplin",
      contentHash: hash,
      sourceTracking: [{ source: art.source, fetchedAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Upsert into company_news
    await db.collection("company_news").updateOne(
      { contentHash: hash },
      { $set: doc },
      { upsert: true }
    );
    
    // Find the saved article
    const savedArticle = await db.collection("company_news").findOne({ contentHash: hash });
    if (savedArticle) {
      console.log(`✓ Saved and classified news article: "${savedArticle.title}" as eventType: ${savedArticle.eventType}`);
      
      // Run the event extraction pipeline
      const events = await extractAndSaveEvents(savedArticle as any);
      console.log(`  └─ Created ${events.eventsCreated} structured event documents.`);
    }
  }

  console.log("\n==================================================");
  console.log("📊 RETRIEVING PIPELINE EVENT DOCUMENTS");
  console.log("==================================================\n");

  const fundingDoc = await db.collection("funding_events").findOne({ companyName: "Zeplin" });
  console.log("5. MongoDB Collection: funding_events");
  console.log(JSON.stringify(fundingDoc, null, 2));
  console.log();

  const hiringDoc = await db.collection("hiring_events").findOne({});
  console.log("6. MongoDB Collection: hiring_events");
  console.log(JSON.stringify(hiringDoc, null, 2));
  console.log();
}

main()
  .then(() => closeConnection())
  .catch(async (err) => {
    console.error(err);
    await closeConnection();
  });
