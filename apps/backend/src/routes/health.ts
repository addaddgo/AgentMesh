import type { FastifyInstance } from "fastify";

import { IMPLEMENTATION_NAME, PACKAGE_NAMESPACE } from "@agentmesh/shared";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    implementation: IMPLEMENTATION_NAME,
    namespace: PACKAGE_NAMESPACE
  }));
}
