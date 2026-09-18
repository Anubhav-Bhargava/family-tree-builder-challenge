# Family Tree Builder — Take-Home Starter

This repo is a starting point, not a finished app. It gives you a working chat
UI, a working graph visualization, and a bare LLM connection with no tools
attached. Your job is everything that turns a conversation into a correct,
persisted family tree.

## What's already here

- **`client/`** — React (Vite) app with two panels:
  - `ChatPanel` — a text chat interface. Sends the full conversation to
    `POST /api/chat` on every turn and renders the reply.
  - `GraphView` — renders whatever `GET /api/graph` returns using
    [React Flow](https://reactflow.dev). It expects:
    ```
    {
      people: [{ id, name, ... }],
      parentEdges: [{ parentId, childId }],
      spouseEdges: [{ personAId, personBId }]
    }
    ```
    It lays nodes out by generation and re-fetches on an interval, so once
    your backend actually persists data, it'll show up here without any
    frontend changes.
- **`server/`** — Express app with:
  - `POST /api/chat` — stateless proxy to the model (`server/src/llm/client.js`,
    `server/src/routes/chat.js`). No tools are wired up. It can already hold a
    plain-text conversation and ask clarifying questions, but it has no way to
    read or write structured family-tree data.
  - `GET /api/graph` — currently always returns an empty graph
    (`server/src/routes/graph.js`). There is no database yet.

## What you need to build

1. **Tool definitions** the model uses to read/write the family tree (add
   person, add parent/child edge, add spouse edge, look up a person, apply a
   correction, etc. — you choose the shape).
2. **The agentic loop** in `POST /api/chat`: send messages + tools to the
   model, handle `tool_use` blocks, execute them against your persistence
   layer, feed `tool_result` blocks back, and repeat until the model returns
   plain text.
3. **A persistence layer** (SQLite is fine) that survives a process restart.
   `GET /api/graph` should read from it instead of returning the empty stub.
4. **Ambiguity and correction handling**:
   - If a reference is ambiguous (e.g. "my brother John" when two Johns
     exist), the agent should ask a clarifying question rather than guess.
   - If the user corrects an earlier statement (a misspelled name, a
     misstated relationship), state should update in place — not gain a
     duplicate or contradictory fact.
5. **DAG validation** — a parent→child edge that would create a cycle must be
   rejected, not silently accepted.

### Data model requirements

- **Person**: `id`, `name`, plus any other attributes you think are useful —
  justify your choices in your README.
- **Parent → Child**: single-direction, at most 2 parent edges per child.
- **Spouse**: explicit, undirected, distinct from parent→child. A spouse
  relationship alone never creates a parent edge.
- The graph must stay a valid DAG with respect to parent→child edges.

### Out of scope

Remarriage, half-siblings, more than 2 recorded parents, and unknown/missing
parents are out of scope. If a description happens to touch one of these, a
non-crashing response (clarifying question or a stated limitation) is fine —
you don't need to model it correctly.

## Getting started

```bash
npm install
cp server/.env.example server/.env   # then fill in ANTHROPIC_API_KEY
npm run dev
```

This starts the server (`:3001`) and client (`:5173`, proxying `/api` to the
server) together. Open the client URL and start chatting.

## Deliverables

- Your implementation (tool schema, agent loop, persistence, validation).
- A README section (append to this file or add a new one) covering:
  - Your tool schema and why you designed it that way
  - How you resolve ambiguous references and in-place corrections
  - Known limitations
- Be ready to walk through your design decisions and trade-offs in a follow-up
  discussion — not just demo the working app.

---

# Implementation notes

Everything above is the original brief. Everything below describes what I built.

## Running it

```bash
npm install
cp server/.env.example server/.env     # add ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL is already set for OpenRouter
npm run dev                            # server :3001, client :5173
```

```bash
npm test -w server                     # 15 unit tests, in-memory database, no model, no network
npm run eval -w server                 # 4 scenarios against the real model (costs tokens)
EVAL_RUNS=5 npm run eval -w server     # same, reported as a pass rate
```

The database is `server/family-tree.db`, created from `server/src/db/schema.sql` on first run.

## My thought process while building it

This was the flow of things in decreasing order of priority and time spent:

1. **Entity / Schema Design.** 
2. **Tools calls with Transactional Rollbacks**
3. **DAG Creation/Validation**
4. **Idempotency/Lease Creation**
5. **Test-Cases / Evals / Metrics**

## Data model

Three tables hold the graph — `people`, `parent_edges`, `spouse_edges` — and three hold the conversation: `sessions`, `messages`, `tool_call_logs`.

| Table | Why |
|---|---|
| `people` | One row per person. Holds only what identifies a person. |
| `parent_edges` | Directed `parent → child`, composite primary key so the same fact cannot be stored twice. |
| `spouse_edges` | Undirected, stored in a canonical order (`CHECK (person_a_id < person_b_id)`), so `(A,B)` and `(B,A)` are the same row and the pair is unique. |
| `sessions` | One chat. The server owns the conversation rather than trusting whatever the client resends, and each chat records its own narrator (`narrator_person_id`) — who "I" and "my" refer to — so two people can describe the same tree from their own point of view. |
| `messages` | One row per exchange: the user's text and the reply to it. The client's `messageId` is the primary key, which makes it the idempotency key; the row also carries the lease (`status`, `lease_expires_at`, `attempts`) and the token counters. |
| `tool_call_logs` | One row per tool call, with its input, result and outcome (`ok` / `rejected` / `error`). This is the audit trail — powering our metrics. |


Parent and spouse links are separate tables, so a marriage can never imply a parent link. Both edge tables use a composite primary key, so restating a fact is a no-op rather than a duplicate row. 

Beyond `id` and `name`, a person has:

| Attribute | Why |
|---|---|
| `name_key` | The name normalised. Lookup and duplicate detection key. |
| `birth_year` | Used to differentiate people with the same name. |
| `sex` | Only so the model can say "brother" or "mother", and as another way to distinguish people. |
| `notes` | Remarks / Alias names. |

Every table also carries `created_time` and `last_updated_time` (epoch ms). Wanted to have it as a inherited base entity, but decided against that due to time constraints.

**Who "I" refers to** is `sessions.narrator_person_id`, not a flag on the person. It is per conversation, so two people can describe the same tree from their own point of view. Makes our design easy to scale to multi-chat windows

## Tool schema, and why

Two tools.

**`find_people({ name?, related_to? })`** returns *every* candidate, best match first, each with its parents, children, spouse and siblings. It never picks one. `related_to: { person_id, relation }` narrows by `parent`, `child`, `spouse` or `sibling`, which is what turns "my brother John" into a single match when two Johns exist.

**`apply_changes({ operations })`** is the only way to write. Operations: `create_person`, `update_person`, `delete_person`, `add_parent`, `remove_parent`, `add_spouse`, `remove_spouse`.

Three decisions shape it:

**Ids are the server's, never the model's.** No write accepts a name, so the model cannot write by guessing — it has to have resolved the person first. New people get a temporary `ref` ("n1") that is valid only inside one call, and the result returns the `ref → id` map:

```json
{"operations":[
  {"op":"create_person","ref":"n1","name":"Juhi"},
  {"op":"add_spouse","a":{"id":"p_w7pf8duvv8"},"b":{"ref":"n1"}}
]}
```

**One statement is one call, applied atomically.** "My parents are Sam and Jordan and my brother is John" is three people and four links. With one tool call per fact, a rule that fires on the fifth write leaves a half-recorded family the user never described. Here the whole batch commits or none of it does, and the same property makes corrections safe: removing a wrong link and adding the right one happen together. Operations are sorted before execution — removals, then creates and updates, then new links — so the model's ordering never matters.

**Errors are structured data, not prose.** Every rejection carries a code and details the model can turn into a question: `CYCLE` (with the path, "Cat > Bob > Ann"), `MAX_PARENTS` (with the two existing parents), `SPOUSE_LIMIT`, `POSSIBLE_DUPLICATE` (with the candidates), `NOT_FOUND`, `UNKNOWN_REF`, `INVALID_SPOUSE`, `NARRATOR_ALREADY_SET`, `INVALID_INPUT`.

**The model reads the tree from the prompt**, not from a tool. Every model call carries a fresh one-line-per-person snapshot, so lookups cost no round trip and the ids it needs are always in front of it. The static rules sit in a separate, cacheable system block; the snapshot changes after every write and sits after it.

## Ambiguous references

Resolution is layered, and the last layer is enforced by the server rather than the prompt.

1. **An anchor.** "My …" resolves against the session's narrator. If there isn't one, the model asks who it is speaking with before recording relatives.
2. **Relation-scoped lookup.** "My brother John" becomes `find_people({name: "John", related_to: {person_id: <narrator>, relation: "sibling"}})`, which often reduces two Johns to one without asking.
3. **A rule the model follows.** One match: use it. None: create. Two or more: write nothing about that person and ask a question that uses what distinguishes them — birth year, parents, spouse. The candidates carry exactly those fields so the question can be specific.
4. **A guard the server enforces.** `create_person` is rejected with `POSSIBLE_DUPLICATE` when the name matches someone already recorded — exactly, as a first name ("John" vs "John Smith"), or as a one-letter typo on a name of four or more letters ("Jon" vs "John", but not "Sam" vs "Pam"). The model must ask, then retry with `confirmed_distinct_from: [ids]`. So even if the prompt is ignored, a duplicate person cannot be created silently.

A partly-ambiguous message still makes progress: the clear facts are saved in one batch and the question covers only the unclear part.

## In-place corrections

Because ids are stable and a batch is atomic, each kind of correction is one call:

| The user says | What happens |
|---|---|
| "Sorry, it's Savitri, not Savita" | `update_person` on the same id. Relationships untouched, the old value returned in the result for the log. |
| "Sam is my uncle, not my father" | `remove_parent` — and the model explains that an uncle needs the grandparents recorded. |
| "John is my son, not my father" | `remove_parent` + `add_parent` in one batch. Removals run first, so the cycle check sees the final state. |


## Reliability

**Idempotency.** The client generates one `messageId` per message and reuses it on every retry. `claimMessage()` decides what a request may do: run it, replay a completed reply with no model call, refuse a duplicate that is still running (409 + `Retry-After`), refuse a reused id with different text (422), or stop after 3 attempts.

**The lease.** A claimed message holds `lease_expires_at` for 180 s, longer than the 120 s message deadline, so a live request never loses its lease and no heartbeat is needed. If the process dies, the lease expires and a retry takes the message over. 

**Atomicity.** Rule checks and writes run in the same `BEGIN IMMEDIATE` transaction, so two concurrent writers cannot each pass a check and then both write.

**Retries.** The browser retries network failures and 409s with the same `messageId`. Tool rejections are deliberately *not* retried in code — they go back to the model, which usually turns them into a question.

**Loop bounds.** At most 8 model calls and 120 s per message. On the final allowed round the request sets `tool_choice: {type: "none"}`, so the model cannot start work it has no round left to report — without that, a tool could commit and the user still be told nothing was saved.

## Tests and evals

`npm test -w server` — 15 tests, Node's built-in runner, in-memory database, no model, no network.

**Tree rules and writes** (`test/tree.test.js`)

- One batch records a whole statement, whatever order the operations are listed in
- A cycle is rejected, and the error names the path
- A third parent is rejected, but restating an existing one is a no-op
- A second spouse is rejected whichever side it is added from
- A batch that fails part-way writes nothing
- A correction renames in place and keeps every relationship
- The narrator is per conversation, and a chat cannot silently change who it is talking to
- An unknown id or ref is reported, not guessed

**Idempotency and the lease** (`test/claim.test.js`)

- A new message is claimed, and records the lease and first attempt
- A duplicate request while the first is still running is refused (409)
- Reusing a message id for different text is refused (422)
- A completed message replays its reply instead of running again
- A failed message can be retried, and gives up after `maxAttempts`
- A message whose lease expired can be taken over, but not while the lease is live
- The boot sweep frees interrupted messages immediately

`npm run eval -w server` — 4 scenarios against the real model, asserting on database rows rather than wording. They cost tokens, so they are not part of `npm test`. `EVAL_RUNS=5` reports a pass rate; latest run 12/12 over three runs.

- **Ambiguity** — two brothers named John: the reply asks a question, both Johns are untouched, nobody new is created
- **Correction** — "her name is Savitri, not Savita": two people total, the name is updated, the parent link survives
- **DAG** — a cycle is refused and explained, and no edge is written
- **Records only what was said** — "my parents are Sam and Jordan": two parent links, zero spouse links

## Metrics and alerting

`GET /api/metrics`, computed from `messages` and `tool_call_logs` so the numbers survive a restart.

- **Messages** — count by status, how many needed a retry, replies that ended early (e.g. the round cap), average rounds per message, p50 and p95 duration
- **LLM** — model, input and output tokens, estimated cost
- **Tools** — calls by tool and outcome, rejections by code, errors by code
- **Tree** — people, parent links, spouse links
- **Alerts** — rules firing right now

## Known limitations

- **The whole tree goes into every model call.** Fine for a family (a few hundred people); beyond that we should find the person of interest in the query and load the family members around them with a fallback to find_people.
- **Replies Should be Async.** The submission of user queries and the processing it should be async. Holding up a connection while waiting for the agent loop to complete is a waste of resources.
- **No streaming.** A reply appears when the message finishes; p95 is around 10 s for multi-step messages.
- **History gets trimmed for > 20 messages.** Ideally we should summarize the past conversation once it hits the threshold and pass it in the context
- **Couple should not be a parent & child.** This validation needs to be added to make things semantically valid.

## What I would do next

1. **Message Queue as a background job.** `POST /api/chat` returns `202` with the `messageId`, and the client polls or subscribes for the reply instead of holding a connection open for ten seconds. The schema already supports this — a `messages` row *is* the job record, with its status, lease and attempt count — so this is mostly moving the agent loop off the request.
2. **Stream the reply** over SSE once it is a job, and push graph changes to the client on write instead of polling every 4 seconds.
3. **Scale the context.** Below a few hundred people keep sending the whole tree; above that, send the narrator's neighbourhood plus anyone the conversation has mentioned, and let `find_people` cover the rest. Summarise older exchanges rather than dropping them at 20.
4. **Close the remaining rule gaps.** A couple should not also be parent and child.
5. **`merge_people` and undo.** "Johnny and John are the same person" is a real correction we cannot make today, and the tool log already holds the old values that undo would need.
