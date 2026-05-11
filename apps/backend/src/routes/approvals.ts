import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  ApprovalListResponse,
  ApprovalRespondResponse,
  ApprovalStatus
} from "@agentmesh/shared";

import { ApprovalService } from "../services/approvals.js";
import { validateBody } from "../validation.js";

const listApprovalsQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  status: z.enum(["pending", "approved", "denied", "expired", "failed"]).optional()
});

const respondApprovalSchema = z.object({
  decision: z.enum(["approve", "deny"])
});

export async function registerApprovalRoutes(app: FastifyInstance): Promise<void> {
  const service = new ApprovalService(app.database, app.events, app.appServerLifecycle);

  app.get("/api/approvals", async (request): Promise<ApprovalListResponse> => {
    const query = listApprovalsQuerySchema.parse(request.query);
    return {
      approvals: service.list({
        threadId: query.threadId,
        status: query.status as ApprovalStatus | undefined
      })
    };
  });

  app.post(
    "/api/approvals/:id/respond",
    { preHandler: validateBody(respondApprovalSchema) },
    async (request): Promise<ApprovalRespondResponse> => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const { decision } = request.body as z.infer<typeof respondApprovalSchema>;
      return {
        approval: service.respond(params.id, decision)
      };
    }
  );
}
