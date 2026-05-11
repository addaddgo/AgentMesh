import type { FastifyInstance } from "fastify";

import { formatSseComment, formatSseEvent } from "../services/events.js";

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(formatSseComment("connected"));

    const unsubscribe = app.events.subscribe((event) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        unsubscribe();
        return;
      }

      reply.raw.write(formatSseEvent(event));
    });

    request.raw.on("close", unsubscribe);
  });
}
