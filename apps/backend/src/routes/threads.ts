import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  CodexEventListResponse,
  ThreadDetailResponse,
  ThreadImportResponse,
  ThreadMessagesResponse,
  ThreadQueueResponse
} from "@agentmesh/shared";

import { CodexEventService } from "../services/codex-events.js";
import { ThreadImportService } from "../services/thread-import.js";
import { ThreadQueueService } from "../services/thread-queue.js";
import { validateParams, validateQuery } from "../validation.js";

const threadParamsSchema = z.object({
  threadId: z.string().min(1)
});

const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  const service = new ThreadImportService(app.database, app.events);
  const codexEvents = new CodexEventService(app.database);
  const queue = new ThreadQueueService(app.database, app.events);

  app.get(
    "/api/threads/:threadId",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadDetailResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      return { thread: service.getThread(threadId) };
    }
  );

  app.get(
    "/api/threads/:threadId/messages",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadMessagesResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      return { messages: service.listMessages(threadId) };
    }
  );

  app.get(
    "/api/threads/:threadId/queue",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadQueueResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      return { items: queue.listForThread(threadId) };
    }
  );

  app.get(
    "/api/threads/:threadId/codex-events",
    {
      preHandler: [validateParams(threadParamsSchema), validateQuery(eventQuerySchema)]
    },
    async (request): Promise<CodexEventListResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      const { limit } = request.query as z.infer<typeof eventQuerySchema>;
      return { events: codexEvents.listForThread(threadId, { limit }) };
    }
  );

  app.post(
    "/api/threads/:threadId/import",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadImportResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      const thread = service.getThread(threadId);
      const requester =
        thread.importedAt === null
          ? app.appServerLifecycle.getTransport(thread.appServerId)
          : undefined;

      return service.importThread(threadId, requester);
    }
  );
}
