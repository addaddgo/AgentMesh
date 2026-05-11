import type { FastifyServerOptions } from "fastify";

export function createLoggerOptions(): NonNullable<FastifyServerOptions["logger"]> {
  return {
    level: process.env.AGENTMESH_LOG_LEVEL ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.sshPassword",
      "req.body.privateKey",
      "req.body.passphrase",
      "err.env",
      "err.config.env",
      "*.password",
      "*.token",
      "*.secret",
      "*.privateKey",
      "*.passphrase"
    ]
  };
}
