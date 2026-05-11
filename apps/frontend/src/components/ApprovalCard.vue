<template>
  <article class="approval-card" :class="`approval-card-${approval.status}`">
    <header class="approval-card-header">
      <div>
        <p class="eyebrow">Approval Request</p>
        <h3>{{ approval.kind }}</h3>
        <p class="approval-card-state">{{ approvalStateText(approval) }}</p>
      </div>
      <el-tag :type="approvalStatusType(approval.status)">{{ approval.status }}</el-tag>
    </header>

    <dl class="approval-detail-grid">
      <template
        v-for="detail in approvalDetails(approval)"
        :key="`${detail.label}:${detail.value}`"
      >
        <dt>{{ detail.label }}</dt>
        <dd>{{ detail.value }}</dd>
      </template>
    </dl>

    <details class="approval-raw-details">
      <summary>Raw request payload</summary>
      <pre>{{ formatApprovalJson(approvalPayload(approval)) }}</pre>
    </details>

    <p v-if="approval.error !== null" class="approval-error">{{ approval.error }}</p>

    <div class="actions">
      <el-button
        type="success"
        :disabled="actionsDisabled"
        :loading="responding"
        @click="$emit('respond', approval.id, 'approve')"
      >
        Approve
      </el-button>
      <el-button
        type="danger"
        :disabled="actionsDisabled"
        :loading="responding"
        @click="$emit('respond', approval.id, 'deny')"
      >
        Deny
      </el-button>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { ApprovalDecision, ApprovalDto } from "@agentmesh/shared";
import { computed } from "vue";

import {
  approvalDetails,
  approvalPayload,
  approvalStateText,
  approvalStatusType,
  formatApprovalJson
} from "../utils/approvals";

const props = defineProps<{
  readonly approval: ApprovalDto;
  readonly responding?: boolean;
}>();

defineEmits<{
  respond: [id: string, decision: ApprovalDecision];
}>();

const actionsDisabled = computed(
  () => props.approval.status !== "pending" || props.responding === true
);
</script>
