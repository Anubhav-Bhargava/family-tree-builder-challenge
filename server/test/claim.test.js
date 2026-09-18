// Idempotency and the lease: which request is allowed to run a message.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { db } from "../src/db/connection.js";
import * as repo from "../src/db/repository.js";
import { claimMessage } from "../src/routes/chat.js";

const SESSION = "claim-session";
const MESSAGE = "claim-message-1";
const TEXT = "my mother is Kavita";

beforeEach(() => db.exec("DELETE FROM sessions; DELETE FROM people;"));

const claim = (over = {}) => claimMessage({ sessionId: SESSION, messageId: MESSAGE, text: TEXT, ...over });

test("a new message is claimed, and records the lease and first attempt", () => {
  const result = claim();

  assert.equal(result.outcome, "claimed");
  assert.equal(result.message.attempts, 1);
  assert.equal(result.message.status, "processing");
  assert.ok(result.message.lease_expires_at > Date.now(), "the lease is in the future");
});

test("a duplicate request while the first is still running is refused", () => {
  claim();
  assert.equal(claim().outcome, "in_progress"); // the route turns this into 409 + Retry-After
});

test("reusing a message id for different text is refused", () => {
  claim();
  assert.equal(claim({ text: "something else entirely" }).outcome, "mismatch"); // 422
});

test("a completed message replays its reply instead of running again", () => {
  claim();
  repo.completeMessage(MESSAGE, "Got it, Kavita is your mother.");

  const result = claim();
  assert.equal(result.outcome, "completed");
  assert.equal(result.message.reply_text, "Got it, Kavita is your mother.");
});

test("a failed message can be retried, and gives up after maxAttempts", () => {
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    assert.equal(claim().outcome, "claimed", `attempt ${attempt}`);
    repo.failMessage(MESSAGE, "LLM_UNAVAILABLE");
  }

  assert.equal(claim().outcome, "exhausted");
  assert.equal(repo.getMessage(MESSAGE).attempts, config.maxAttempts);
});

test("a message whose lease expired can be taken over, but not while the lease is live", () => {
  claim();
  assert.equal(claim().outcome, "in_progress");

  // Simulate the process dying: the row stays "processing" and the lease runs out.
  db.prepare("UPDATE messages SET lease_expires_at = ? WHERE id = ?").run(Date.now() - 1, MESSAGE);

  const result = claim();
  assert.equal(result.outcome, "claimed");
  assert.equal(result.message.attempts, 2);
});

test("the boot sweep frees interrupted messages immediately", () => {
  claim();
  assert.equal(repo.failInterruptedMessages(), 1);

  assert.equal(repo.getMessage(MESSAGE).status, "failed");
  assert.equal(repo.getMessage(MESSAGE).error_code, "INTERRUPTED");
  assert.equal(claim().outcome, "claimed", "a retry runs at once, without waiting out the lease");
});
