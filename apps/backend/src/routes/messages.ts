import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SendMessageResponse } from "@agentmesh/shared";

import { MessageSendService } from "../services/message-send.js";
import { validateBody } from "../validation.js";

const sendMessageSchema = z.object({
  threadId: z.string().min(1),
  text: z.string().default(""),
  attachmentIds: z.array(z.string().min(1)).max(5).default([])
});

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  const service = new MessageSendService(
    app.database,
    app.config,
    app.events,
    app.appServerLifecycle,
    app.threadStatusCache
  );

  app.post(
    "/api/messages/send",
    { preHandler: validateBody(sendMessageSchema) },
    async (request, reply): Promise<SendMessageResponse> => {
      const { threadId, text, attachmentIds } = request.body as z.infer<typeof sendMessageSchema>;
      const response = service.sendText(threadId, text, attachmentIds);
      reply.code(202);
      return response;
    }
  );
}
