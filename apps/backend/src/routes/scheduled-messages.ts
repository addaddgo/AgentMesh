import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  ScheduledMessageAcknowledgeResponse,
  ScheduledMessageDeleteResponse,
  ScheduledMessageItemResponse,
  ScheduledMessageListResponse,
  ScheduledMessageUpdateRequest
} from "@agentmesh/shared";

import { validateBody, validateParams } from "../validation.js";

const scheduledMessageParamsSchema = z.object({
  id: z.string().min(1)
});

const updateScheduledMessageSchema = z
  .object({
    appServerId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    delaySeconds: z.coerce.number().int().min(0).optional()
  })
  .strict();

export async function registerScheduledMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/scheduled-messages", async (): Promise<ScheduledMessageListResponse> => {
    return { items: app.scheduledMessageService.list() };
  });

  app.patch(
    "/api/scheduled-messages/:id",
    {
      preHandler: [
        validateParams(scheduledMessageParamsSchema),
        validateBody(updateScheduledMessageSchema)
      ]
    },
    async (request): Promise<ScheduledMessageItemResponse> => {
      const { id } = request.params as z.infer<typeof scheduledMessageParamsSchema>;
      const body = request.body as ScheduledMessageUpdateRequest;
      return { item: app.scheduledMessageService.update(id, body) };
    }
  );

  app.post(
    "/api/scheduled-messages/:id/acknowledge",
    { preHandler: validateParams(scheduledMessageParamsSchema) },
    async (request): Promise<ScheduledMessageAcknowledgeResponse> => {
      const { id } = request.params as z.infer<typeof scheduledMessageParamsSchema>;
      return { item: app.scheduledMessageService.acknowledge(id) };
    }
  );

  app.delete(
    "/api/scheduled-messages/:id",
    { preHandler: validateParams(scheduledMessageParamsSchema) },
    async (request): Promise<ScheduledMessageDeleteResponse> => {
      const { id } = request.params as z.infer<typeof scheduledMessageParamsSchema>;
      app.scheduledMessageService.delete(id);
      return { success: true };
    }
  );
}
