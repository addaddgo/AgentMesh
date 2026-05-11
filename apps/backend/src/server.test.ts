import { describe, expect, it } from "vitest";

import { createTestBackend } from "./test-helpers.js";

describe("backend server", () => {
  it("serves health through Fastify", async () => {
    const backend = await createTestBackend();

    try {
      const response = await backend.app.inject({
        method: "GET",
        url: "/health"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        implementation: "AgentMesh",
        namespace: "@agentmesh"
      });
    } finally {
      await backend.cleanup();
    }
  });

  it("initializes a temporary SQLite database on startup", async () => {
    const backend = await createTestBackend();

    try {
      const row = backend.app.database.sqlite
        .prepare("SELECT id FROM __agentmesh_migrations WHERE id = ?")
        .get("0000_backend_foundation");

      expect(row).toEqual({ id: "0000_backend_foundation" });
    } finally {
      await backend.cleanup();
    }
  });

  it("returns the shared API error format for missing routes", async () => {
    const backend = await createTestBackend();

    try {
      const response = await backend.app.inject({
        method: "GET",
        url: "/missing"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: "not_found",
          message: "Route not found"
        }
      });
    } finally {
      await backend.cleanup();
    }
  });
});
