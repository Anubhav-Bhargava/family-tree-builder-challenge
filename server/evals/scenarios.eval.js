// Evals: do the prompt and tools produce the right behaviour from a real model?
//
// Unit tests (npm test) use a fake model and check our code. These call the real
// model and check what ended up in the database — never the wording of a reply,
// which is not stable. They cost tokens, so they are not part of npm test.
//
//   npm run eval            one run of each scenario
//   EVAL_RUNS=5 npm run eval    five runs, reported as a pass rate
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A scratch database, created before the modules that open one are imported.
const dir = mkdtempSync(join(tmpdir(), "family-tree-eval-"));
process.env.DATABASE_PATH = join(dir, "eval.db");

const { db } = await import("../src/db/connection.js");
const repo = await import("../src/db/repository.js");
const { applyChanges, findPeople, readGraph } = await import("../src/tree/familyTree.js");
const { getChatReply } = await import("../src/llm/client.js");

const SESSION = "eval-session";
let messageCount = 0;

/** Sends one user message through the agent, exactly as the chat route would. */
async function say(text) {
  const id = `eval-message-${++messageCount}`;
  repo.insertMessage({ id, sessionId: SESSION, text, expires: Date.now() + 120_000 });
  const reply = await getChatReply(repo.getMessage(id));
  repo.completeMessage(id, reply); // so the next message sees it as history
  return reply;
}

/** Records people directly, for scenarios that need a starting tree. */
const seed = (...operations) => applyChanges({ operations }, { sessionId: SESSION }).created;

const scenarios = [
  {
    name: "ambiguity: two brothers named John → asks instead of guessing",
    async run() {
      const ids = seed(
        { op: "create_person", ref: "me", name: "Alex", is_user: true },
        { op: "create_person", ref: "mum", name: "Priya" },
        { op: "create_person", ref: "j1", name: "John", birth_year: 1985 },
        { op: "create_person", ref: "j2", name: "John", birth_year: 1990, confirmed_distinct_from: [] },
        { op: "add_parent", parent: { ref: "mum" }, child: { ref: "me" } },
        { op: "add_parent", parent: { ref: "mum" }, child: { ref: "j1" } },
        { op: "add_parent", parent: { ref: "mum" }, child: { ref: "j2" } },
      );

      const reply = await say("my brother John lives in Pune");
      const johns = findPeople({ name: "John" }).candidates;

      return [
        [reply.includes("?"), "the reply asks a question"],
        [johns.length === 2, `still two Johns (found ${johns.length})`],
        [johns.every((j) => !j.notes), "neither John was updated on a guess"],
        [readGraph().people.length === 4, "nobody new was created"],
      ];
    },
  },
  {
    name: "correction: a misspelled name is fixed in place, not duplicated",
    async run() {
      await say("I'm Alex. My mother's name is Savita.");
      await say("Sorry, her name is Savitri, not Savita.");

      const people = readGraph().people.map((p) => p.name);
      return [
        [people.length === 2, `2 people expected, got ${people.length}: ${people.join(", ")}`],
        [people.includes("Savitri"), "the corrected name is recorded"],
        [!people.includes("Savita"), "the old name is gone"],
        [readGraph().parentEdges.length === 1, "the parent link survived the rename"],
      ];
    },
  },
  {
    name: "DAG: a cycle is refused and explained, nothing is written",
    async run() {
      seed(
        { op: "create_person", ref: "me", name: "Alex", is_user: true },
        { op: "create_person", ref: "dad", name: "Bob" },
        { op: "add_parent", parent: { ref: "dad" }, child: { ref: "me" } },
      );

      const reply = await say("Bob's father is Alex");
      const edges = readGraph().parentEdges;

      return [
        [edges.length === 1, `only the original edge remains (found ${edges.length})`],
        [/can|cannot|can't|already|loop|circular|ancestor|not possible/i.test(reply), "the reply explains the problem"],
      ];
    },
  },
  {
    name: "records only what was said: two parents are not assumed married",
    async run() {
      await say("I'm Alex. My parents are Sam and Jordan.");

      const graph = readGraph();
      return [
        [graph.people.length === 3, `3 people expected, got ${graph.people.length}`],
        [graph.parentEdges.length === 2, `2 parent links expected, got ${graph.parentEdges.length}`],
        [graph.spouseEdges.length === 0, "no marriage was invented"],
      ];
    },
  },
];

// ── runner ───────────────────────────────────────────────────────────────────

const runs = Number(process.env.EVAL_RUNS ?? 1);
const results = new Map(scenarios.map((s) => [s.name, { passed: 0, failures: [] }]));

for (let run = 1; run <= runs; run++) {
  for (const scenario of scenarios) {
    db.exec("DELETE FROM people; DELETE FROM sessions;");
    repo.upsertSession(SESSION);

    const result = results.get(scenario.name);
    try {
      const checks = await scenario.run();
      const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
      if (failed.length === 0) result.passed++;
      else result.failures.push(`run ${run}: ${failed.join("; ")}`);
    } catch (err) {
      result.failures.push(`run ${run}: threw ${err.message}`);
    }
  }
}

console.log(`\n${runs} run(s) per scenario, model ${process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5"}\n`);
let allPassed = true;
for (const [name, { passed, failures }] of results) {
  console.log(`${passed === runs ? "PASS" : "FAIL"}  ${passed}/${runs}  ${name}`);
  for (const failure of failures.slice(0, 3)) console.log(`        ${failure}`);
  if (passed !== runs) allPassed = false;
}

const usage = db.prepare("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM messages").get();
console.log(`\ntokens: ${usage.i} in, ${usage.o} out`);

db.close();
rmSync(dir, { recursive: true, force: true });
process.exit(allPassed ? 0 : 1);
