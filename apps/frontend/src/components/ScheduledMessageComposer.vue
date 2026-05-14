<template>
  <div
    ref="editorHost"
    class="markdown-editor scheduled-message-editor"
    :class="{ disabled }"
  />
</template>

<script setup lang="ts">
import type { SkillDto, WorkspaceEntryDto } from "@agentmesh/shared";
import {
  acceptCompletion,
  autocompletion,
  moveCompletionSelection,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from "@codemirror/autocomplete";
import { Compartment, Prec } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { apiClient } from "../api/client";
import { notifyError } from "../stores/errors";

const props = defineProps<{
  readonly modelValue: string;
  readonly appServerId: string | null;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const editorHost = ref<HTMLElement | null>(null);
const editableCompartment = new Compartment();
let editorView: EditorView | null = null;
let applyingExternalValue = false;
let lastLocalValue = props.modelValue;

const skillCompletionCache = new Map<string, readonly SkillDto[]>();

onMounted(() => {
  if (editorHost.value === null) {
    return;
  }

  editorView = new EditorView({
    parent: editorHost.value,
    doc: props.modelValue,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      placeholder(props.placeholder ?? "Message"),
      autocompletion({
        activateOnTyping: true,
        activateOnTypingDelay: 220,
        defaultKeymap: false,
        icons: false,
        maxRenderedOptions: 12,
        override: [completeWorkspaceOrSkill]
      }),
      Prec.high(
        keymap.of([
          {
            key: "ArrowDown",
            run: (view) => moveCompletionSelection(true)(view)
          },
          {
            key: "ArrowUp",
            run: (view) => moveCompletionSelection(false)(view)
          },
          {
            key: "PageDown",
            run: moveCompletionSelection(true, "page")
          },
          {
            key: "PageUp",
            run: moveCompletionSelection(false, "page")
          },
          {
            key: "Enter",
            run: (view) => acceptCompletion(view)
          },
          {
            key: "Tab",
            run: (view) => acceptCompletion(view) || insertTabIndent(view)
          }
        ])
      ),
      editableCompartment.of(EditorView.editable.of(props.disabled !== true)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingExternalValue) {
          return;
        }

        const nextValue = update.state.doc.toString();
        lastLocalValue = nextValue;
        emit("update:modelValue", nextValue);
      })
    ]
  });
});

onBeforeUnmount(() => {
  editorView?.destroy();
});

watch(
  () => props.modelValue,
  (nextValue) => {
    if (nextValue === lastLocalValue) {
      return;
    }
    replaceEditorText(nextValue);
  }
);

watch(
  () => props.disabled === true,
  (disabled) => {
    editorView?.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!disabled))
    });
  }
);

function replaceEditorText(nextValue: string): void {
  lastLocalValue = nextValue;
  if (editorView === null || editorView.state.doc.toString() === nextValue) {
    return;
  }

  applyingExternalValue = true;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: nextValue },
    selection: { anchor: nextValue.length }
  });
  applyingExternalValue = false;
  void nextTick(() => editorView?.focus());
}

function completeWorkspaceOrSkill(
  context: CompletionContext
): CompletionResult | Promise<CompletionResult | null> | null {
  const line = context.state.doc.lineAt(context.pos);
  const beforeCursor = line.text.slice(0, context.pos - line.from);
  const inlineMatch = /(^|\s)([@$][^\s]*)$/u.exec(beforeCursor);
  if (inlineMatch === null) {
    return null;
  }

  const token = inlineMatch[2] ?? "";
  const from = context.pos - token.length;
  if (token.startsWith("@")) {
    return completeWorkspacePath(from, token);
  }

  return completeSkill(from);
}

async function completeWorkspacePath(
  from: number,
  token: string
): Promise<CompletionResult | null> {
  const appServerId = props.appServerId;
  if (appServerId === null) {
    return null;
  }

  const query = token.slice(1).trim();
  const entries =
    query.length === 0 || query.endsWith("/")
      ? await apiClient.listWorkspaceEntries(appServerId, query)
      : rankWorkspaceSearchResults(
          await apiClient.searchWorkspaceFiles(appServerId, query),
          query
        );

  return {
    from,
    options: entries.map(workspaceEntryCompletion),
    validFor: /^@[^\s]*$/u
  };
}

async function completeSkill(from: number): Promise<CompletionResult> {
  const appServerId = props.appServerId;
  const codexSkills =
    appServerId === null ? [] : await cachedCodexSkills(appServerId, { refreshInBackground: true });

  return {
    from,
    options: codexSkills.map(skillCompletion),
    validFor: /^\$[\w-]*$/u
  };
}

async function cachedCodexSkills(
  appServerId: string,
  options: { readonly refreshInBackground?: boolean } = {}
): Promise<readonly SkillDto[]> {
  const cached = skillCompletionCache.get(appServerId);
  if (cached !== undefined) {
    if (options.refreshInBackground === true) {
      void apiClient
        .listCodexSkills(appServerId)
        .then((skills) => {
          skillCompletionCache.set(appServerId, skills);
        })
        .catch((error: unknown) => {
          notifyError(error, "Failed to refresh Codex skills");
        });
    }
    return cached;
  }

  const skills = await apiClient.listCodexSkills(appServerId);
  skillCompletionCache.set(appServerId, skills);
  return skills;
}

function workspaceEntryCompletion(entry: WorkspaceEntryDto): Completion {
  return {
    label: `@${entry.path}`,
    type: entry.kind === "directory" ? "folder" : "file",
    detail: entry.kind,
    apply: `@${entry.path}${entry.kind === "directory" ? "" : " "}`
  };
}

function skillCompletion(skill: SkillDto): Completion {
  return {
    label: `$${skill.name}`,
    type: "variable",
    detail: compactCompletionDetail(skill.description),
    apply: `$${skill.name} `
  };
}

function compactCompletionDetail(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function insertTabIndent(view: EditorView): boolean {
  view.dispatch(view.state.replaceSelection("  "));
  return true;
}

function rankWorkspaceSearchResults(
  entries: readonly WorkspaceEntryDto[],
  query: string
): readonly WorkspaceEntryDto[] {
  const normalizedQuery = query.trim().toLowerCase();
  const compactQuery = compactSearchToken(normalizedQuery);

  return [...entries]
    .filter((entry) => entry.kind === "file")
    .sort((left, right) => {
      const scoreDifference =
        workspaceSearchScore(right, normalizedQuery, compactQuery) -
        workspaceSearchScore(left, normalizedQuery, compactQuery);
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return left.path.localeCompare(right.path);
    });
}

function workspaceSearchScore(
  entry: WorkspaceEntryDto,
  normalizedQuery: string,
  compactQuery: string
): number {
  const name = entry.name.toLowerCase();
  const fullPath = entry.path.toLowerCase();
  const compactName = compactSearchToken(name);
  const compactPath = compactSearchToken(fullPath);
  let score = 0;

  if (name === normalizedQuery) {
    score += 2000;
  } else if (name.startsWith(normalizedQuery)) {
    score += 1400;
  } else if (name.includes(normalizedQuery)) {
    score += 1000;
  }

  if (fullPath.startsWith(normalizedQuery)) {
    score += 520;
  } else if (fullPath.includes(normalizedQuery)) {
    score += 360;
  }

  if (compactQuery.length > 0) {
    if (compactName.startsWith(compactQuery)) {
      score += 760;
    } else if (fuzzyIncludes(compactName, compactQuery)) {
      score += 520;
    }

    if (compactPath.startsWith(compactQuery)) {
      score += 260;
    } else if (fuzzyIncludes(compactPath, compactQuery)) {
      score += 180;
    }
  }

  return score - entry.path.length;
}

function compactSearchToken(value: string): string {
  return value.replace(/[\s/._-]+/gu, "");
}

function fuzzyIncludes(candidate: string, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  let index = 0;
  for (const char of candidate) {
    if (char === query[index]) {
      index += 1;
      if (index === query.length) {
        return true;
      }
    }
  }

  return false;
}
</script>

<style scoped>
.scheduled-message-editor {
  min-height: 92px;
  border-radius: 0.9rem;
}
</style>
