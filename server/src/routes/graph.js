import { Router } from "express";
import { readGraph } from "../tree/familyTree.js";

export const graphRouter = Router();

// GET /api/graph → { people, parentEdges, spouseEdges }, read from SQLite.
graphRouter.get("/", (_req, res) => {
  res.json(readGraph());
});
