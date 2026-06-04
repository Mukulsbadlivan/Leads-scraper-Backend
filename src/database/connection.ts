import { MongoClient, Db } from "mongodb";

// ─── Singleton state ───────────────────────────────────────────────────────────
let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Returns the cached MongoClient, connecting on first call.
 * Reads MONGODB_URI and DATABASE_NAME from process.env.
 */
export async function getClient(): Promise<MongoClient> {
  if (client) return client;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Add it to your .env file.\n" +
        "Example: MONGODB_URI=mongodb://localhost:27017"
    );
  }

  client = new MongoClient(uri, {
    // Sensible production defaults
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 10,
  });

  await client.connect();
  console.log("✅ MongoDB connected.");
  return client;
}

/**
 * Returns the cached Db instance for the configured database.
 */
export async function getDb(): Promise<Db> {
  if (db) return db;

  const c = await getClient();
  const name = process.env.DATABASE_NAME || "icp_leads";
  db = c.db(name);
  return db;
}

/**
 * Gracefully closes the MongoDB connection.
 * Should be called in finally blocks or on process exit.
 */
export async function closeConnection(): Promise<void> {
  if (!client) return;
  await client.close();
  client = null;
  db = null;
  console.log("🔌 MongoDB connection closed.");
}
