import type { SplitPaneTree, ThreadDraftDto, UiLayoutDto, UiLayoutKind } from "@agentmesh/shared";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { notifyError } from "./errors";

type UiLayoutState = {
  layouts: UiLayoutDto[];
  draftsByThreadId: Record<string, ThreadDraftDto>;
  focusedAppServerId: string | null;
  focusedThreadIdByAppServerId: Record<string, string | null>;
  sseState: "closed" | "connecting" | "open" | "reconnecting";
};

export const useUiLayoutStore = defineStore("uiLayout", {
  state: (): UiLayoutState => ({
    layouts: [],
    draftsByThreadId: {},
    focusedAppServerId: null,
    focusedThreadIdByAppServerId: {},
    sseState: "closed"
  }),

  actions: {
    async loadPersistedState(): Promise<void> {
      await Promise.all([this.loadLayouts(), this.loadDrafts()]);
    },

    async loadLayouts(): Promise<void> {
      try {
        this.layouts = [...(await apiClient.listUiLayouts()).layouts];
      } catch (error) {
        // Backend UI persistence is allowed to arrive after the frontend scaffold.
        if (!isMissingEndpoint(error)) {
          notifyError(error, "Failed to load UI layouts");
        }
      }
    },

    async saveLayout(
      id: string,
      kind: UiLayoutKind,
      ownerId: string,
      layoutJson: SplitPaneTree | null
    ): Promise<void> {
      try {
        const response = await apiClient.saveUiLayout(id, { kind, ownerId, layoutJson });
        const index = this.layouts.findIndex((layout) => layout.id === response.layout.id);
        if (index === -1) {
          this.layouts.push(response.layout);
        } else {
          this.layouts.splice(index, 1, response.layout);
        }
      } catch (error) {
        if (!isMissingEndpoint(error)) {
          notifyError(error, "Failed to save UI layout");
        }
      }
    },

    async loadDrafts(): Promise<void> {
      try {
        const response = await apiClient.listDrafts();
        this.draftsByThreadId = Object.fromEntries(
          response.drafts.map((draft) => [draft.threadId, draft])
        );
      } catch (error) {
        if (!isMissingEndpoint(error)) {
          notifyError(error, "Failed to load drafts");
        }
      }
    },

    setDraft(appServerId: string, threadId: string, draftMarkdown: string): void {
      this.draftsByThreadId[threadId] = {
        appServerId,
        threadId,
        draftMarkdown,
        updatedAt: Date.now()
      };
    },

    async saveDraft(appServerId: string, threadId: string): Promise<void> {
      const draft = this.draftsByThreadId[threadId];
      if (draft === undefined) {
        return;
      }

      try {
        const response = await apiClient.saveDraft(threadId, {
          appServerId,
          draftMarkdown: draft.draftMarkdown
        });
        this.draftsByThreadId[threadId] = response.draft;
      } catch (error) {
        if (!isMissingEndpoint(error)) {
          notifyError(error, "Failed to save draft");
        }
      }
    },

    focusAppServer(appServerId: string | null): void {
      this.focusedAppServerId = appServerId;
    },

    focusThread(appServerId: string, threadId: string | null): void {
      this.focusedThreadIdByAppServerId[appServerId] = threadId;
    },

    getLayout(kind: UiLayoutKind, ownerId: string): SplitPaneTree | null {
      return (
        this.layouts.find((layout) => layout.kind === kind && layout.ownerId === ownerId)
          ?.layoutJson ?? null
      );
    },

    async persistTree(
      kind: UiLayoutKind,
      ownerId: string,
      tree: SplitPaneTree | null
    ): Promise<void> {
      await this.saveLayout(`${kind}:${ownerId}`, kind, ownerId, tree);
    },

    setSseState(state: UiLayoutState["sseState"]): void {
      this.sseState = state;
    }
  }
});

export function createLeaf(
  id: string,
  payload: { readonly appServerId?: string; readonly threadId?: string }
): SplitPaneTree {
  return {
    type: "leaf",
    id,
    ...payload
  };
}

export function splitLeaf(
  tree: SplitPaneTree | null,
  focusedLeafId: string | null,
  newLeaf: SplitPaneTree,
  direction: "right" | "down" = "right"
): SplitPaneTree {
  if (tree === null) {
    return newLeaf;
  }

  const splitDirection = direction === "right" ? "horizontal" : "vertical";
  const targetId = focusedLeafId ?? firstLeafId(tree);
  return replaceLeaf(tree, targetId, (leaf) => ({
    type: "split",
    id: crypto.randomUUID(),
    direction: splitDirection,
    first: leaf,
    second: newLeaf,
    ratio: 0.5
  }));
}

export function firstLeafId(tree: SplitPaneTree | null): string | null {
  if (tree === null) {
    return null;
  }

  if (tree.type === "leaf") {
    return tree.id;
  }

  return firstLeafId(tree.first) ?? firstLeafId(tree.second);
}

export function leafPayloadIds(
  tree: SplitPaneTree | null,
  key: "appServerId" | "threadId"
): string[] {
  if (tree === null) {
    return [];
  }

  if (tree.type === "leaf") {
    const value = tree[key];
    return value === undefined ? [] : [value];
  }

  return [...leafPayloadIds(tree.first, key), ...leafPayloadIds(tree.second, key)];
}

export function removeLeaf(tree: SplitPaneTree | null, targetId: string): SplitPaneTree | null {
  if (tree === null) {
    return null;
  }

  if (tree.type === "leaf") {
    return tree.id === targetId ? null : tree;
  }

  const first = removeLeaf(tree.first, targetId);
  const second = removeLeaf(tree.second, targetId);

  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }

  return {
    ...tree,
    first,
    second
  };
}

function replaceLeaf(
  tree: SplitPaneTree,
  targetId: string | null,
  replacement: (leaf: SplitPaneTree) => SplitPaneTree
): SplitPaneTree {
  if (tree.type === "leaf") {
    return targetId === null || tree.id === targetId ? replacement(tree) : tree;
  }

  return {
    ...tree,
    first: replaceLeaf(tree.first, targetId, replacement),
    second: replaceLeaf(tree.second, targetId, replacement)
  };
}

function isMissingEndpoint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status === 404
  );
}
