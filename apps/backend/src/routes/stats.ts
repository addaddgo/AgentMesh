import type { FastifyInstance } from "fastify";

import type { AccountUsageResponse, WorkspaceUsageResponse } from "@agentmesh/shared";

import { AccountUsageStatsService } from "../services/account-usage-stats.js";
import { WorkspaceUsageStatsService } from "../services/workspace-usage-stats.js";

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  const service = new WorkspaceUsageStatsService(app.database);
  const accountUsage = new AccountUsageStatsService();

  app.get(
    "/api/stats/workspace-usage",
    async (): Promise<WorkspaceUsageResponse> => ({
      workspaces: service.computeByWorkspace()
    })
  );

  app.get(
    "/api/stats/account-usage",
    async (): Promise<AccountUsageResponse> => ({
      usage: accountUsage.readUsage()
    })
  );
}
