/**
 * testDb.ts — Scratch script to test MongoDB connection and verify index creation.
 */
import "dotenv/config";
import { initStartupDb } from "../database/initStartupDb.ts";
import { getDb, closeConnection } from "../database/connection.ts";

async function main() {
  console.log("🔌 Testing database connection...");
  try {
    const db = await getDb();
    console.log(`✅ Connected to database: ${db.databaseName}`);
    
    console.log("📦 Ensuring startup intelligence collections and indexes...");
    await initStartupDb();
    
    console.log("📋 Verifying collection indexes:");
    const collections = [
      "startup_companies",
      "startup_executives",
      "startup_leads",
      "company_news",
      "funding_events",
      "hiring_events",
      "growth_events"
    ];
    
    for (const name of collections) {
      const indexes = await db.collection(name).indexes();
      console.log(`  - Collection '${name}' has ${indexes.length} indexes.`);
    }
  } catch (err: any) {
    console.error("❌ Database test failed:", err.message);
  } finally {
    await closeConnection();
  }
}

main().catch(console.error);
