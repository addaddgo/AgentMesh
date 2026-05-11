import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { BackendConfig } from "../config.js";
import { runMigrations } from "./migrations.js";
import * as schema from "./schema.js";

export type DatabaseHandle = {
  readonly sqlite: Database.Database;
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  readonly close: () => void;
};

export function createDatabase(config: BackendConfig): DatabaseHandle {
  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });

  const sqlite = new Database(config.sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    close: () => {
      sqlite.close();
    }
  };
}

export function initializeDatabase(handle: DatabaseHandle): void {
  runMigrations(handle.sqlite);
}
