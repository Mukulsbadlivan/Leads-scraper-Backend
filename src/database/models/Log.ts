import { ObjectId } from "mongodb";

/**
 * Structured log event persisted to MongoDB.
 * Maps to the `scrape_logs` collection.
 */
export type LogEventType =
  | "QueueCreated"
  | "WorkerStarted"
  | "WorkerStopped"
  | "JobStarted"
  | "JobProgress"
  | "JobCompleted"
  | "JobFailed"
  | "RetryAttempt"
  | "DeadLetterQueue"
  | "ApiRequest"
  | "SystemError";

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogDocument {
  _id?: ObjectId;
  event: LogEventType;
  level: LogLevel;
  message: string;
  /** Associated scrape run ID (if applicable) */
  scrapeRunId?: string;
  /** BullMQ job ID */
  queueJobId?: string;
  /** Retry attempt number */
  attemptNumber?: number;
  /** Structured payload (progress, stats, etc.) */
  payload?: Record<string, unknown>;
  /** Error message */
  errorMessage?: string;
  /** Full stack trace */
  stackTrace?: string;
  createdAt: Date;
}
