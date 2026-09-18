import "./env.js"; // must be first: loads server/.env before config.js reads it
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import * as repo from "./db/repository.js";
import { chatRouter } from "./routes/chat.js";
import { graphRouter } from "./routes/graph.js";
import { metricsRouter } from "./routes/metrics.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/chat", chatRouter);
app.use("/api/graph", graphRouter);
app.use("/api/metrics", metricsRouter);
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// One process: any message still "processing" belongs to a process that died.
// Marking them failed lets a retry run at once instead of waiting out the lease.
const interrupted = repo.failInterruptedMessages();
if (interrupted) console.warn(`[boot] marked ${interrupted} interrupted message(s) as failed`);

app.listen(config.port, () => {
  console.log(`family-tree-builder server listening on http://localhost:${config.port} (model ${config.model})`);
});
