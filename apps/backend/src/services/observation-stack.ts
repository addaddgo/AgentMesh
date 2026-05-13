export function normalizeObservationSkillNames(
  value: readonly string[] | undefined
): readonly string[] {
  if (value === undefined) {
    return [];
  }

  return [...new Set(value.map((item) => item.trim()).filter((item) => item.length > 0))];
}

export function buildResolvedObservationPrompt(
  observationPrompt: string | null,
  activeObservationSkillNames: readonly string[]
): string {
  if (observationPrompt !== null && observationPrompt.trim().length > 0) {
    return withObservationSkillList(observationPrompt.trim(), activeObservationSkillNames);
  }

  return buildDefaultObservationPrompt(activeObservationSkillNames);
}

function buildDefaultObservationPrompt(activeObservationSkillNames: readonly string[]): string {
  return [
    "This workspace has an active observation stack.",
    "Treat the listed observation skills as the default harness observation infrastructure for this workspace.",
    "Before doing ad hoc inspection, use these observation skills first unless they are clearly insufficient for the task.",
    "Use gradual disclosure: start with the cheapest relevant observation capability, deepen only when needed, and ground decisions in observations from this stack.",
    `Active observation skills: ${activeObservationSkillNames.map((name) => `$${name}`).join(", ")}.`
  ].join("\n\n");
}

function withObservationSkillList(
  prompt: string,
  activeObservationSkillNames: readonly string[]
): string {
  if (activeObservationSkillNames.length === 0) {
    return prompt;
  }

  return [
    prompt,
    `Active observation skills: ${activeObservationSkillNames.map((name) => `$${name}`).join(", ")}.`
  ].join("\n\n");
}
