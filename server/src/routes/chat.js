// POST /api/chat                 { sessionId, messageId, text } → { reply, replayed }
// GET  /api/chat/sessions/:id    → { messages: [{ id, userText, replyText }] }
//
// The server owns the conversation. The client makes one messageId per message
// and reuses it on retry, so a message is never run twice:
//   new id                   → take the lease, run the agent, store the reply
//   same id, completed       → return the stored reply
//   same id, still running   → 409, client retries shortly
//   same id, different text  → 422
//   same id, failed/expired  → run it again (at most maxAttempts)
import { Router } from "express";
import { config } from "../config.js";
import { transaction } from "../db/connection.js";
import * as repo from "../db/repository.js";
import { getChatReply } from "../llm/client.js";

const ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Decides whether this request may run the message, and takes the lease if so.
 * One transaction, so the check and the write can't interleave with another request.
 *
 *   claimed      run the agent
 *   completed    an earlier request already answered: replay its reply
 *   in_progress  someone else holds a live lease
 *   mismatch     this messageId was used for different text
 *   exhausted    too many attempts
 */
export function claimMessage({ sessionId, messageId, text }) {
  return transaction(() => {
    repo.upsertSession(sessionId);

    const now = Date.now();
    const expires = now + config.leaseMs;
    const existing = repo.getMessage(messageId);

    if (!existing) {
      repo.insertMessage({ id: messageId, sessionId, text, expires });
      return { outcome: "claimed", message: repo.getMessage(messageId) };
    }
    if (existing.session_id !== sessionId || existing.user_text !== text) return { outcome: "mismatch" };
    if (existing.status === "completed") return { outcome: "completed", message: existing };
    if (existing.status === "processing" && existing.lease_expires_at > now) return { outcome: "in_progress" };
    if (existing.attempts >= config.maxAttempts) return { outcome: "exhausted" };

    repo.retakeMessage(messageId, expires);
    return { outcome: "claimed", message: repo.getMessage(messageId) };
  });
}

export const chatRouter = Router();

chatRouter.post("/", async (req, res) => {
  const { sessionId, messageId, text } = req.body ?? {};
  if (!ID.test(sessionId ?? "") || !ID.test(messageId ?? "")) {
    return res.status(400).json({ error: "sessionId and messageId must be 8-64 letters, digits or dashes" });
  }
  if (typeof text !== "string" || !text.trim() || text.length > 8000) {
    return res.status(400).json({ error: "text must be 1-8000 characters" });
  }

  const claim = claimMessage({ sessionId, messageId, text: text.trim() });

  if (claim.outcome === "completed") return res.json({ reply: claim.message.reply_text, replayed: true });
  if (claim.outcome === "mismatch") {
    return res.status(422).json({ error: "This messageId was already used for a different message." });
  }
  if (claim.outcome === "in_progress") {
    return res.status(409).set("Retry-After", "2").json({ error: "Still processing this message." });
  }
  if (claim.outcome === "exhausted") {
    return res.status(500).json({ error: "This message failed too many times. Please send it again." });
  }

  try {
    const reply = await getChatReply(claim.message);
    repo.completeMessage(messageId, reply);
    res.json({ reply, replayed: false });
  } catch (err) {
    const errorCode = err.status ? `LLM_HTTP_${err.status}` : err.name === "TimeoutError" ? "TIMEOUT" : "LLM_UNAVAILABLE";
    repo.failMessage(messageId, errorCode);
    console.error(`[chat] message ${messageId} failed (${errorCode}):`, err.message);
    res.status(502).json({ error: "The assistant is unavailable right now. Please try again." });
  }
});

chatRouter.get("/sessions/:sessionId", (req, res) => {
  const messages = repo
    .sessionHistory(req.params.sessionId)
    .map((m) => ({ id: m.id, userText: m.user_text, replyText: m.reply_text }));
  res.json({ messages });
});
