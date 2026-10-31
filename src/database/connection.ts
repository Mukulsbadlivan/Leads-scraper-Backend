import { MongoClient, Db } from "mongodb";

// ─── Singleton state ───────────────────────────────────────────────────────────
let client: MongoClient | null = null;
let db: Db | null = null;
let clientPromise: Promise<MongoClient> | null = null;

/**
 * Returns the cached MongoClient, connecting on first call.
 * A failed connect must never leave a half-initialized client in the singleton:
 * the API server intentionally remains available when MongoDB is temporarily
 * unavailable, so later requests must be able to retry the connection.
 */
export async function getClient(): Promise<MongoClient> {
  if (client) return client;
  if (clientPromise) return clientPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Add it to your .env file.\n" +
        "Example: MONGODB_URI=mongodb://localhost:27017"
    );
  }

  const candidate = new MongoClient(uri, {
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 10,
  });

  // Share one in-flight connection attempt across concurrent API requests.
  clientPromise = candidate
    .connect()
    .then((connectedClient) => {
      client = connectedClient;
      console.log("✅ MongoDB connected.");
      return connectedClient;
    })
    .catch(async (error: unknown) => {
      // Do not cache a client whose topology never connected successfully.
      client = null;
      db = null;
      clientPromise = null;
      await candidate.close().catch(() => undefined);
      throw error;
    });

  return clientPromise;
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
 */
export async function closeConnection(): Promise<void> {
  const pending = clientPromise;
  const activeClient = client ?? (pending ? await pending.catch(() => null) : null);

  client = null;
  db = null;
  clientPromise = null;

  if (activeClient) {
    await activeClient.close();
    console.log("🔌 MongoDB connection closed.");
  }
}
