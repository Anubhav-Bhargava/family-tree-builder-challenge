import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { config } from "../config.js";

export const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL"); // graph polls read while chat writes
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

if (db.pragma("user_version", { simple: true }) === 0) {
  db.transaction(() => {
    db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    db.pragma("user_version = 1");
  })();
}

/** Runs fn in BEGIN IMMEDIATE, so checks and writes can't interleave with another writer. */
export const transaction = (fn) => db.transaction(fn).immediate();
