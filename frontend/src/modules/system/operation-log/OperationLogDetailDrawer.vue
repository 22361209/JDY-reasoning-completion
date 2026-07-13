<template>
  <div v-if="open" class="operation-log-detail-mask" data-testid="operation-log-detail-drawer" @click.self="$emit('close')">
    <aside class="operation-log-detail-drawer" role="dialog" aria-modal="true" aria-label="操作日志详情">
      <header>
        <div>
          <span class="eyebrow">操作日志详情</span>
          <h3>{{ detail?.module || "-" }} / {{ detail?.action || "-" }}</h3>
        </div>
        <button type="button" data-testid="operation-log-detail-close" @click="$emit('close')">关闭</button>
      </header>

      <p v-if="loading" class="detail-message">正在加载日志详情…</p>
      <p v-else-if="message" class="detail-message error">{{ message }}</p>
      <template v-else-if="detail">
        <dl class="detail-grid">
          <div><dt>日志 ID</dt><dd>{{ detail.id }}</dd></div>
          <div><dt>操作时间</dt><dd>{{ detail.operatedAt }}</dd></div>
          <div data-testid="operation-log-detail-actor"><dt>操作主体</dt><dd>{{ detail.operator }} · {{ actorTypeLabel }}</dd></div>
          <div data-testid="operation-log-detail-actor-username"><dt>操作人账号</dt><dd>{{ detail.actorUsername || "-" }}</dd></div>
          <div data-testid="operation-log-detail-actor-display-name"><dt>操作时姓名</dt><dd>{{ detail.actorDisplayName || "-" }}</dd></div>
          <div data-testid="operation-log-detail-account-set"><dt>账套</dt><dd>{{ accountSetLabel }}</dd></div>
          <div data-testid="operation-log-detail-target"><dt>对象</dt><dd>{{ targetLabel }}</dd></div>
          <div><dt>结果</dt><dd :class="detail.success ? 'success' : 'failure'">{{ detail.status }}</dd></div>
          <div class="wide" data-testid="operation-log-detail-reason"><dt>失败原因</dt><dd>{{ detail.reason || "-" }}</dd></div>
        </dl>
        <section class="state-section" data-testid="operation-log-detail-before-state">
          <h4>操作前状态</h4>
          <pre>{{ stateText(detail.beforeState) }}</pre>
        </section>
        <section class="state-section" data-testid="operation-log-detail-after-state">
          <h4>操作后状态</h4>
          <pre>{{ stateText(detail.afterState) }}</pre>
        </section>
      </template>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { OperationLogDetail } from "../../../services/listApi";

const props = defineProps<{
  open: boolean;
  loading: boolean;
  message: string;
  scope: "current" | "platform" | "historical";
  detail: OperationLogDetail | null;
}>();

defineEmits<{ close: [] }>();

const accountSetLabel = computed(() => {
  if (props.scope === "historical" && !props.detail?.accountSetCode && !props.detail?.accountSetName) {
    return "历史未归属";
  }
  const name = props.detail?.accountSetName || "";
  const code = props.detail?.accountSetCode || "";
  if (name && code) {
    return `${name}（${code}）`;
  }
  return name || code || "-";
});

const targetLabel = computed(() => {
  if (!props.detail) {
    return "-";
  }
  return [props.detail.targetType, props.detail.targetNo || props.detail.targetId].filter(Boolean).join(" / ") || "-";
});

const actorTypeLabel = computed(() => ({
  USER: "用户",
  SYSTEM: "系统任务",
  ANONYMOUS: "未认证请求",
  HISTORICAL_UNKNOWN: "历史未知"
} as Record<string, string>)[props.detail?.actorType ?? ""] ?? props.detail?.actorType ?? "-");

function stateText(state: Record<string, unknown> | null) {
  return state ? JSON.stringify(state, null, 2) : "无状态快照";
}
</script>

<style scoped>
.operation-log-detail-mask { position: fixed; inset: 0; z-index: 1200; display: flex; justify-content: flex-end; background: rgba(15, 23, 42, .28); }
.operation-log-detail-drawer { width: min(620px, 92vw); height: 100%; overflow: auto; padding: 28px; background: #fff; box-shadow: -18px 0 48px rgba(15, 23, 42, .18); }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
h3, h4 { margin: 4px 0 0; }
.eyebrow, dt { color: #64748b; font-size: 12px; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.detail-grid > div, .state-section { padding: 14px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; }
.detail-grid .wide { grid-column: 1 / -1; }
dd { margin: 5px 0 0; overflow-wrap: anywhere; }
.success { color: #15803d; }
.failure, .error { color: #b91c1c; }
.state-section { margin-top: 14px; }
pre { margin: 10px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.detail-message { padding: 20px 0; }
@media (max-width: 640px) { .detail-grid { grid-template-columns: 1fr; } .detail-grid .wide { grid-column: auto; } }
</style>
