import type { FastifyInstance } from "fastify";

import type { WorkspaceUsageResponse } from "@agentmesh/shared";

import { WorkspaceUsageStatsService } from "../services/workspace-usage-stats.js";

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  const service = new WorkspaceUsageStatsService(app.database);

  app.get(
    "/api/stats/workspace-usage",
    async (): Promise<WorkspaceUsageResponse> => ({
      workspaces: service.computeByWorkspace()
    })
  );
}
