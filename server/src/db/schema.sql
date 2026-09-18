-- Family Tree Builder schema. Applied by db/connection.js on an empty database.
-- No triggers: the rules that need a query (no cycles, at most 2 parents, one spouse) live in
-- tree/familyTree.js, inside the same BEGIN IMMEDIATE transaction as the write.
-- The database keeps the declarative constraints: keys, foreign keys, CHECKs.
--
-- Base columns on every table: created_time and last_updated_time (epoch ms). They have no
-- defaults on purpose, so a raw INSERT that bypasses the repository fails.
--
-- Connection pragmas (set on every open, not stored here):
--   PRAGMA journal_mode = WAL;  PRAGMA foreign_keys = ON;  PRAGMA busy_timeout = 5000;

-- ───────────── graph ─────────────

CREATE TABLE people (
  id                TEXT PRIMARY KEY,                     -- server-generated, 'p_' + 10 random base32 chars
  name              TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  name_key          TEXT NOT NULL,                        -- normalized: NFKD, accents stripped, lowercase, single spaces
  sex               TEXT CHECK (sex IN ('female', 'male', 'other')),   -- NULL = not stated
  birth_year        INTEGER CHECK (birth_year BETWEEN 1000 AND 2200),
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  created_time      INTEGER NOT NULL,
  last_updated_time INTEGER NOT NULL
) STRICT;
CREATE INDEX people_name_key ON people (name_key);

CREATE TABLE parent_edges (
  child_id          TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  parent_id         TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  created_time      INTEGER NOT NULL,
  last_updated_time INTEGER NOT NULL,
  PRIMARY KEY (child_id, parent_id),                      -- serves "parents of X"; same fact can't be stored twice
  CHECK (parent_id <> child_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX parent_edges_parent ON parent_edges (parent_id);          -- serves "children of X"

CREATE TABLE spouse_edges (
  person_a_id       TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  person_b_id       TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  created_time      INTEGER NOT NULL,
  last_updated_time INTEGER NOT NULL,
  PRIMARY KEY (person_a_id, person_b_id),
  CHECK (person_a_id < person_b_id)                       -- canonical order: undirected, no (A,B)+(B,A)
) STRICT, WITHOUT ROWID;
CREATE INDEX spouse_edges_b ON spouse_edges (person_b_id);

-- ───────────── conversation + logs ─────────────
-- The server owns the conversation. The client sends { sessionId, messageId, text }.
-- A session is a chat, not a tree: many sessions edit the one tree.

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,                   -- client-generated UUID, one per chat
  narrator_person_id  TEXT REFERENCES people (id) ON DELETE SET NULL,  -- who "I"/"my" means in this chat
  created_time        INTEGER NOT NULL,
  last_updated_time   INTEGER NOT NULL
) STRICT;

CREATE TABLE messages (                                   -- one row per exchange: the user's text and the reply to it
  id                TEXT PRIMARY KEY,                     -- client-generated UUID per user message = idempotency key
  session_id        TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_text         TEXT NOT NULL CHECK (length(user_text) BETWEEN 1 AND 8000),
  reply_text        TEXT,                                 -- NULL until completed
  status            TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  lease_expires_at  INTEGER,                              -- epoch ms; "processing" only holds until this time
  error_code        TEXT,
  model             TEXT,                                 -- model that produced the reply
  rounds            INTEGER NOT NULL DEFAULT 0,           -- model calls used for this exchange
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  completed_time    INTEGER,
  created_time      INTEGER NOT NULL,
  last_updated_time INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_session ON messages (session_id, created_time);

CREATE TABLE tool_call_logs (                             -- every tool call: audit trail + source for error-rate alerts
  id                INTEGER PRIMARY KEY,
  message_id        TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  attempt           INTEGER NOT NULL,                     -- which attempt at the message made this call
  tool_use_id       TEXT NOT NULL,                        -- the model's id for the call
  tool_name         TEXT NOT NULL,
  model             TEXT NOT NULL,                        -- model that issued the call
  input             TEXT NOT NULL,                        -- JSON
  result            TEXT NOT NULL,                        -- JSON returned to the model; includes old values for updates and deletes
  outcome           TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'error')),
  error_code        TEXT,                                 -- rejected = a rule said no (expected); error = a bug or infra fault
  latency_ms        INTEGER,
  created_time      INTEGER NOT NULL,
  last_updated_time INTEGER NOT NULL
) STRICT;
CREATE INDEX tool_call_logs_message ON tool_call_logs (message_id);
CREATE INDEX tool_call_logs_tool ON tool_call_logs (tool_name, id);
