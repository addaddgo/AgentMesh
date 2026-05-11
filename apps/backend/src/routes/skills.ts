import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  SkillListResponse,
  SkillSyncResponse,
  TargetSkillDeleteResponse,
  TargetSkillListResponse
} from "@agentmesh/shared";

import { SkillService } from "../services/skills.js";
import { validateBody } from "../validation.js";

const appServerParamsSchema = z.object({
  appServerId: z.string().min(1)
});

const targetSkillParamsSchema = z.object({
  appServerId: z.string().min(1),
  skillName: z.string().min(1)
});

const skillSyncSchema = z
  .object({
    skillNames: z.array(z.string().min(1)).min(1),
    appServerIds: z.array(z.string().min(1)).min(1)
  })
  .strict();

export async function registerSkillRoutes(app: FastifyInstance): Promise<void> {
  const service = new SkillService(app.database, app.config, app.events);

  app.get(
    "/api/skills",
    async (): Promise<SkillListResponse> => ({
      skills: service.list()
    })
  );

  app.post(
    "/api/skills/sync",
    { preHandler: validateBody(skillSyncSchema) },
    async (request): Promise<SkillSyncResponse> => {
      const results = service.sync(request.body as z.infer<typeof skillSyncSchema>);
      return { results };
    }
  );

  app.get(
    "/api/app-servers/:appServerId/target-skills",
    async (request): Promise<TargetSkillListResponse> => {
      const { appServerId } = appServerParamsSchema.parse(request.params);
      return { skills: service.listTargetSkills(appServerId) };
    }
  );

  app.delete(
    "/api/app-servers/:appServerId/target-skills/:skillName",
    async (request): Promise<TargetSkillDeleteResponse> => {
      const { appServerId, skillName } = targetSkillParamsSchema.parse(request.params);
      service.deleteTargetSkill(appServerId, skillName);
      return { deleted: true };
    }
  );
}
