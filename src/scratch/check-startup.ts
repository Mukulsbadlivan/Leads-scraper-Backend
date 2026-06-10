import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

async function run() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.DATABASE_NAME || "lead-intelligence";
  const port = process.env.API_PORT || "3000";

  console.log("=== DIAGNOSTICS START ===");
  console.log("DB Name:", dbName);
  console.log("API Port:", port);

  // 1. Check DEPLOYED backend endpoints
  console.log("\n--- Testing Deployed Backend (Render) Endpoints ---");
  const deployedBackend = "https://leads-scraper-backend-x2zc.onrender.com";
  const endpoints = [
    `/api/startup/dashboard`,
    `/api/startup/companies`,
    `/api/startup/executives`,
    `/api/startup/queue/metrics`
  ];

  for (const endpoint of endpoints) {
    const url = `${deployedBackend}${endpoint}`;
    try {
      const res = await axios.get(url, { timeout: 10000 });
      console.log(`✅ GET ${url} -> Status: ${res.status}`);
      console.log(`   Response sample:`, JSON.stringify(res.data).substring(0, 300));
    } catch (err: any) {
      console.log(`❌ GET ${url} failed -> Status/Error:`, err.response?.status ?? err.message);
      if (err.response?.data) {
        console.log(`   Error Response:`, err.response.data);
      }
    }
  }

  // 2. MongoDB Checks
  console.log("\n--- Checking MongoDB Contents ---");
  if (!uri) {
    console.error("❌ MONGODB_URI is not set!");
    return;
  }
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const targets = [
      "startup_companies",
      "startup_executives",
      "startup_leads",
      "company_news",
      "funding_events",
      "hiring_events",
      "growth_events"
    ];

    for (const name of targets) {
      const count = await db.collection(name).countDocuments();
      console.log(`- Collection '${name}' count: ${count}`);
      if (count > 0) {
        const sample = await db.collection(name).findOne();
        console.log(`  Sample:`, JSON.stringify(sample).substring(0, 200));
      }
    }
  } catch (err: any) {
    console.error("❌ MongoDB connection error:", err.message);
  } finally {
    await client.close();
  }

  console.log("\n=== DIAGNOSTICS END ===");
}

run().catch(console.error);
