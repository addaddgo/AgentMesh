import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { AccountUsageDto, AccountUsageWindow } from "@agentmesh/shared";

type ThreadUsageRow = {
  readonly tokens_used: number;
  readonly updated_at_ms: number | null;
  readonly created_at_ms: number | null;
};

const WINDOW_MS: Record<AccountUsageWindow, number> = {
  "5h": 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
};

export class AccountUsageStatsService {
  public readUsage(sampledAt = Date.now()): AccountUsageDto[] {
    const dbPath = path.join(os.homedir(), ".codex", "state_5.sqlite");
    if (!fs.existsSync(dbPath)) {
      return buildEmptyUsage(sampledAt);
    }

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      return (Object.keys(WINDOW_MS) as AccountUsageWindow[]).map((window) =>
        this.readWindow(sqlite, window, sampledAt)
      );
    } finally {
      sqlite.close();
    }
  }

  private readWindow(
    sqlite: Database.Database,
    window: AccountUsageWindow,
    sampledAt: number
  ): AccountUsageDto {
    const periodStartedAt = sampledAt - WINDOW_MS[window];
    const rows = sqlite
      .prepare(
        `
          SELECT tokens_used, created_at_ms, updated_at_ms
          FROM threads
          WHERE COALESCE(updated_at_ms, created_at_ms, 0) >= ?
        `
      )
      .all(periodStartedAt) as ThreadUsageRow[];

    return {
      window,
      usedTokens: rows.reduce((sum, row) => sum + row.tokens_used, 0),
      threadCount: rows.length,
      periodStartedAt,
      sampledAt,
      limitTokens: null
    };
  }
}

function buildEmptyUsage(sampledAt: number): AccountUsageDto[] {
  return (Object.keys(WINDOW_MS) as AccountUsageWindow[]).map((window) => ({
    window,
    usedTokens: 0,
    threadCount: 0,
    periodStartedAt: sampledAt - WINDOW_MS[window],
    sampledAt,
    limitTokens: null
  }));
}
