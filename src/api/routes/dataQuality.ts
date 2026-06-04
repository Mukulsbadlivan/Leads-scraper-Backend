/**
 * dataQuality.ts — Express route handler for data quality metrics.
 */

import { Router, Request, Response } from "express";
import { countDuplicatesRemoved } from "../../database/repositories/DuplicateAuditRepository.js";
import { logger } from "../../logging/logger.js";

export const dataQualityRouter = Router();

/**
 * GET /api/data-quality
 * Returns counts of merged companies, leads, and total duplicates removed.
 */
dataQualityRouter.get("/", async (req: Request, res: Response) => {
  try {
    const [companiesMerged, leadsMerged, duplicatesRemoved] = await Promise.all([
      countDuplicatesRemoved("companies"),
      countDuplicatesRemoved("leads"),
      countDuplicatesRemoved()
    ]);

    await logger.apiRequest("GET", "/api/data-quality", 200).catch(() => {});

    return res.json({
      companiesMerged,
      leadsMerged,
      duplicatesRemoved
    });
  } catch (err: any) {
    console.error("[GET /api/data-quality] Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch data quality metrics",
      message: err.message
    });
  }
});
