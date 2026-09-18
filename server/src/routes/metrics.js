// GET /api/metrics → what the last runs cost, what the tools did, and any alert
// firing right now. Everything is computed from the messages and tool_call_logs
// tables, so the numbers survive a restart (in-memory counters would not).
//
// In production these become Prometheus counters and Alertmanager rules with the
// same thresholds; the README lists the full set. Here one rule is evaluated for
// real: a tool whose recent calls are erroring.
import { Router } from "express";
import { config } from "../config.js";
import * as repo from "../db/repository.js";

export const metricsRouter = Router();

metricsRouter.get("/", (_req, res) => {
  const totals = repo.messageTotals();
  const durations = repo.messageDurations();
  const codes = repo.toolCodes();

  res.json({
    messages: {
      byStatus: countsByKey(repo.messagesByStatus()),
      retried: repo.messagesRetried(),
      // Degraded replies: the model finished, but not the way we wanted.
      endedEarly: countsByKey(repo.messageErrors()),
      avgRounds: round(totals.avgRounds, 2),
      durationMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), count: durations.length },
    },
    llm: {
      model: config.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      estimatedUsd: round(
        (totals.inputTokens * config.pricePerMTok.input + totals.outputTokens * config.pricePerMTok.output) / 1e6,
        4,
      ),
    },
    tools: {
      // "rejected" is a rule saying no, which is the system working.
      // "error" is a bug, bad input from the model, or infrastructure.
      byOutcome: repo.toolsByOutcome(),
      rejectionsByCode: countsByKey(codes.filter((row) => row.outcome === "rejected")),
      errorsByCode: countsByKey(codes.filter((row) => row.outcome === "error")),
    },
    tree: repo.treeCounts(),
    alerts: currentAlerts(),
  });
});

/** Alert rules evaluated on request. Only errors count; rejections never alert. */
function currentAlerts() {
  const byTool = {};
  for (const { tool_name: tool, outcome } of repo.recentToolOutcomes(config.toolErrorWindow)) {
    (byTool[tool] ??= []).push(outcome);
  }

  return Object.entries(byTool)
    .map(([tool, outcomes]) => ({ tool, errors: outcomes.filter((o) => o === "error").length, seen: outcomes.length }))
    .filter(({ errors }) => errors >= config.toolErrorThreshold)
    .map(({ tool, errors, seen }) => ({
      severity: "ticket",
      rule: "tool_errors",
      detail: `${tool}: ${errors} of its last ${seen} calls failed`,
    }));
}

const countsByKey = (rows) => Object.fromEntries(rows.map(({ k, v }) => [k, v]));
const round = (value, places) => Number(value.toFixed(places));
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
