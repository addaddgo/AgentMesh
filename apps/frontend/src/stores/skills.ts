import type { SkillDto, SkillSyncResultDto } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type SkillState = {
  sourceSkills: SkillDto[];
  selectedSkillPaths: string[];
  selectedAppServerIds: string[];
  syncResults: SkillSyncResultDto[];
  loading: boolean;
  syncing: boolean;
};

export const useSkillStore = defineStore("skills", {
  state: (): SkillState => ({
    sourceSkills: [],
    selectedSkillPaths: [],
    selectedAppServerIds: [],
    syncResults: [],
    loading: false,
    syncing: false
  }),

  getters: {
    canSync(state): boolean {
      return (
        state.selectedSkillPaths.length > 0 &&
        state.selectedAppServerIds.length > 0 &&
        !state.syncing
      );
    }
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true;
      try {
        this.sourceSkills = [...(await apiClient.listSkills())];
        const availableSkillPaths = new Set(
          this.sourceSkills.map((skill) => skill.path ?? skill.name)
        );
        this.selectedSkillPaths = this.selectedSkillPaths.filter((skillPath) =>
          availableSkillPaths.has(skillPath)
        );
      } catch (error) {
        notifyError(error, "Failed to load skills");
      } finally {
        this.loading = false;
      }
    },

    setSelectedSkillPaths(paths: readonly string[]): void {
      this.selectedSkillPaths = [...paths];
    },

    setSelectedAppServerIds(ids: readonly string[]): void {
      this.selectedAppServerIds = [...ids];
    },

    toggleSkill(skillPath: string): void {
      this.selectedSkillPaths = toggleValue(this.selectedSkillPaths, skillPath);
    },

    toggleAppServer(id: string): void {
      this.selectedAppServerIds = toggleValue(this.selectedAppServerIds, id);
    },

    async syncSelected(): Promise<void> {
      if (!this.canSync) {
        return;
      }

      this.syncing = true;
      this.syncResults = [];
      try {
        const skillNames = this.sourceSkills
          .filter((skill) => this.selectedSkillPaths.includes(skill.path ?? skill.name))
          .map((skill) => skill.name);
        const response = await apiClient.syncSkills({
          skillNames: [...new Set(skillNames)],
          appServerIds: this.selectedAppServerIds
        });
        this.syncResults = [...response.results];
      } catch (error) {
        notifyError(error, "Failed to sync skills");
      } finally {
        this.syncing = false;
      }
    }
  }
});

function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}
