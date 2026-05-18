import { randomUUID } from "node:crypto";

import type {
  TodoDeadlineMode,
  TodoItemDto,
  TodoTagImportance,
  TodoTagRuleDto,
  TodoUpdateRequest
} from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, RequestValidationError } from "../errors.js";
import { EventService } from "./events.js";

type TodoRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string | null;
  readonly tags_json: string;
  readonly sort_index: number;
  readonly due_at: number | null;
  readonly deadline_mode: TodoDeadlineMode | null;
  readonly relative_duration_minutes: number | null;
  readonly done: number;
  readonly created_at: number;
  readonly updated_at: number;
};

type TodoTagRuleRow = {
  readonly name: string;
  readonly importance: TodoTagImportance;
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

  public listCategories(): readonly string[] {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT DISTINCT category
          FROM todos
          WHERE category IS NOT NULL AND TRIM(category) != ''
          ORDER BY LOWER(category) ASC, category ASC
        `
      )
      .all() as Array<{ readonly category: string }>;

    return rows.map((row) => row.category);
  }

  public listTagRules(): readonly TodoTagRuleDto[] {
    const rows = this.database.sqlite
      .prepare("SELECT * FROM todo_tag_rules ORDER BY LOWER(name) ASC, name ASC")
      .all() as TodoTagRuleRow[];
    return rows.map(toTodoTagRuleDto);
  }

  public create(input: {
    name: string;
    description?: string;
    category?: string | null | undefined;
    tags?: readonly string[] | undefined;
    dueAt?: number | null | undefined;
    deadlineMode?: TodoDeadlineMode | null | undefined;
    relativeDurationMinutes?: number | null | undefined;
  }): TodoItemDto {
    const now = Date.now();
    const id = `todo_${randomUUID()}`;
    const description = input.description ?? "";
    const tagsJson = JSON.stringify(normalizeTags(input.tags ?? []));
    const dueAt = input.dueAt === undefined ? null : input.dueAt;
    const deadlineMode = input.deadlineMode === undefined ? null : input.deadlineMode;
    const relativeDurationMinutes =
      input.relativeDurationMinutes === undefined ? null : input.relativeDurationMinutes;

    this.database.sqlite
      .prepare(
        `
          INSERT INTO todos (
            id,
            name,
            description,
            category,
            tags_json,
            sort_index,
            due_at,
            deadline_mode,
            relative_duration_minutes,
            done,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_index), -1) + 1 FROM todos), ?, ?, ?, 0, ?, ?)
        `
      )
      .run(
        id,
        input.name,
        description,
        input.category ?? null,
        tagsJson,
        dueAt,
        deadlineMode,
        relativeDurationMinutes,
        now,
        now
      );

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
            tags_json = COALESCE(?, tags_json),
            sort_index = COALESCE(?, sort_index),
            due_at = ?,
            deadline_mode = ?,
            relative_duration_minutes = ?,
            done = COALESCE(?, done),
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.name ?? null,
        input.description ?? null,
        input.category ?? null,
        input.tags === undefined ? null : JSON.stringify(normalizeTags(input.tags)),
        input.sortIndex ?? null,
        input.dueAt === undefined ? existing.due_at : input.dueAt,
        input.deadlineMode === undefined ? existing.deadline_mode : input.deadlineMode,
        input.relativeDurationMinutes === undefined
          ? existing.relative_duration_minutes
          : input.relativeDurationMinutes,
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

  public upsertTagRule(name: string, importance: TodoTagImportance): TodoTagRuleDto {
    const normalizedName = normalizeTagName(name);
    if (normalizedName.length === 0) {
      throw new RequestValidationError("Tag rule name cannot be empty");
    }

    const now = Date.now();
    this.database.sqlite
      .prepare(
        `
          INSERT INTO todo_tag_rules (name, importance, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            importance = excluded.importance,
            updated_at = excluded.updated_at
        `
      )
      .run(normalizedName, importance, now, now);

    const row = this.database.sqlite
      .prepare("SELECT * FROM todo_tag_rules WHERE name = ?")
      .get(normalizedName) as TodoTagRuleRow;
    const rule = toTodoTagRuleDto(row);
    this.events.publish({ type: "todo.updated", payload: { action: "tag-rule-upserted", rule } });
    return rule;
  }

  public deleteTagRule(name: string): void {
    const normalizedName = normalizeTagName(name);
    const existing = this.database.sqlite
      .prepare("SELECT * FROM todo_tag_rules WHERE name = ?")
      .get(normalizedName) as TodoTagRuleRow | undefined;

    if (!existing) {
      throw new NotFoundError(`Todo tag rule not found: ${name}`);
    }

    this.database.sqlite.prepare("DELETE FROM todo_tag_rules WHERE name = ?").run(normalizedName);
    this.events.publish({
      type: "todo.updated",
      payload: { action: "tag-rule-deleted", name: normalizedName }
    });
  }

  public renameTagRule(name: string, nextName: string): TodoTagRuleDto {
    const normalizedName = normalizeTagName(name);
    const normalizedNextName = normalizeTagName(nextName);

    if (normalizedName.length === 0 || normalizedNextName.length === 0) {
      throw new RequestValidationError("Tag rule name cannot be empty");
    }
    if (normalizedName === normalizedNextName) {
      const existing = this.database.sqlite
        .prepare("SELECT * FROM todo_tag_rules WHERE name = ?")
        .get(normalizedName) as TodoTagRuleRow | undefined;
      if (existing === undefined) {
        throw new NotFoundError(`Todo tag rule not found: ${name}`);
      }
      return toTodoTagRuleDto(existing);
    }

    const existing = this.database.sqlite
      .prepare("SELECT * FROM todo_tag_rules WHERE name = ?")
      .get(normalizedName) as TodoTagRuleRow | undefined;
    if (existing === undefined) {
      throw new NotFoundError(`Todo tag rule not found: ${name}`);
    }

    const duplicate = this.database.sqlite
      .prepare("SELECT 1 FROM todo_tag_rules WHERE name = ?")
      .get(normalizedNextName);
    if (duplicate !== undefined) {
      throw new RequestValidationError("Tag rule name already exists");
    }

    const selectTodos = this.database.sqlite.prepare("SELECT * FROM todos");
    const updateTodoTags = this.database.sqlite.prepare(
      "UPDATE todos SET tags_json = ?, updated_at = ? WHERE id = ?"
    );
    const updateRule = this.database.sqlite.prepare(
      "UPDATE todo_tag_rules SET name = ?, updated_at = ? WHERE name = ?"
    );

    const now = Date.now();
    this.database.sqlite.transaction(() => {
      updateRule.run(normalizedNextName, now, normalizedName);
      const rows = selectTodos.all() as TodoRow[];
      for (const row of rows) {
        const tags = parseTagsJson(row.tags_json);
        if (!tags.includes(normalizedName)) {
          continue;
        }
        const nextTags = normalizeTags(
          tags.map((tag) => (tag === normalizedName ? normalizedNextName : tag))
        );
        updateTodoTags.run(JSON.stringify(nextTags), now, row.id);
      }
    })();

    const rule = this.database.sqlite
      .prepare("SELECT * FROM todo_tag_rules WHERE name = ?")
      .get(normalizedNextName) as TodoTagRuleRow;
    this.events.publish({
      type: "todo.updated",
      payload: {
        action: "tag-rule-renamed",
        previousName: normalizedName,
        rule: toTodoTagRuleDto(rule)
      }
    });
    return toTodoTagRuleDto(rule);
  }
}

function toTodoItemDto(row: TodoRow): TodoItemDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: parseTagsJson(row.tags_json),
    sortIndex: row.sort_index,
    dueAt: row.due_at,
    deadlineMode: row.deadline_mode,
    relativeDurationMinutes: row.relative_duration_minutes,
    done: row.done === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTodoTagRuleDto(row: TodoTagRuleRow): TodoTagRuleDto {
  return {
    name: row.name,
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseTagsJson(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeTags(parsed.filter((value): value is string => typeof value === "string"));
    }
  } catch {
    return [];
  }
  return [];
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTagName(tag);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeTagName(tag: string): string {
  return tag.trim().replace(/\s+/g, " ");
}
