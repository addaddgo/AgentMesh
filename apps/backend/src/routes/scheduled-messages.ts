import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  ScheduledMessageAcknowledgeResponse,
  ScheduledMessageCancelResponse,
  ScheduledMessageDeleteResponse,
  ScheduledMessageCreateRequest,
  ScheduledMessageItemResponse,
  ScheduledMessageListResponse,
  ScheduledMessageUpdateRequest
} from "@agentmesh/shared";

import { validateBody, validateParams } from "../validation.js";

const scheduledMessageParamsSchema = z.object({
  id: z.string().min(1)
});

const createScheduledMessageSchema = z
  .object({
    appServerId: z.string().min(1),
    threadId: z.string().min(1),
    text: z.string().trim().min(1),
    delaySeconds: z.coerce.number().int().min(0)
  })
  .strict();

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

  app.post(
    "/api/scheduled-messages",
    { preHandler: validateBody(createScheduledMessageSchema) },
    async (request): Promise<ScheduledMessageItemResponse> => {
      const body = request.body as ScheduledMessageCreateRequest;
      return { item: app.scheduledMessageService.create(body) };
    }
  );

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

  app.post(
    "/api/scheduled-messages/:id/cancel",
    { preHandler: validateParams(scheduledMessageParamsSchema) },
    async (request): Promise<ScheduledMessageCancelResponse> => {
      const { id } = request.params as z.infer<typeof scheduledMessageParamsSchema>;
      return { item: app.scheduledMessageService.cancel(id) };
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
