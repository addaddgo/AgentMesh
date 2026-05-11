import type { SkillDto, SkillSyncResultDto } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type SkillState = {
  skills: SkillDto[];
  selectedSkillNames: string[];
  selectedAppServerIds: string[];
  syncResults: SkillSyncResultDto[];
  loading: boolean;
  syncing: boolean;
};

export const useSkillStore = defineStore("skills", {
  state: (): SkillState => ({
    skills: [],
    selectedSkillNames: [],
    selectedAppServerIds: [],
    syncResults: [],
    loading: false,
    syncing: false
  }),

  getters: {
    canSync(state): boolean {
      return (
        state.selectedSkillNames.length > 0 &&
        state.selectedAppServerIds.length > 0 &&
        !state.syncing
      );
    }
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true;
      try {
        this.skills = [...(await apiClient.listSkills())];
        const availableSkillNames = new Set(this.skills.map((skill) => skill.name));
        this.selectedSkillNames = this.selectedSkillNames.filter((name) =>
          availableSkillNames.has(name)
        );
      } catch (error) {
        notifyError(error, "Failed to load skills");
      } finally {
        this.loading = false;
      }
    },

    setSelectedSkillNames(names: readonly string[]): void {
      this.selectedSkillNames = [...names];
    },

    setSelectedAppServerIds(ids: readonly string[]): void {
      this.selectedAppServerIds = [...ids];
    },

    toggleSkill(name: string): void {
      this.selectedSkillNames = toggleValue(this.selectedSkillNames, name);
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
        const response = await apiClient.syncSkills({
          skillNames: this.selectedSkillNames,
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
