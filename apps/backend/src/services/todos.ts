import { randomUUID } from "node:crypto";

import type { TodoItemDto, TodoUpdateRequest } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError } from "../errors.js";
import { EventService } from "./events.js";

type TodoRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string | null;
  readonly sort_index: number;
  readonly due_at: number | null;
  readonly done: number;
  readonly created_at: number;
  readonly updated_at: number;
};

export class TodoService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly events: EventService
  ) {}

  public list(): readonly TodoItemDto[] {
    const rows = this.database.sqlite
      .prepare("SELECT * FROM todos ORDER BY sort_index ASC")
      .all() as TodoRow[];
    return rows.map(toTodoItemDto);
  }

  public create(input: { name: string; description?: string; category?: string | null | undefined; dueAt?: number | null | undefined }): TodoItemDto {
    const now = Date.now();
    const id = `todo_${randomUUID()}`;
    const description = input.description ?? "";
    const dueAt = input.dueAt === undefined ? null : input.dueAt;

    this.database.sqlite
      .prepare(
        `
          INSERT INTO todos (id, name, description, category, sort_index, due_at, done, created_at, updated_at)
          VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_index), -1) + 1 FROM todos), ?, 0, ?, ?)
        `
      )
      .run(id, input.name, description, input.category ?? null, dueAt, now, now);

    const row = this.database.sqlite
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(id) as TodoRow;

    const item = toTodoItemDto(row);
    this.events.publish({ type: "todo.updated", payload: { action: "created", item } });
    return item;
  }

  public update(id: string, input: TodoUpdateRequest): TodoItemDto {
    const existing = this.database.sqlite
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(id) as TodoRow | undefined;

    if (!existing) {
      throw new NotFoundError(`Todo not found: ${id}`);
    }

    const now = Date.now();

    this.database.sqlite
      .prepare(
        `
          UPDATE todos
          SET
            name = COALESCE(?, name),
            description = COALESCE(?, description),
            category = COALESCE(?, category),
            sort_index = COALESCE(?, sort_index),
            due_at = ?,
            done = COALESCE(?, done),
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.name ?? null,
        input.description ?? null,
        input.category ?? null,
        input.sortIndex ?? null,
        input.dueAt === undefined ? existing.due_at : input.dueAt,
        input.done === undefined ? null : input.done ? 1 : 0,
        now,
        id
      );

    const row = this.database.sqlite
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(id) as TodoRow;

    const item = toTodoItemDto(row);
    this.events.publish({ type: "todo.updated", payload: { action: "updated", item } });
    return item;
  }

  public delete(id: string): void {
    const existing = this.database.sqlite
      .prepare("SELECT * FROM todos WHERE id = ?")
      .get(id) as TodoRow | undefined;

    if (!existing) {
      throw new NotFoundError(`Todo not found: ${id}`);
    }

    this.database.sqlite.prepare("DELETE FROM todos WHERE id = ?").run(id);
    this.events.publish({ type: "todo.updated", payload: { action: "deleted", id } });
  }

  public reorder(ids: readonly string[]): readonly TodoItemDto[] {
    const updateStmt = this.database.sqlite.prepare(
      "UPDATE todos SET sort_index = ?, updated_at = ? WHERE id = ?"
    );

    const reorder = this.database.sqlite.transaction(() => {
      const now = Date.now();
      for (let i = 0; i < ids.length; i++) {
        updateStmt.run(i, now, ids[i]);
      }
    });

    reorder();

    const rows = this.database.sqlite
      .prepare("SELECT * FROM todos ORDER BY sort_index ASC")
      .all() as TodoRow[];

    const items = rows.map(toTodoItemDto);
    this.events.publish({ type: "todo.updated", payload: { action: "reordered", items } });
    return items;
  }
}

function toTodoItemDto(row: TodoRow): TodoItemDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    sortIndex: row.sort_index,
    dueAt: row.due_at,
    done: row.done === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
