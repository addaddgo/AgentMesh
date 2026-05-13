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
        dueAt: 1_777_777_777_000
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      item: {
        name: "Ship observation stack",
        description: "Need a reusable harness layer",
        category: "planning",
        dueAt: 1_777_777_777_000,
        done: false
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
});
