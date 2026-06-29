<template>
  <section class="role-permission-page settings-page" data-testid="numbering-rule-settings-page">
    <header class="role-permission-head">
      <div>
        <h2>单据编号规则</h2>
        <p>所有单据在这里总览。未单独编辑时使用系统默认规则；变更规则必须先点开单个单据，避免误改整表。</p>
      </div>
      <div class="role-permission-head__actions">
        <button type="button" data-testid="numbering-refresh" @click="loadRules">刷新</button>
      </div>
    </header>
    <div class="settings-table">
      <table>
        <thead>
          <tr>
            <th>单据名称</th>
            <th>系统类型</th>
            <th>前缀</th>
            <th>流水位数</th>
            <th>当前流水</th>
            <th>启用</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in rules" :key="rule.documentType" :class="{ active: selectedRule?.documentType === rule.documentType }">
            <td>{{ rule.label }}</td>
            <td><code>{{ rule.typeCode || rule.documentType }}</code></td>
            <td>{{ rule.prefix }}</td>
            <td>{{ rule.width }}</td>
            <td>{{ rule.lastNumber }}</td>
            <td>
              <label class="settings-check compact">
                <input :checked="rule.enabled" disabled type="checkbox" :data-testid="`numbering-enabled-${rule.documentType}`" />
              </label>
            </td>
            <td>{{ rule.updatedAt }}</td>
            <td>
              <button type="button" :disabled="!canManage" :data-testid="`numbering-edit-${rule.documentType}`" @click="selectRule(rule)">编辑规则</button>
            </td>
          </tr>
          <tr v-if="!rules.length">
            <td colspan="8" class="empty-row">{{ message || "暂无编号规则。" }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section v-if="selectedRule && draftRule" class="settings-card numbering-editor" data-testid="numbering-rule-editor">
      <div class="settings-card__head">
        <div>
          <h3>{{ selectedRule.label }}</h3>
          <p>系统类型：<code>{{ selectedRule.typeCode || selectedRule.documentType }}</code></p>
        </div>
        <button type="button" data-testid="numbering-close-editor" @click="closeEditor">关闭</button>
      </div>
      <div class="settings-form-grid">
        <label>
          编号前缀
          <input v-model.trim="draftRule.prefix" :disabled="!canManage" data-testid="numbering-edit-prefix" />
        </label>
        <label>
          流水位数
          <input v-model.number="draftRule.width" :disabled="!canManage" type="number" min="3" max="12" data-testid="numbering-edit-width" />
        </label>
        <label>
          当前流水
          <input v-model.number="draftRule.lastNumber" :disabled="!canManage" type="number" min="0" data-testid="numbering-edit-last" />
        </label>
        <label class="settings-check">
          <input v-model="draftRule.enabled" :disabled="!canManage" type="checkbox" data-testid="numbering-edit-enabled" />
          启用该规则
        </label>
      </div>
      <p class="settings-hint">修改当前流水会影响下一张新单据编号；已生成的历史单据编号不会被改写。</p>
      <div class="settings-actions">
        <button type="button" :disabled="!canManage" data-testid="numbering-save-selected" @click="saveSelectedRule">保存该单据规则</button>
      </div>
    </section>
    <p v-if="message" class="form-message settings-message" data-testid="numbering-message">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchNumberingRules, saveNumberingRule, type NumberingRule } from "../../../services/numberingApi";

const props = defineProps<{
  canManage: boolean;
}>();

const rules = ref<NumberingRule[]>([]);
const selectedRule = ref<NumberingRule | null>(null);
const draftRule = ref<NumberingRule | null>(null);
const message = ref("");

onMounted(() => {
  void loadRules();
});

async function loadRules() {
  const result = await fetchNumberingRules();
  rules.value = result.rules;
  message.value = result.message;
  if (selectedRule.value) {
    const refreshed = rules.value.find((rule) => rule.documentType === selectedRule.value?.documentType);
    if (refreshed) {
      selectRule(refreshed, false);
    }
  }
}

function selectRule(rule: NumberingRule, clearMessage = true) {
  selectedRule.value = { ...rule };
  draftRule.value = { ...rule };
  if (clearMessage) {
    message.value = "";
  }
}

function closeEditor() {
  selectedRule.value = null;
  draftRule.value = null;
}

async function saveSelectedRule() {
  if (!draftRule.value || !props.canManage) {
    return;
  }
  const result = await saveNumberingRule(draftRule.value);
  if (result.ok) {
    rules.value = result.rules;
    const refreshed = result.rules.find((rule) => rule.documentType === draftRule.value?.documentType);
    if (refreshed) {
      selectRule(refreshed, false);
    }
  }
  message.value = result.message;
}
</script>
