// Tool definitions for the model, and running one tool call.
import * as repo from "../db/repository.js";
import { ToolError, applyChanges, findPeople } from "../tree/familyTree.js";

const personRef = {
  type: "object",
  description: 'An existing person { "id": "p_..." } or one created earlier in this call { "ref": "n1" }.',
  properties: { id: { type: "string" }, ref: { type: "string" } },
};
const personFields = {
  name: { type: "string" },
  sex: { type: "string", enum: ["female", "male", "other"] },
  birth_year: { type: "integer" },
  notes: { type: "string", description: "Nicknames, maiden names, anything that tells people apart." },
  is_user: { type: "boolean", description: "true for the person you are talking to in this conversation." },
};

export const TOOLS = [
  {
    name: "find_people",
    description:
      "Look up people. Returns every candidate with their parents, children, spouse and siblings, best match first. " +
      'It never picks one for you. For "my brother John" pass related_to with the user\'s id.',
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name, first name, or a misspelling." },
        related_to: {
          type: "object",
          properties: {
            person_id: { type: "string" },
            relation: { type: "string", enum: ["parent", "child", "spouse", "sibling"] },
          },
          required: ["person_id", "relation"],
        },
      },
    },
  },
  {
    name: "apply_changes",
    description:
      "Record or correct facts. All operations are saved together or not at all, so put a whole statement, " +
      "or a whole correction (remove the wrong fact, add the right one), in one call. " +
      'The server makes ids: give each new person a ref like "n1" and link them with { "ref": "n1" }.\n' +
      "Operations:\n" +
      "- create_person: ref, name, optional sex, birth_year, notes, is_user, confirmed_distinct_from (ids the user said are different people)\n" +
      "- update_person: person, set { name, sex, birth_year, notes, is_user }\n" +
      "- delete_person: person\n" +
      "- add_parent / remove_parent: parent, child\n" +
      "- add_spouse / remove_spouse: a, b\n" +
      "An error means nothing was saved.",
    input_schema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["create_person", "update_person", "delete_person", "add_parent", "remove_parent", "add_spouse", "remove_spouse"],
              },
              ref: { type: "string" },
              ...personFields,
              confirmed_distinct_from: { type: "array", items: { type: "string" } },
              person: personRef,
              set: { type: "object", properties: personFields },
              parent: personRef,
              child: personRef,
              a: personRef,
              b: personRef,
            },
            required: ["op"],
          },
        },
      },
      required: ["operations"],
    },
  },
];

const HANDLERS = {
  find_people: (input) => findPeople(input),
  apply_changes: (input, ctx) => applyChanges(input, { sessionId: ctx.message.session_id }),
};

/**
 * Runs one tool_use block and returns its tool_result block. Never throws: a
 * failure becomes an is_error result the model can read. Every call is logged
 * with an outcome: ok, rejected (a rule said no), or error (bad input or a bug).
 */
export function runTool(block, ctx) {
  const { message, model } = ctx;
  const started = Date.now();
  let result;
  let outcome = "ok";
  let errorCode = null;

  try {
    const handler = HANDLERS[block.name];
    if (!handler) throw new ToolError("INVALID_INPUT", `There is no tool called ${block.name}.`, {}, "invalid");
    result = handler(block.input ?? {}, ctx);
  } catch (err) {
    if (err instanceof ToolError) {
      outcome = err.kind === "rejected" ? "rejected" : "error";
      errorCode = err.code;
      result = { error: err.code, message: err.message, details: err.details };
    } else if (err.code?.startsWith("SQLITE_CONSTRAINT")) {
      // A CHECK in the schema caught a bad value (empty name, sex not in the list, ...).
      outcome = "error";
      errorCode = "INVALID_INPUT";
      result = { error: errorCode, message: `The database rejected a value: ${err.message}. Nothing was saved.` };
    } else {
      outcome = "error";
      errorCode = "INTERNAL";
      result = { error: errorCode, message: "The tool failed unexpectedly. Nothing was saved." };
      console.error(`[tool] ${block.name} failed`, err);
    }
  }

  repo.insertToolCallLog({
    messageId: message.id,
    attempt: message.attempts,
    toolUseId: block.id,
    toolName: block.name,
    model,
    input: JSON.stringify(block.input),
    result: JSON.stringify(result),
    outcome,
    errorCode,
    latencyMs: Date.now() - started,
  });

  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: JSON.stringify(result),
    ...(outcome === "ok" ? {} : { is_error: true }),
  };
}
