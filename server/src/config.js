import { fileURLToPath } from "node:url";

export const config = {
  port: Number(process.env.PORT) || 3001,
  dbPath: process.env.DATABASE_PATH || fileURLToPath(new URL("../family-tree.db", import.meta.url)),

  // Hardcoded for now; recorded on every message and tool call log.
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  maxTokens: 16_000,
  maxRounds: 8, // model calls per message
  messageDeadlineMs: 120_000, // whole message, SDK retries included
  requestTimeoutMs: 60_000, // per model call; the SDK retries 408/409/429/5xx twice
  historyExchanges: 20,

  // Estimate only, for the spend figure in /api/metrics. USD per million tokens.
  pricePerMTok: { input: 2, output: 10 },
  // A tool is unhealthy when this many of its last few calls were errors
  // (rejections are rules doing their job and never count).
  toolErrorWindow: 5,
  toolErrorThreshold: 3,

  leaseMs: 180_000, // longer than the deadline, so a live request never loses its lease
  maxAttempts: 3,
};
