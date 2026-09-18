// The rules that keep the tree correct, and the batch behaviour they depend on.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db/connection.js";
import * as repo from "../src/db/repository.js";
import { applyChanges, findPeople, readGraph } from "../src/tree/familyTree.js";

const SESSION = "test-session";

beforeEach(() => {
  db.exec("DELETE FROM people; DELETE FROM sessions;"); // edges and messages cascade
  repo.upsertSession(SESSION);
});

/** Applies a batch and returns the ref → id map. */
const apply = (...operations) => applyChanges({ operations }, { sessionId: SESSION }).created;
const rejects = (fn, code) => assert.throws(fn, (err) => err.code === code, `expected ${code}`);

const person = (ref, name, extra = {}) => ({ op: "create_person", ref, name, ...extra });
const parent = (p, c) => ({ op: "add_parent", parent: p, child: c });
const ref = (name) => ({ ref: name });
const id = (value) => ({ id: value });

test("one batch records a whole statement, whatever order the operations are listed in", () => {
  // add_parent comes first: the executor must still create the people before linking them.
  const ids = apply(
    parent(ref("mum"), ref("me")),
    person("me", "Alex"),
    person("mum", "Sam"),
  );

  const graph = readGraph();
  assert.equal(graph.people.length, 2);
  assert.deepEqual(graph.parentEdges, [{ parentId: ids.mum, childId: ids.me }]);
});

test("a cycle is rejected, and names the path", () => {
  const ids = apply(person("a", "Ann"), person("b", "Bob"), person("c", "Cat"),
    parent(ref("a"), ref("b")), parent(ref("b"), ref("c")));

  assert.throws(
    () => apply(parent(id(ids.c), id(ids.a))),
    (err) => err.code === "CYCLE" && err.details.path.join(" > ") === "Cat > Bob > Ann",
  );
  assert.equal(readGraph().parentEdges.length, 2, "nothing was written");
});

test("a third parent is rejected, but restating an existing one is a no-op", () => {
  const ids = apply(person("kid", "Kid"), person("mum", "Mum"), person("dad", "Dad"), person("x", "Other"),
    parent(ref("mum"), ref("kid")), parent(ref("dad"), ref("kid")));

  rejects(() => apply(parent(id(ids.x), id(ids.kid))), "MAX_PARENTS");

  const result = applyChanges({ operations: [parent(id(ids.mum), id(ids.kid))] }, { sessionId: SESSION });
  assert.equal(result.applied[0].status, "already_exists");
});

test("a second spouse is rejected whichever side it is added from", () => {
  const ids = apply(person("a", "Ann"), person("b", "Bob"), person("c", "Cat"),
    { op: "add_spouse", a: ref("a"), b: ref("b") });

  rejects(() => apply({ op: "add_spouse", a: id(ids.c), b: id(ids.a) }), "SPOUSE_LIMIT");
  rejects(() => apply({ op: "add_spouse", a: id(ids.b), b: id(ids.c) }), "SPOUSE_LIMIT");
});

test("a batch that fails part-way writes nothing", () => {
  const ids = apply(person("kid", "Kid"), person("mum", "Mum"), person("dad", "Dad"),
    parent(ref("mum"), ref("kid")), parent(ref("dad"), ref("kid")));

  rejects(() => apply(person("new", "Newcomer"), parent(ref("new"), id(ids.kid))), "MAX_PARENTS");
  assert.equal(readGraph().people.length, 3, "Newcomer was rolled back with the failed edge");
});


test("a correction renames in place and keeps every relationship", () => {
  const ids = apply(person("dad", "Jhon"), person("kid", "Kid"), parent(ref("dad"), ref("kid")));

  const result = applyChanges(
    { operations: [{ op: "update_person", person: id(ids.dad), set: { name: "John" } }] },
    { sessionId: SESSION },
  );

  assert.equal(result.applied[0].before.name, "Jhon", "the old value is returned for the audit log");
  const graph = readGraph();
  assert.equal(graph.people.find((p) => p.id === ids.dad).name, "John");
  assert.deepEqual(graph.parentEdges, [{ parentId: ids.dad, childId: ids.kid }]);
});

test("the narrator is per conversation, and a chat cannot silently change who it is talking to", () => {
  const ids = apply(person("me", "Alex", { is_user: true }));
  assert.equal(repo.getNarrator(SESSION).id, ids.me);

  rejects(() => apply(person("other", "Blake", { is_user: true })), "NARRATOR_ALREADY_SET");

  repo.upsertSession("second-session");
  const other = applyChanges(
    { operations: [person("me2", "Blake", { is_user: true })] },
    { sessionId: "second-session" },
  ).created.me2;
  assert.equal(repo.getNarrator("second-session").id, other, "a second chat has its own narrator");
  assert.equal(repo.getNarrator(SESSION).id, ids.me, "the first chat is unchanged");
});


test("an unknown id or ref is reported, not guessed", () => {
  rejects(() => apply(parent(id("p_nosuchperson"), id("p_alsonone"))), "NOT_FOUND");
  rejects(() => apply(person("a", "Ann"), parent(ref("a"), ref("typo"))), "UNKNOWN_REF");
});

