import { afterEach, describe, expect, it } from "vitest";

import { createTestBackend, type TestBackend } from "../test-helpers.js";

describe("todo routes", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("creates todos through POST /api/todos", async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: {
        name: "Ship observation stack",
        description: "Need a reusable harness layer",
        category: "planning",
        tags: ["infra", "important"],
        dueAt: 1_777_777_777_000,
        deadlineMode: "relative",
        relativeDurationMinutes: 150
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      item: {
        name: "Ship observation stack",
        description: "Need a reusable harness layer",
        category: "planning",
        tags: ["infra", "important"],
        dueAt: 1_777_777_777_000,
        deadlineMode: "relative",
        relativeDurationMinutes: 150,
        done: false
      }
    });
  });

  it("updates todo deadline mode and duration", async () => {
    const { app } = await setup();

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: { name: "A" }
    });

    const id = createResponse.json().item.id as string;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/todos/${id}`,
      payload: {
        dueAt: 1_888_888_888_000,
        deadlineMode: "absolute",
        relativeDurationMinutes: null
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      item: {
        id,
        dueAt: 1_888_888_888_000,
        deadlineMode: "absolute",
        relativeDurationMinutes: null
      }
    });
  });

  it("lists distinct todo categories", async () => {
    const { app } = await setup();

    await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: { name: "A", category: "planning" }
    });
    await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: { name: "B", category: "backend" }
    });
    await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: { name: "C", category: "planning" }
    });
    await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: { name: "D", category: null }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/todos/categories"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      categories: ["backend", "planning"]
    });
  });

  it("lists, upserts, and deletes todo tag rules", async () => {
    const { app } = await setup();

    const upsertResponse = await app.inject({
      method: "PUT",
      url: "/api/todos/tag-rules/research",
      payload: { importance: "important" }
    });

    expect(upsertResponse.statusCode).toBe(200);
    expect(upsertResponse.json()).toMatchObject({
      rule: {
        name: "research",
        importance: "important"
      }
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/todos/tag-rules"
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      rules: [{ name: "research", importance: "important" }]
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/todos/tag-rules/research"
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
  });

  it("renames a tag rule and updates existing todo tags", async () => {
    const { app } = await setup();

    await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: {
        name: "Refactor queue",
        tags: ["infra", "backend"]
      }
    });

    await app.inject({
      method: "PUT",
      url: "/api/todos/tag-rules/infra",
      payload: { importance: "important" }
    });

    const renameResponse = await app.inject({
      method: "POST",
      url: "/api/todos/tag-rules/infra/rename",
      payload: { nextName: "infrastructure" }
    });

    expect(renameResponse.statusCode).toBe(200);
    expect(renameResponse.json()).toMatchObject({
      rule: {
        name: "infrastructure",
        importance: "important"
      }
    });

    const listTodosResponse = await app.inject({
      method: "GET",
      url: "/api/todos"
    });

    expect(listTodosResponse.statusCode).toBe(200);
    expect(listTodosResponse.json()).toMatchObject({
      items: [
        {
          name: "Refactor queue",
          tags: ["infrastructure", "backend"]
        }
      ]
    });
  });

  it("rejects renaming a tag rule to an existing name", async () => {
    const { app } = await setup();

    await app.inject({
      method: "PUT",
      url: "/api/todos/tag-rules/infra",
      payload: { importance: "important" }
    });
    await app.inject({
      method: "PUT",
      url: "/api/todos/tag-rules/backend",
      payload: { importance: "optional" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/todos/tag-rules/infra/rename",
      payload: { nextName: "backend" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: "Tag rule name already exists"
      }
    });
  });

  it("accepts optional tag rule importance", async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: "PUT",
      url: "/api/todos/tag-rules/backlog",
      payload: { importance: "optional" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      rule: {
        name: "backlog",
        importance: "optional"
      }
    });
  });
});
