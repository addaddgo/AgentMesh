import { randomUUID } from "node:crypto";

import type { SplitPaneTree, ThreadDraftDto, UiLayoutDto, UiLayoutKind } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError } from "../errors.js";

type UiLayoutRow = {
  readonly id: string;
  readonly kind: UiLayoutKind;
  readonly owner_id: string;
  readonly tree_json: string;
  readonly updated_at: number;
};

type ThreadDraftRow = {
  readonly app_server_id: string;
  readonly thread_id: string;
  readonly draft_markdown: string;
  readonly updated_at: number;
};

type ThreadOwnerRow = {
  readonly id: string;
  readonly app_server_id: string;
};

export class UiLayoutService {
  public constructor(private readonly database: DatabaseHandle) {}

  public listLayouts(): UiLayoutDto[] {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM ui_layouts
          ORDER BY kind ASC, owner_id ASC
        `
      )
      .all() as UiLayoutRow[];

    return rows.map(toUiLayoutDto);
  }

  public saveLayout(input: {
    readonly id?: string;
    readonly kind: UiLayoutKind;
    readonly ownerId: string;
    readonly layoutJson: SplitPaneTree | null;
  }): UiLayoutDto {
    const now = Date.now();
    const existing = this.database.sqlite
      .prepare("SELECT * FROM ui_layouts WHERE kind = ? AND owner_id = ?")
      .get(input.kind, input.ownerId) as UiLayoutRow | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    const treeJson = JSON.stringify(input.layoutJson);

    this.database.sqlite
      .prepare(
        `
          INSERT INTO ui_layouts (id, kind, owner_id, tree_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(kind, owner_id) DO UPDATE SET
            tree_json = excluded.tree_json,
            updated_at = excluded.updated_at
        `
      )
      .run(id, input.kind, input.ownerId, treeJson, now);

    const row = this.database.sqlite.prepare("SELECT * FROM ui_layouts WHERE id = ?").get(id) as
      | UiLayoutRow
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("UI layout not found");
    }

    return toUiLayoutDto(row);
  }

  public listDrafts(): ThreadDraftDto[] {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT *
          FROM thread_drafts
          ORDER BY updated_at DESC
        `
      )
      .all() as ThreadDraftRow[];

    return rows.map(toThreadDraftDto);
  }

  public saveDraft(threadId: string, draftMarkdown: string): ThreadDraftDto {
    const thread = this.database.sqlite
      .prepare("SELECT id, app_server_id FROM threads WHERE id = ?")
      .get(threadId) as ThreadOwnerRow | undefined;

    if (thread === undefined) {
      throw new NotFoundError("Thread not found");
    }

    const now = Date.now();
    this.database.sqlite
      .prepare(
        `
          INSERT INTO thread_drafts (app_server_id, thread_id, draft_markdown, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(app_server_id, thread_id) DO UPDATE SET
            draft_markdown = excluded.draft_markdown,
            updated_at = excluded.updated_at
        `
      )
      .run(thread.app_server_id, threadId, draftMarkdown, now);

    return {
      appServerId: thread.app_server_id,
      threadId,
      draftMarkdown,
      updatedAt: now
    };
  }
}

function toUiLayoutDto(row: UiLayoutRow): UiLayoutDto {
  return {
    id: row.id,
    kind: row.kind,
    ownerId: row.owner_id,
    layoutJson: JSON.parse(row.tree_json) as SplitPaneTree | null,
    createdAt: row.updated_at,
    updatedAt: row.updated_at
  };
}

function toThreadDraftDto(row: ThreadDraftRow): ThreadDraftDto {
  return {
    appServerId: row.app_server_id,
    threadId: row.thread_id,
    draftMarkdown: row.draft_markdown,
    updatedAt: row.updated_at
  };
}
