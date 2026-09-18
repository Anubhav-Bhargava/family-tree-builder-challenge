// All SQL lives here: statements are prepared once, and each export is a thin
// wrapper over one of them. No business rules.
import { db } from "./connection.js";

const now = () => Date.now();

const PERSON = "id, name, name_key, sex, birth_year, notes";

const sql = {
  // people
  getPerson: db.prepare(`SELECT ${PERSON} FROM people WHERE id = ?`),
  allPeople: db.prepare(`SELECT ${PERSON} FROM people ORDER BY created_time, id`),
  insertPerson: db.prepare(
    `INSERT INTO people (${PERSON}, created_time, last_updated_time)
     VALUES (@id, @name, @name_key, @sex, @birth_year, @notes, @t, @t)`,
  ),
  deletePerson: db.prepare("DELETE FROM people WHERE id = ?"), // edges cascade

  // relationships
  parentsOf: db.prepare("SELECT p.id, p.name FROM parent_edges e JOIN people p ON p.id = e.parent_id WHERE e.child_id = ?"),
  childrenOf: db.prepare("SELECT p.id, p.name FROM parent_edges e JOIN people p ON p.id = e.child_id WHERE e.parent_id = ?"),
  spouseOf: db.prepare(
    `SELECT p.id, p.name FROM spouse_edges e
     JOIN people p ON p.id = CASE WHEN e.person_a_id = @id THEN e.person_b_id ELSE e.person_a_id END
     WHERE @id IN (e.person_a_id, e.person_b_id)`,
  ),
  siblingsOf: db.prepare(
    `SELECT DISTINCT p.id, p.name FROM parent_edges mine
     JOIN parent_edges theirs ON theirs.parent_id = mine.parent_id AND theirs.child_id <> mine.child_id
     JOIN people p ON p.id = theirs.child_id
     WHERE mine.child_id = ?`,
  ),
  // Walks up from @start. Returns the path if @ancestor sits above it.
  ancestorPath: db.prepare(
    `WITH RECURSIVE up (id, path) AS (
       SELECT @start, @start
       UNION
       SELECT e.parent_id, up.path || ',' || e.parent_id FROM parent_edges e JOIN up ON e.child_id = up.id
     )
     SELECT path FROM up WHERE id = @ancestor AND id <> @start`,
  ),
  hasParentEdge: db.prepare("SELECT 1 FROM parent_edges WHERE parent_id = ? AND child_id = ?"),
  insertParentEdge: db.prepare("INSERT INTO parent_edges VALUES (@childId, @parentId, @t, @t)"),
  deleteParentEdge: db.prepare("DELETE FROM parent_edges WHERE parent_id = ? AND child_id = ?"),
  insertSpouseEdge: db.prepare("INSERT INTO spouse_edges VALUES (@first, @second, @t, @t)"),
  deleteSpouseEdge: db.prepare("DELETE FROM spouse_edges WHERE person_a_id = ? AND person_b_id = ?"),
  allParentEdges: db.prepare("SELECT parent_id AS parentId, child_id AS childId FROM parent_edges"),
  allSpouseEdges: db.prepare("SELECT person_a_id AS personAId, person_b_id AS personBId FROM spouse_edges"),

  // conversation
  upsertSession: db.prepare(
    "INSERT INTO sessions (id, created_time, last_updated_time) VALUES (@id, @t, @t) ON CONFLICT (id) DO UPDATE SET last_updated_time = @t",
  ),
  // Who "I"/"my" means in one chat. Per session, so two people can use the same tree.
  getNarrator: db.prepare(
    `SELECT p.${PERSON.replaceAll(", ", ", p.")} FROM sessions s JOIN people p ON p.id = s.narrator_person_id WHERE s.id = ?`,
  ),
  setNarrator: db.prepare("UPDATE sessions SET narrator_person_id = @personId, last_updated_time = @t WHERE id = @sessionId"),
  insertMessage: db.prepare(
    `INSERT INTO messages (id, session_id, user_text, status, attempts, lease_expires_at, created_time, last_updated_time)
     VALUES (@id, @sessionId, @text, 'processing', 1, @expires, @t, @t)`,
  ),
  // Retry of a message that failed or whose lease expired.
  retakeMessage: db.prepare(
    `UPDATE messages SET status = 'processing', attempts = attempts + 1, lease_expires_at = @expires,
       error_code = NULL, last_updated_time = @t
     WHERE id = @id`,
  ),
  getMessage: db.prepare("SELECT * FROM messages WHERE id = ?"),
  sessionHistory: db.prepare(
    `SELECT id, user_text, reply_text FROM messages
     WHERE session_id = ? AND status = 'completed' ORDER BY created_time, rowid`,
  ),
  addRound: db.prepare(
    `UPDATE messages SET rounds = rounds + 1, input_tokens = input_tokens + @inputTokens,
       output_tokens = output_tokens + @outputTokens, model = @model, last_updated_time = @t
     WHERE id = @id`,
  ),
  completeMessage: db.prepare(
    `UPDATE messages SET status = 'completed', reply_text = @reply, lease_expires_at = NULL,
       completed_time = @t, last_updated_time = @t
     WHERE id = @id`,
  ),
  failMessage: db.prepare(
    "UPDATE messages SET status = 'failed', error_code = @errorCode, lease_expires_at = NULL, last_updated_time = @t WHERE id = @id",
  ),
  // Boot: with one process, anything still "processing" belongs to a process that died.
  failInterrupted: db.prepare(
    `UPDATE messages SET status = 'failed', error_code = 'INTERRUPTED', lease_expires_at = NULL, last_updated_time = @t
     WHERE status = 'processing'`,
  ),
  // ── metrics (read-only) ──
  messagesByStatus: db.prepare("SELECT status AS k, COUNT(*) AS v FROM messages GROUP BY status"),
  messagesRetried: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE attempts > 1"),
  messageErrors: db.prepare(
    "SELECT error_code AS k, COUNT(*) AS v FROM messages WHERE error_code IS NOT NULL GROUP BY error_code",
  ),
  messageDurations: db.prepare(
    `SELECT completed_time - created_time AS ms FROM messages
     WHERE status = 'completed' AND completed_time IS NOT NULL ORDER BY ms`,
  ),
  messageTotals: db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
       COALESCE(AVG(rounds), 0) AS avgRounds
     FROM messages WHERE status = 'completed'`,
  ),
  toolsByOutcome: db.prepare(
    `SELECT tool_name AS tool, outcome, COUNT(*) AS count FROM tool_call_logs
     GROUP BY tool_name, outcome ORDER BY tool_name, outcome`,
  ),
  toolCodes: db.prepare(
    `SELECT outcome, error_code AS k, COUNT(*) AS v FROM tool_call_logs
     WHERE error_code IS NOT NULL GROUP BY outcome, error_code`,
  ),
  // Recent outcomes per tool, newest first, for the alert rule.
  recentToolOutcomes: db.prepare(
    `SELECT tool_name, outcome FROM (
       SELECT tool_name, outcome, ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY id DESC) AS rn FROM tool_call_logs
     ) WHERE rn <= ?`,
  ),
  treeCounts: db.prepare(
    `SELECT (SELECT COUNT(*) FROM people) AS people,
            (SELECT COUNT(*) FROM parent_edges) AS parentEdges,
            (SELECT COUNT(*) FROM spouse_edges) AS spouseEdges`,
  ),

  insertToolCallLog: db.prepare(
    `INSERT INTO tool_call_logs (message_id, attempt, tool_use_id, tool_name, model, input, result, outcome, error_code,
       latency_ms, created_time, last_updated_time)
     VALUES (@messageId, @attempt, @toolUseId, @toolName, @model, @input, @result, @outcome, @errorCode, @latencyMs, @t, @t)`,
  ),
};

// ─────────────── people ───────────────

export const getPerson = (id) => sql.getPerson.get(id) ?? null;
export const allPeople = () => sql.allPeople.all();
export const insertPerson = (person) => sql.insertPerson.run({ ...person, t: now() });
export const deletePerson = (id) => sql.deletePerson.run(id);

export function updatePerson(id, fields) {
  const assignments = Object.keys(fields).map((key) => `${key} = @${key}`);
  db.prepare(`UPDATE people SET ${assignments.join(", ")}, last_updated_time = @t WHERE id = @id`).run({ ...fields, id, t: now() });
}

// ─────────────── relationships ───────────────

export const parentsOf = (id) => sql.parentsOf.all(id);
export const childrenOf = (id) => sql.childrenOf.all(id);
export const spouseOf = (id) => sql.spouseOf.get({ id }) ?? null;
export const siblingsOf = (id) => sql.siblingsOf.all(id);

/** Ids from `start` up to `ancestor` if ancestor is above start, else null. */
export const ancestorPath = (start, ancestor) => sql.ancestorPath.get({ start, ancestor })?.path.split(",") ?? null;

export const hasParentEdge = (parentId, childId) => sql.hasParentEdge.get(parentId, childId) !== undefined;
export const insertParentEdge = (parentId, childId) => sql.insertParentEdge.run({ parentId, childId, t: now() });
export const deleteParentEdge = (parentId, childId) => sql.deleteParentEdge.run(parentId, childId).changes > 0;

// Spouse pairs are stored smallest id first, so (A, B) and (B, A) are the same row.
const ordered = (a, b) => (a < b ? { first: a, second: b } : { first: b, second: a });
export const insertSpouseEdge = (a, b) => sql.insertSpouseEdge.run({ ...ordered(a, b), t: now() });
export const deleteSpouseEdge = (a, b) => {
  const { first, second } = ordered(a, b);
  return sql.deleteSpouseEdge.run(first, second).changes > 0;
};

export const allParentEdges = () => sql.allParentEdges.all();
export const allSpouseEdges = () => sql.allSpouseEdges.all();

// ─────────────── conversation ───────────────

export const upsertSession = (sessionId) => sql.upsertSession.run({ id: sessionId, t: now() });
export const insertMessage = (m) => sql.insertMessage.run({ ...m, t: now() });
export const retakeMessage = (id, expires) => sql.retakeMessage.run({ id, expires, t: now() });

export const getNarrator = (sessionId) => sql.getNarrator.get(sessionId) ?? null;
export const setNarrator = (sessionId, personId) => sql.setNarrator.run({ sessionId, personId, t: now() });

export const getMessage = (id) => sql.getMessage.get(id) ?? null;
export const sessionHistory = (sessionId) => sql.sessionHistory.all(sessionId);
export const addRound = (id, usage) => sql.addRound.run({ ...usage, id, t: now() });
export const completeMessage = (id, reply) => sql.completeMessage.run({ id, reply, t: now() });
export const failMessage = (id, errorCode) => sql.failMessage.run({ id, errorCode, t: now() });
export const failInterruptedMessages = () => sql.failInterrupted.run({ t: now() }).changes;
export const insertToolCallLog = (log) => sql.insertToolCallLog.run({ ...log, t: now() });

// ─────────────── metrics ───────────────

export const messagesByStatus = () => sql.messagesByStatus.all();
export const messagesRetried = () => sql.messagesRetried.get().n;
export const messageErrors = () => sql.messageErrors.all();
export const messageDurations = () => sql.messageDurations.all().map((row) => row.ms);
export const messageTotals = () => sql.messageTotals.get();
export const toolsByOutcome = () => sql.toolsByOutcome.all();
export const toolCodes = () => sql.toolCodes.all();
export const recentToolOutcomes = (window) => sql.recentToolOutcomes.all(window);
export const treeCounts = () => sql.treeCounts.get();
