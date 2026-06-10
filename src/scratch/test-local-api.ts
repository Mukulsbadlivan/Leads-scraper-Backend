import dotenv from "dotenv";
dotenv.config();
import app from "../api/server.ts";
import axios from "axios";

async function run() {
  const PORT = 4567;
  // Override PORT just in case
  process.env.API_PORT = String(PORT);
  
  const server = app.listen(PORT, "127.0.0.1", async () => {
    console.log(`Local test server listening on port ${PORT}`);
    
    const endpoints = [
      "/api/startup/dashboard",
      "/api/startup/companies",
      "/api/startup/executives"
    ];
    
    for (const ep of endpoints) {
      try {
        const res = await axios.get(`http://127.0.0.1:${PORT}${ep}`);
        console.log(`✅ GET ${ep} -> Status: ${res.status}`);
        console.log(`   Response:`, JSON.stringify(res.data, null, 2).substring(0, 1000));
      } catch (err: any) {
        console.error(`❌ GET ${ep} failed:`, err.response?.data ?? err.message);
      }
    }
    
    server.close(() => {
      console.log("Server closed.");
      process.exit(0);
    });
  });
}

run().catch(console.error);
