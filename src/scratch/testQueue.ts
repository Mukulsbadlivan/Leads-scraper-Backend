/**
 * testQueue.ts — Scratch script to test Redis connection and verify BullMQ queues.
 */
import "dotenv/config";
import { createRedisConnection } from "../queue/redis.ts";
import { startupQueue } from "../queue/startupQueue.ts";
import { companyNewsQueue } from "../queue/companyNewsQueue.ts";

async function main() {
  console.log("🔌 Testing Redis connection...");
  const conn = createRedisConnection();
  
  try {
    console.log("📡 Pinging Redis...");
    const pingResult = await conn.ping();
    console.log(`✅ Redis ping response: ${pingResult}`);
    
    console.log("📦 Checking startupQueue status...");
    const startupWaiting = await startupQueue.getWaitingCount();
    console.log(`  - startupQueue is online. Waiting jobs: ${startupWaiting}`);
    
    console.log("📦 Checking companyNewsQueue status...");
    const newsWaiting = await companyNewsQueue.getWaitingCount();
    console.log(`  - companyNewsQueue is online. Waiting jobs: ${newsWaiting}`);
  } catch (err: any) {
    console.error("❌ Redis/Queue verification failed:", err.message);
  } finally {
    // Close redis connection
    await conn.quit();
    console.log("🔌 Redis connection closed.");
    process.exit(0);
  }
}

main().catch(console.error);
