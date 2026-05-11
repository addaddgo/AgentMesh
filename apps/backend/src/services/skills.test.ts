import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SshError } from "../errors.js";
import { createTestBackend, type TestBackend } from "../test-helpers.js";
import { SkillService, type SkillDirectoryCopier } from "./skills.js";

describe("SkillService", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("returns per-skill/per-app-server failure results when remote copy fails", async () => {
    const { app, config } = await setup();
    const events: unknown[] = [];
    const copier: SkillDirectoryCopier = {
      copySkill: () => {
        throw new SshError("Remote copy failed safely");
      }
    };
    const service = new SkillService(app.database, config, app.events, copier);
    app.events.subscribe((event) => {
      events.push(event);
    });
    writeSkill(config.skillsRoot, "alpha", "---\nname: alpha\n---\n# Alpha");
    const appServerId = await createSshAppServer(app);

    const results = service.sync({
      skillNames: ["alpha"],
      appServerIds: [appServerId]
    });

    expect(results).toEqual([
      {
        skillName: "alpha",
        appServerId,
        status: "failed",
        targetPath: "/srv/project/.codex/skills/alpha",
        error: "Remote copy failed safely"
      }
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "skill.sync_completed",
          payload: { results }
        })
      ])
    );
  });
});

async function createSshAppServer(app: TestBackend["app"]): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/app-servers",
    payload: {
      name: "remote",
      hostKind: "ssh",
      host: "remote.example.com",
      sshUser: "codex",
      sshPort: 2222,
      workspace: "/srv/project"
    }
  });

  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

function writeSkill(root: string, directory: string, skillMd: string): void {
  const skillDir = path.join(root, directory);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);
}
