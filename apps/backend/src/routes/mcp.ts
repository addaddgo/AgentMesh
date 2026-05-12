import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { AgentMeshMcpService, createAgentMeshMcpServer } from "../services/mcp.js";

type McpSession = {
  readonly server: ReturnType<typeof createAgentMeshMcpServer>;
  readonly transport: StreamableHTTPServerTransport;
};

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  const sessions = new Map<string, McpSession>();

  app.addHook("onClose", async () => {
    await Promise.all([...sessions.values()].map((session) => session.server.close()));
    sessions.clear();
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      const session = await getOrCreateSession(app, sessions, request);

      if (session === undefined) {
        reply.code(404).send({ error: "mcp_session_not_found" });
        return;
      }

      reply.hijack();
      await session.transport.handleRequest(request.raw, reply.raw, request.body);
    }
  });
}

async function getOrCreateSession(
  app: FastifyInstance,
  sessions: Map<string, McpSession>,
  request: FastifyRequest
): Promise<McpSession | undefined> {
  const sessionId = request.headers["mcp-session-id"];

  if (typeof sessionId === "string") {
    return sessions.get(sessionId);
  }

  if (request.method !== "POST") {
    return undefined;
  }

  const service = new AgentMeshMcpService(
    app.database,
    app.config,
    app.events,
    app.appServerLifecycle,
    app.threadStatusCache
  );
  const server = createAgentMeshMcpServer(service);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: (initializedSessionId) => {
      sessions.set(initializedSessionId, { server, transport });
    },
    onsessionclosed: (closedSessionId) => {
      sessions.delete(closedSessionId);
    }
  });

  transport.onclose = () => {
    if (transport.sessionId !== undefined) {
      sessions.delete(transport.sessionId);
    }
  };
  transport.onerror = (error) => {
    app.log.error({ err: error }, "MCP transport error");
  };

  await server.connect(transport as unknown as Transport);
  return { server, transport };
}
