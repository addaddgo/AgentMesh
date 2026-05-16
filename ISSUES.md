# Issues

## Approval Accepted But Turn Stalls Until Timeout

- Workspace/thread: `MutatorScheduler / main / main agent`
- Symptom:
  - Codex emits one or more `item/commandExecution/requestApproval` requests.
  - User approves them in the UI.
  - After approval, no further assistant output arrives in Symphony.
  - Roughly 20 minutes later, the originating user turn fails with `Codex turn did not complete within 1200000ms`.
- Confirmed facts:
  - The backend does send approval responses back to `codex app-server`; the related `approvals` rows are persisted as `approved`.
  - Before the approval requests, the same turn is actively streaming `agentMessage` deltas.
  - After the approval requests, no later `turn/completed`, `item/completed`, or additional assistant message events are observed for that turn.
- Current interpretation:
  - This does not look like Symphony rejecting the approval response.
  - It looks like the Codex turn stops making progress after approval is accepted, and Symphony eventually marks it failed via the existing 20-minute turn timeout.
