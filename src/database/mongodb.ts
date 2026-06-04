/**
 * mongodb.ts — central re-export for the database layer.
 *
 * Usage in any module:
 *   import { getDb, closeConnection } from "../database/mongodb.js";
 */
export { getClient, getDb, closeConnection } from "./connection.js";
