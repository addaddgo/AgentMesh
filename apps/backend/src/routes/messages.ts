import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SendMessageResponse } from "@agentmesh/shared";
import { validateBody } from "../validation.js";

const sendMessageSchema = z.object({
  threadId: z.string().min(1),
  text: z.string().default(""),
  attachmentIds: z.array(z.string().min(1)).max(5).default([])
});

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/messages/send",
    { preHandler: validateBody(sendMessageSchema) },
    async (request, reply): Promise<SendMessageResponse> => {
      const { threadId, text, attachmentIds } = request.body as z.infer<typeof sendMessageSchema>;
      const response = app.messageSendService.sendText(threadId, text, attachmentIds);
      reply.code(202);
      return response;
    }
  );
}
