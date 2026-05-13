import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SseEvent, SkillListResponse, SkillSyncResponse } from "@agentmesh/shared";

import { createTestBackend, type TestBackend } from "../test-helpers.js";

describe("skills API", () => {
  let backend: TestBackend | undefined;

  afterEach(async () => {
    await backend?.cleanup();
    backend = undefined;
  });

  async function setup(): Promise<TestBackend> {
    backend = await createTestBackend();
    return backend;
  }

  it("lists nested skill directories with relative paths and parses front matter", async () => {
    const { app, config } = await setup();
    writeSkill(config.skillsRoot, "alpha-dir", {
      skillMd: ["---", "name: alpha", "description: Alpha skill", "---", "# Alpha"].join("\n")
    });
    writeSkill(config.skillsRoot, "beta-dir", { skillMd: "# Beta" });
    fs.mkdirSync(path.join(config.skillsRoot, "not-a-skill"), { recursive: true });
    writeSkill(path.join(config.skillsRoot, "nested-parent"), "nested-child", {
      skillMd: "---\nname: nested\n---\n"
    });

    const response = await app.inject({ method: "GET", url: "/api/skills" });

    expect(response.statusCode).toBe(200);
    expect(response.json<SkillListResponse>()).toEqual({
      skills: [
        { name: "alpha", description: "Alpha skill", path: "alpha-dir" },
        { name: "beta-dir", description: "", path: "beta-dir" },
        { name: "nested", description: "", path: "nested-parent/nested-child" }
      ]
    });
  });

  it("syncs selected skills to selected local app-servers by replacing the target directory", async () => {
    const { app, config, tempDir } = await setup();
    const events: SseEvent[] = [];
    const workspace = path.join(tempDir, "workspace");
    const target = path.join(workspace, ".codex", "skills", "alpha");
    app.events.subscribe((event) => {
      events.push(event);
    });
    writeSkill(config.skillsRoot, "alpha-dir", {
      skillMd: "---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha",
      files: { "nested/file.txt": "fresh copy" }
    });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "stale.txt"), "stale");
    const appServerId = await createLocalAppServer(app, workspace);

    const response = await app.inject({
      method: "POST",
      url: "/api/skills/sync",
      payload: {
        skillNames: ["alpha"],
        appServerIds: [appServerId]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<SkillSyncResponse>()).toEqual({
      results: [
        {
          skillName: "alpha",
          appServerId,
          status: "synced",
          targetPath: target,
          error: null
        }
      ]
    });
    expect(fs.existsSync(path.join(target, "stale.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "nested", "file.txt"), "utf8")).toBe("fresh copy");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "skill.sync_completed",
          payload: response.json<SkillSyncResponse>()
        })
      ])
    );
  });

  it("rejects path-traversal skill names before copying", async () => {
    const { app, tempDir } = await setup();
    const appServerId = await createLocalAppServer(app, path.join(tempDir, "workspace"));

    const response = await app.inject({
      method: "POST",
      url: "/api/skills/sync",
      payload: {
        skillNames: ["../escape"],
        appServerIds: [appServerId]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "validation_error", message: "Skill name is invalid" }
    });
  });

  it("rejects dot-dot skill names from front matter", async () => {
    const { app, config, tempDir } = await setup();
    writeSkill(config.skillsRoot, "escape-dir", {
      skillMd: "---\nname: ..\n---\n# Escape"
    });
    const appServerId = await createLocalAppServer(app, path.join(tempDir, "workspace"));

    const response = await app.inject({
      method: "POST",
      url: "/api/skills/sync",
      payload: {
        skillNames: [".."],
        appServerIds: [appServerId]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "validation_error", message: "Skill name is invalid" }
    });
  });
});

async function createLocalAppServer(app: TestBackend["app"], workspace: string): Promise<string> {
  fs.mkdirSync(workspace, { recursive: true });
  const response = await app.inject({
    method: "POST",
    url: "/api/app-servers",
    payload: {
      hostKind: "local",
      workspace
    }
  });

  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

function writeSkill(
  root: string,
  directory: string,
  options: {
    readonly skillMd: string;
    readonly files?: Record<string, string> | undefined;
  }
): void {
  const skillDir = path.join(root, directory);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), options.skillMd);

  for (const [filePath, content] of Object.entries(options.files ?? {})) {
    const destination = path.join(skillDir, filePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
}
