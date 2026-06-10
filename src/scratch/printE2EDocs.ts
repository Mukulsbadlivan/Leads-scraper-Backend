/**
 * printE2EDocs.ts — Fetch and print actual MongoDB documents created by the pipeline.
 */
import "dotenv/config";
import { getDb, closeConnection } from "../database/connection.ts";

async function main() {
  const db = await getDb();
  
  console.log("\n==================================================");
  console.log("📊 RETRIEVING COMPLETED PIPELINE DOCUMENTS");
  console.log("==================================================\n");
  
  // 1. Startup Company
  const company = await db.collection("startup_companies").findOne({});
  console.log("1. MongoDB Collection: startup_companies");
  console.log(JSON.stringify(company, null, 2));
  console.log();
  
  // 2. Startup Executive (find any executive, since 1 exists in the collection)
  const executive = await db.collection("startup_executives").findOne({});
  console.log("2. MongoDB Collection: startup_executives");
  console.log(JSON.stringify(executive, null, 2));
  console.log();
  
  // 3. Startup Lead
  const lead = await db.collection("startup_leads").findOne({});
  console.log("3. MongoDB Collection: startup_leads");
  console.log(JSON.stringify(lead, null, 2));
  console.log();
  
  // 4. Company News (find any news article, since 296 exist in the collection)
  const news = await db.collection("company_news").findOne({});
  console.log("4. MongoDB Collection: company_news");
  console.log(JSON.stringify(news, null, 2));
  console.log();

  // 5. Funding Event (find any funding event)
  const funding = await db.collection("funding_events").findOne({});
  console.log("5. MongoDB Collection: funding_events");
  console.log(JSON.stringify(funding, null, 2));
  console.log();

  // 6. Hiring Event (find any hiring event)
  const hiring = await db.collection("hiring_events").findOne({});
  console.log("6. MongoDB Collection: hiring_events");
  console.log(JSON.stringify(hiring, null, 2));
  console.log();
}

main()
  .then(() => closeConnection())
  .catch(async (err) => {
    console.error(err);
    await closeConnection();
  });
