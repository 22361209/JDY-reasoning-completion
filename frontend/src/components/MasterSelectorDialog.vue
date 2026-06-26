<template>
  <div v-if="open" class="modal-mask" data-testid="master-selector-dialog">
    <div class="dialog master-selector-dialog">
      <h3>{{ title }}</h3>
      <div class="master-selector-dialog__toolbar">
        <label>
          搜索
          <input
            v-model="draftKeyword"
            data-testid="master-selector-search"
            :placeholder="`${label}编码、名称`"
            @keydown.enter.prevent="emit('search', draftKeyword)"
          />
        </label>
        <button type="button" data-testid="master-selector-search-button" @click="emit('search', draftKeyword)">搜索</button>
        <button type="button" data-testid="master-selector-new" disabled>新增</button>
      </div>
      <div class="master-selector-dialog__body">
        <aside class="master-selector-dialog__tree">
          <strong>全部{{ label }}</strong>
          <span>启用资料</span>
          <span>最近使用</span>
        </aside>
        <div class="master-selector-dialog__table">
          <table>
            <thead>
              <tr>
                <th class="selector-pick-col">选择</th>
                <th>{{ label }}编码</th>
                <th>{{ label }}名称</th>
                <th>规格</th>
                <th>单位</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading">
                <td colspan="5">加载中...</td>
              </tr>
              <tr v-else-if="rows.length === 0">
                <td colspan="5">暂无可选资料</td>
              </tr>
              <template v-else>
                <tr
                  v-for="row in rows"
                  :key="row.code"
                  tabindex="0"
                  :data-testid="`master-selector-row-${row.code}`"
                  @click="emit('select', row)"
                  @keydown.enter.prevent="emit('select', row)"
                >
                  <td><span class="selector-row-radio" /></td>
                  <td><strong>{{ row.code }}</strong></td>
                  <td>{{ row.name }}</td>
                  <td>{{ row.spec || "-" }}</td>
                  <td>{{ row.unit || "-" }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
      <div class="master-selector-dialog__summary">
        <span data-testid="master-selector-total">共 {{ total }} 条</span>
        <span>点击行即回填当前字段</span>
      </div>
      <p v-if="message" class="form-error" data-testid="master-selector-message">{{ message }}</p>
      <div class="dialog-actions">
        <button type="button" data-testid="master-selector-cancel" @click="emit('close')">取消</button>
        <button class="primary-action" type="button" data-testid="master-selector-confirm" @click="emit('close')">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { MasterOption } from "./EntryTable.vue";

const props = defineProps<{
  open: boolean;
  title: string;
  label: string;
  keyword: string;
  rows: MasterOption[];
  total: number;
  loading: boolean;
  message: string;
}>();

const emit = defineEmits<{
  close: [];
  search: [keyword: string];
  select: [option: MasterOption];
}>();

const draftKeyword = ref(props.keyword);

watch(() => props.keyword, (value) => {
  draftKeyword.value = value;
});

watch(() => props.open, (open) => {
  if (open) {
    draftKeyword.value = props.keyword;
  }
});
</script>
