// The family tree: lookups, the rules, and atomic batches of changes.
import { randomBytes } from "node:crypto";
import { transaction } from "../db/connection.js";
import * as repo from "../db/repository.js";
import { nameKey, nameMatch } from "./names.js";

/** A structured error the model can read. kind "rejected" = a rule said no; "invalid" = malformed input. */
export class ToolError extends Error {
  constructor(code, message, details = {}, kind = "rejected") {
    super(message);
    Object.assign(this, { code, details, kind });
  }
}
const invalid = (message) => new ToolError("INVALID_INPUT", message, {}, "invalid");

// ─────────────── reads ───────────────

const RELATIONS = {
  parent: repo.parentsOf,
  child: repo.childrenOf,
  sibling: repo.siblingsOf,
  spouse: (id) => [repo.spouseOf(id)].filter(Boolean),
};

export function findPeople({ name, related_to: relatedTo }) {
  if (!name && !relatedTo) throw invalid("find_people needs a name, related_to, or both.");

  let pool = repo.allPeople();
  if (relatedTo) {
    const related = RELATIONS[relatedTo.relation];
    if (!related) throw invalid("related_to.relation must be parent, child, spouse or sibling.");
    const ids = new Set(related(requirePerson(relatedTo.person_id).id).map((p) => p.id));
    pool = pool.filter((p) => ids.has(p.id));
  }

  const rank = { exact: 0, partial: 1, fuzzy: 2, related: 3 };
  const candidates = pool
    .map((p) => ({ ...describe(p), match: name ? nameMatch(nameKey(name), p.name_key) : "related" }))
    .filter((c) => c.match)
    .sort((x, y) => rank[x.match] - rank[y.match]);
  return { candidates };
}

/** GET /api/graph */
export function readGraph() {
  return {
    people: repo.allPeople().map((p) => ({ id: p.id, name: p.name, birthYear: p.birth_year })),
    parentEdges: repo.allParentEdges(),
    spouseEdges: repo.allSpouseEdges(),
  };
}

/** The whole tree, one line per person, for the system prompt. `narratorId` is this chat's "I". */
export function renderSnapshot(narratorId) {
  const people = repo.allPeople();
  if (people.length === 0) return "The tree is empty. Nobody is recorded yet, including the user.";

  const lines = people.map((p) => {
    const parts = [p.id, p.name];
    if (p.id === narratorId) parts.push("THE USER");
    if (p.birth_year) parts.push(`born ${p.birth_year}`);
    if (p.sex) parts.push(p.sex);
    const parents = repo.parentsOf(p.id);
    if (parents.length) parts.push(`parents: ${parents.map((x) => `${x.name} (${x.id})`).join(", ")}`);
    const spouse = repo.spouseOf(p.id);
    if (spouse) parts.push(`spouse: ${spouse.name} (${spouse.id})`);
    if (p.notes) parts.push(`notes: ${p.notes}`);
    return parts.join(" | ");
  });
  const noUser = narratorId ? "" : " The person you are talking to is not recorded yet.";
  return [`${people.length} people.${noUser}`, ...lines].join("\n");
}

// ─────────────── writes ───────────────

// Removals first, then creates and updates, then new links, so a correction like
// "John is my son, not my father" works whatever order the model lists the ops in.
const PHASE = {
  remove_parent: 0,
  remove_spouse: 0,
  delete_person: 0,
  create_person: 1,
  update_person: 1,
  add_parent: 2,
  add_spouse: 2,
};

/** apply_changes: every operation is saved, or none is. */
export function applyChanges({ operations }, { sessionId } = {}) {
  if (!Array.isArray(operations) || operations.length === 0) throw invalid("operations must be a non-empty array.");
  if (operations.length > 40) throw invalid("At most 40 operations per call.");
  operations.forEach((op, i) => {
    if (!(op?.op in PHASE)) throw invalid(`Operation ${i}: op must be one of ${Object.keys(PHASE).join(", ")}.`);
  });

  const created = {}; // ref → id
  const applied = [];
  const ordered = operations.map((op, index) => ({ op, index })).sort((x, y) => PHASE[x.op.op] - PHASE[y.op.op]);

  transaction(() => {
    for (const { op, index } of ordered) {
      try {
        applied.push({ index, op: op.op, ...applyOne(op, created, sessionId) });
      } catch (err) {
        if (err instanceof ToolError) err.details.op_index = index;
        throw err; // rolls back everything
      }
    }
  });

  return { created, applied: applied.sort((x, y) => x.index - y.index) };
}

function applyOne(op, created, sessionId) {

  const resolve = (field) => {
    const ref = op[field];
    if (ref?.id) return requirePerson(ref.id).id;
    if (ref?.ref && created[ref.ref]) return created[ref.ref];
    if (ref?.ref) throw new ToolError("UNKNOWN_REF", `No person with ref "${ref.ref}" was created in this call.`);
    throw invalid(`${op.op} needs ${field} as { "id": ... } or { "ref": ... }.`);
  };

  switch (op.op) {
    case "create_person":
      return createPerson(op, created, sessionId);
    case "update_person":
      return updatePerson(resolve("person"), op.set ?? {}, sessionId);
    case "delete_person": {
      const person = requirePerson(resolve("person"));
      repo.deletePerson(person.id);
      return { status: "applied", before: { name: person.name } };
    }
    case "add_parent":
      return { status: addParent(resolve("parent"), resolve("child")) };
    case "remove_parent":
      return { status: repo.deleteParentEdge(resolve("parent"), resolve("child")) ? "applied" : "not_present" };
    case "add_spouse":
      return { status: addSpouse(resolve("a"), resolve("b")) };
    case "remove_spouse":
      return { status: repo.deleteSpouseEdge(resolve("a"), resolve("b")) ? "applied" : "not_present" };
  }
}

function createPerson(op, created, sessionId) {
  if (!op.ref || typeof op.name !== "string") throw invalid("create_person needs ref and name.");
  checkNotDuplicate(op, new Set(Object.values(created)));

  const id = newPersonId();
  repo.insertPerson({
    id,
    name: op.name.trim(),
    name_key: nameKey(op.name),
    sex: op.sex ?? null,
    birth_year: op.birth_year ?? null,
    notes: op.notes ?? null,
  });
  created[op.ref] = id;
  if (op.is_user) setNarrator(sessionId, id);
  return { status: "applied", id };
}

function updatePerson(id, set, sessionId) {
  const before = requirePerson(id);
  const fields = {};
  for (const key of ["name", "sex", "birth_year", "notes"]) {
    if (set[key] !== undefined) fields[key] = set[key];
  }
  if (set.is_user) setNarrator(sessionId, id);
  if (Object.keys(fields).length === 0 && !set.is_user) throw invalid("update_person needs at least one field in set.");
  if (fields.name !== undefined) fields.name_key = nameKey(fields.name);

  if (Object.keys(fields).length > 0) repo.updatePerson(id, fields);
  // The old values go into the result, so tool_call_logs doubles as the audit trail.
  return { status: "applied", before: Object.fromEntries(Object.keys(set).map((k) => [k, before[k]])) };
}

// ─────────────── rules ───────────────

function addParent(parentId, childId) {
  const parent = requirePerson(parentId);
  const child = requirePerson(childId);
  if (parentId === childId) throw new ToolError("CYCLE", `${child.name} can't be their own parent.`);
  if (repo.hasParentEdge(parentId, childId)) return "already_exists"; // restating a fact is not a third parent

  const parents = repo.parentsOf(childId);
  if (parents.length >= 2) {
    throw new ToolError(
      "MAX_PARENTS",
      `${child.name} already has two parents: ${parents.map((p) => p.name).join(" and ")}.`,
      { parents },
    );
  }

  // A cycle forms exactly when the child is already an ancestor of the parent.
  const path = repo.ancestorPath(parentId, childId);
  if (path) {
    const names = path.map((id) => repo.getPerson(id).name);
    throw new ToolError("CYCLE", `${child.name} is already an ancestor of ${parent.name} (${names.join(" > ")}).`, {
      path: names,
    });
  }

  repo.insertParentEdge(parentId, childId);
  return "applied";
}

function addSpouse(a, b) {
  const personA = requirePerson(a);
  const personB = requirePerson(b);
  if (a === b) throw new ToolError("INVALID_SPOUSE", `${personA.name} can't be married to themselves.`);
  if (repo.spouseOf(a)?.id === b) return "already_exists";

  for (const person of [personA, personB]) {
    const spouse = repo.spouseOf(person.id);
    if (spouse) {
      throw new ToolError("SPOUSE_LIMIT", `${person.name} is already married to ${spouse.name}. Remarriage isn't supported.`);
    }
  }

  repo.insertSpouseEdge(a, b);
  return "applied";
}

/** A new person whose name matches someone already recorded needs the user to confirm they're different. */
function checkNotDuplicate(op, createdThisCall) {
  const confirmed = new Set(op.confirmed_distinct_from ?? []);
  const key = nameKey(op.name);
  const matches = repo
    .allPeople()
    .filter((p) => !createdThisCall.has(p.id) && !confirmed.has(p.id) && nameMatch(key, p.name_key))
    .map(describe);

  if (matches.length > 0) {
    throw new ToolError(
      "POSSIBLE_DUPLICATE",
      `The tree already has ${matches.map((m) => m.name).join(", ")}. Ask the user if "${op.name}" is one of them. ` +
        "If it's a different person, retry with confirmed_distinct_from listing those ids.",
      { candidates: matches },
    );
  }
}

/** Records who "I" means in this chat. Refuses to reassign silently. */
function setNarrator(sessionId, personId) {
  const current = repo.getNarrator(sessionId);
  if (current && current.id !== personId) {
    throw new ToolError(
      "NARRATOR_ALREADY_SET",
      `This conversation is already with ${current.name}. If that is wrong, ask the user who you are talking to.`,
      { current: { id: current.id, name: current.name } },
    );
  }
  repo.setNarrator(sessionId, personId);
}

// ─────────────── helpers ───────────────

function requirePerson(id) {
  const person = repo.getPerson(id);
  if (!person) throw new ToolError("NOT_FOUND", `No person has the id ${id}. Use find_people to get ids.`);
  return person;
}

function describe(p) {
  return {
    id: p.id,
    name: p.name,
    birth_year: p.birth_year,
    notes: p.notes,
    parents: repo.parentsOf(p.id),
    children: repo.childrenOf(p.id),
    spouse: repo.spouseOf(p.id),
    siblings: repo.siblingsOf(p.id),
  };
}

function newPersonId() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/1/o/0: easy for the model to copy
  return "p_" + Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
}
