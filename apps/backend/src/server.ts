import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { ZodError } from "zod";

import { ensureConfigDirectories, type BackendConfig } from "./config.js";
import { createDatabase, initializeDatabase, type DatabaseHandle } from "./db/index.js";
import { ApiError, InternalApiError, NotFoundError, RequestValidationError } from "./errors.js";
import { createLoggerOptions } from "./logging.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerAppServerRoutes } from "./routes/app-servers.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerUiRoutes } from "./routes/ui.js";
import { AppServerLifecycleRegistry } from "./services/app-server-lifecycle.js";
import { AppServerService } from "./services/app-servers.js";
import { EventService } from "./services/events.js";

export type ServerOptions = {
  readonly config: BackendConfig;
  readonly database?: DatabaseHandle;
  readonly logger?: NonNullable<FastifyServerOptions["logger"]>;
};

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const logger = options.logger === undefined ? createLoggerOptions() : options.logger;
  const app: FastifyInstance = Fastify({ logger });

  ensureConfigDirectories(options.config);

  const database = options.database ?? createDatabase(options.config);
  initializeDatabase(database);
  new AppServerService(database).markAllOfflineAfterBackendRestart();

  const events = new EventService();
  const appServerLifecycle = new AppServerLifecycleRegistry(database, events);
  app.decorate("config", options.config);
  app.decorate("database", database);
  app.decorate("events", events);
  app.decorate("appServerLifecycle", appServerLifecycle);

  await app.register(fastifyMultipart);

  app.addHook("onClose", async () => {
    await appServerLifecycle.closeAll();
    database.close();
  });

  app.setNotFoundHandler((_request, reply) => {
    const error = new NotFoundError("Route not found");
    reply.code(error.statusCode).send(error.toResponse());
  });

  app.setErrorHandler((error, _request, reply) => {
    const apiError =
      error instanceof ApiError
        ? error
        : error instanceof ZodError
          ? RequestValidationError.fromZod(error)
          : new InternalApiError();

    if (!(error instanceof ApiError) && !(error instanceof ZodError)) {
      app.log.error({ err: error }, "Unhandled backend error");
    }

    reply.code(apiError.statusCode).send(apiError.toResponse());
  });

  await registerHealthRoutes(app);
  await registerEventRoutes(app);
  await registerAppServerRoutes(app);
  await registerThreadRoutes(app);
  await registerMessageRoutes(app);
  await registerMcpRoutes(app);
  await registerUploadRoutes(app);
  await registerApprovalRoutes(app);
  await registerSkillRoutes(app);
  await registerUiRoutes(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: BackendConfig;
    database: DatabaseHandle;
    events: EventService;
    appServerLifecycle: AppServerLifecycleRegistry;
  }
}
