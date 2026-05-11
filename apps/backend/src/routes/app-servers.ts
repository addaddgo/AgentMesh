import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  AppServerListResponse,
  CodexEventListResponse,
  ThreadCreateResponse,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadSyncResponse
} from "@agentmesh/shared";

import { CodexEventService } from "../services/codex-events.js";
import {
  AppServerService,
  type CreateAppServerInput,
  type PatchAppServerInput
} from "../services/app-servers.js";
import { ThreadSyncService } from "../services/thread-sync.js";
import { validateBody, validateParams, validateQuery } from "../validation.js";

const appServerParamsSchema = z.object({
  id: z.string().min(1)
});

const appServerThreadParamsSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1)
});

const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const createThreadSchema = z
  .object({
    name: z.string().trim().min(1).max(120)
  })
  .strict();

const optionalTextSchema = z.string().trim().min(1).optional();

const createAppServerSchema = z
  .object({
    name: optionalTextSchema,
    hostKind: z.enum(["local", "ssh"]),
    host: optionalTextSchema,
    sshUser: optionalTextSchema,
    sshPort: z.number().int().min(1).max(65_535).optional(),
    workspace: z.string().trim().min(1),
    command: optionalTextSchema
  })
  .strict();

const patchAppServerSchema = createAppServerSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "PATCH body must include at least one field"
  });

export async function registerAppServerRoutes(app: FastifyInstance): Promise<void> {
  const service = new AppServerService(app.database);
  const threadSync = new ThreadSyncService(app.database, app.events);
  const codexEvents = new CodexEventService(app.database);

  app.get(
    "/api/app-servers",
    async (): Promise<AppServerListResponse> => ({
      appServers: service.list()
    })
  );

  app.post(
    "/api/app-servers",
    { preHandler: validateBody(createAppServerSchema) },
    async (request, reply) => {
      const appServer = service.create(request.body as CreateAppServerInput);
      reply.code(201);
      return appServer;
    }
  );

  app.patch(
    "/api/app-servers/:id",
    {
      preHandler: [validateParams(appServerParamsSchema), validateBody(patchAppServerSchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return service.update(id, request.body as PatchAppServerInput);
    }
  );

  app.delete(
    "/api/app-servers/:id",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      service.delete(id);
      reply.code(204);
    }
  );

  app.post(
    "/api/app-servers/:id/start",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return app.appServerLifecycle.start(id);
    }
  );

  app.post(
    "/api/app-servers/:id/stop",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return app.appServerLifecycle.stop(id);
    }
  );

  app.post(
    "/api/app-servers/:id/restart",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return app.appServerLifecycle.restart(id);
    }
  );

  app.get(
    "/api/app-servers/:id/threads",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request): Promise<ThreadListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return { threads: threadSync.listCurrent(id) };
    }
  );

  app.post(
    "/api/app-servers/:id/threads",
    { preHandler: [validateParams(appServerParamsSchema), validateBody(createThreadSchema)] },
    async (request): Promise<ThreadCreateResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { name } = request.body as z.infer<typeof createThreadSchema>;
      return {
        thread: await threadSync.createThread(id, app.appServerLifecycle.getTransport(id), name)
      };
    }
  );

  app.post(
    "/api/app-servers/:id/threads/:threadId/resume",
    { preHandler: validateParams(appServerThreadParamsSchema) },
    async (request): Promise<ThreadResumeResponse> => {
      const { id, threadId } = request.params as z.infer<typeof appServerThreadParamsSchema>;
      service.get(id);
      return {
        thread: await threadSync.resumeThread(id, app.appServerLifecycle.getTransport(id), threadId)
      };
    }
  );

  app.get(
    "/api/app-servers/:id/codex-events",
    {
      preHandler: [validateParams(appServerParamsSchema), validateQuery(eventQuerySchema)]
    },
    async (request): Promise<CodexEventListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { limit } = request.query as z.infer<typeof eventQuerySchema>;
      return { events: codexEvents.listForAppServer(id, { limit }) };
    }
  );

  app.post(
    "/api/app-servers/:id/threads/sync",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request): Promise<ThreadSyncResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      service.get(id);
      const result = await threadSync.sync(id, app.appServerLifecycle.getTransport(id));
      return result;
    }
  );
}
