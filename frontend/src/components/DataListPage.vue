<template>
  <div class="data-list-page" :data-testid="`list-page-${listKey}`">
    <div class="business-head list-head">
      <div>
        <h2>{{ definition.title }}</h2>
        <p>{{ definition.subtitle }}</p>
      </div>
      <div class="status-stamp">列表</div>
    </div>

    <section class="list-filter" :class="{ expanded: filtersExpanded }">
      <label>
        关键字
        <input
          v-model="query.keyword"
          :placeholder="definition.keywordPlaceholder"
          data-testid="list-keyword"
          @keydown.enter="reload"
        />
      </label>
      <label>
        状态
        <select v-model="query.status" data-testid="list-status">
          <option value="">全部</option>
          <option v-for="status in definition.statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <label v-if="filtersExpanded && isOperationLogList">
        模块
        <select v-model="query.module" data-testid="operation-log-module">
          <option value="">全部</option>
          <option v-for="module in operationLogModules" :key="module" :value="module">{{ module }}</option>
        </select>
      </label>
      <label v-if="filtersExpanded && isOperationLogList">
        动作
        <select v-model="query.action" data-testid="operation-log-action">
          <option value="">全部</option>
          <option v-for="action in operationLogActions" :key="action" :value="action">{{ action }}</option>
        </select>
      </label>
      <label v-if="filtersExpanded && isOperationLogList">
        操作人
        <input
          v-model="query.operator"
          data-testid="operation-log-operator"
          placeholder="操作人"
          @keydown.enter="reload"
        />
      </label>
      <label v-if="filtersExpanded && isOperationLogList">
        对象类型
        <select v-model="query.targetType" data-testid="operation-log-target-type">
          <option value="">全部</option>
          <option v-for="targetType in operationLogTargetTypes" :key="targetType" :value="targetType">{{ targetType }}</option>
        </select>
      </label>
      <label v-if="filtersExpanded && isOperationLogList">
        开始日期
        <input v-model="query.dateFrom" type="date" data-testid="operation-log-date-from" />
      </label>
      <label v-if="filtersExpanded && isOperationLogList">
        结束日期
        <input v-model="query.dateTo" type="date" data-testid="operation-log-date-to" />
      </label>
      <div v-if="filtersExpanded && isOperationLogList" class="filter-preset-row">
        <label>
          预设名称
          <input
            v-model="presetName"
            data-testid="operation-log-preset-name"
            placeholder="如 红冲审计"
            @keydown.enter="saveCurrentPreset"
          />
        </label>
        <label>
          已保存预设
          <select v-model="selectedPresetId" data-testid="operation-log-preset-select">
            <option value="">请选择</option>
            <option v-for="preset in operationLogPresets" :key="preset.id" :value="preset.id">
              {{ preset.name }}（{{ presetScopeLabel(preset) }}）{{ preset.isDefault ? "（默认）" : "" }}{{ preset.readOnly ? "（只读）" : "" }}
            </option>
          </select>
        </label>
        <div class="filter-actions preset-actions">
          <button type="button" data-testid="operation-log-preset-save" @click="saveCurrentPreset">保存预设</button>
          <button type="button" :disabled="!selectedPresetId" data-testid="operation-log-preset-apply" @click="applySelectedPreset">应用预设</button>
          <button type="button" :disabled="!selectedPresetId || selectedPreset?.readOnly" data-testid="operation-log-preset-delete" @click="deleteSelectedPreset">删除预设</button>
          <span v-if="presetMessage" class="filter-preset-message" data-testid="operation-log-preset-message">{{ presetMessage }}</span>
        </div>
      </div>
      <label v-if="filtersExpanded && !isOperationLogList">
        日期
        <input value="2026-06-01 至 2026-06-30" readonly />
      </label>
      <label v-if="filtersExpanded && !isOperationLogList">
        经办人
        <input value="本地管理员" readonly />
      </label>
      <div class="filter-actions">
        <button class="primary-action" type="button" data-testid="list-query" @click="reload">查询</button>
        <button type="button" data-testid="list-reset" @click="resetQuery()">重置</button>
        <button type="button" data-testid="list-toggle-filter" @click="filtersExpanded = !filtersExpanded">
          {{ filtersExpanded ? "收起过滤" : "展开过滤" }}
        </button>
      </div>
    </section>

    <div v-if="locked" class="lock-banner" data-testid="lock-banner">
      单据已在其他页签打开，列表的审核/删除/批量操作已锁定。
    </div>

    <div class="list-toolbar">
      <button class="primary-action" type="button" :disabled="locked || !canMaintainCurrentList" data-testid="list-create" @click="openCreateDialog">新增</button>
      <button v-if="isMasterList" type="button" :disabled="locked || !canMaintainCurrentList || selectedRows.length !== 1" data-testid="master-edit" @click="openEditDialog">编辑</button>
      <button type="button" :disabled="locked || !canAuditCurrentList || selectedRows.length === 0" data-testid="batch-audit" @click="confirmAction('审核')">审核</button>
      <button v-if="isSalesOrderList" type="button" :disabled="!canPushDownSalesOut" data-testid="push-sales-out" @click="pushDownSalesOut">销售出库</button>
      <button v-if="isPurchaseOrderList" type="button" :disabled="!canPushDownPurchaseIn" data-testid="push-purchase-in" @click="pushDownPurchaseIn">采购入库</button>
      <button v-if="isMasterList" type="button" :disabled="locked || !canMaintainCurrentList || selectedRows.length === 0" data-testid="master-enable" @click="submitMasterStatus(true)">启用</button>
      <button v-if="isMasterList" type="button" :disabled="locked || !canMaintainCurrentList || selectedRows.length === 0" data-testid="master-disable" @click="submitMasterStatus(false)">禁用</button>
      <button type="button" :disabled="locked || !canMaintainCurrentList || selectedRows.length === 0" data-testid="batch-delete" @click="isMasterList ? submitMasterDelete() : confirmAction('删除')">删除</button>
      <button type="button" data-testid="list-refresh" @click="reload">刷新</button>
      <button type="button" data-testid="list-export" @click="exportCurrentList">引出</button>
      <button type="button">打印</button>
      <button type="button" data-testid="column-settings" @click="columnDialogOpen = true">列设置</button>
      <span class="selected-count">已选中 {{ selectedRows.length }} 条</span>
      <span v-if="exportMessage" class="list-export-message" data-testid="list-export-message">{{ exportMessage }}</span>
    </div>

    <div class="vxe-wrap" data-testid="vxe-list-table">
      <vxe-table
        :key="tableVersion"
        ref="tableRef"
        height="360"
        size="mini"
        border
        show-overflow="title"
        show-header-overflow="title"
        stripe
        :data="displayedRows"
        :row-config="{ keyField: 'id', isHover: true }"
        :column-config="{ resizable: true }"
        :checkbox-config="{ checkMethod: checkboxCheckMethod }"
        @checkbox-change="syncSelected"
        @checkbox-all="syncSelected"
        @resizable-change="handleColumnResize"
      >
        <vxe-column type="checkbox" width="42" fixed="left" />
        <vxe-column
          v-for="column in visibleColumns"
          :key="column.field"
          :field="column.field"
          :title="column.title"
          :width="column.width"
          :min-width="column.minWidth"
          :fixed="column.fixed || undefined"
          :align="column.align || 'left'"
          :resizable="true"
          show-overflow="title"
        >
          <template #header>
            <div
              class="column-header-cell"
              :class="{ dragging: draggingColumnField === column.field, 'drag-over': dragOverColumnField === column.field }"
              :data-testid="`column-drag-${column.field}`"
              :data-column-field="column.field"
              @mousedown.left="startColumnMouseDrag(column, $event)"
            >
              <span class="column-header-title">
                {{ column.title }}
              </span>
              <button
                class="column-filter-button"
                type="button"
                :class="{ active: Boolean(columnFilters[column.field]?.value) }"
                :title="`${column.title}过滤`"
                :data-testid="`column-filter-${column.field}`"
                @mousedown.stop
                @click.stop="openColumnFilter(column, $event)"
              >
                ⌄
              </button>
            </div>
          </template>
          <template #default="{ row }">
            <span v-if="column.field === 'status'" class="status-pill" :class="{ draft: row.status === '草稿' }">{{ row[column.field] }}</span>
            <button
              v-else-if="isOpenableDocumentList && column.field === 'billNo'"
              class="list-cell-link"
              type="button"
              :disabled="locked"
              :data-testid="`open-document-${row.billNo}`"
              @click.stop="openDocument(row)"
            >
              {{ row[column.field] }}
            </button>
            <span v-else>{{ row[column.field] }}</span>
          </template>
        </vxe-column>
      </vxe-table>
      <div v-if="!loading && listState === 'empty'" class="list-state-panel" data-testid="list-empty-state">
        <strong>暂无数据</strong>
        <span>当前查询条件下没有匹配记录。</span>
      </div>
      <div v-if="!loading && listState === 'forbidden'" class="list-state-panel" data-testid="list-forbidden-state">
        <strong>无权查看</strong>
        <span>{{ stateMessage }}</span>
      </div>
      <div v-if="!loading && listState === 'error'" class="list-state-panel" data-testid="list-error-state">
        <strong>加载失败</strong>
        <span>{{ stateMessage }}</span>
        <button type="button" @click="reload">重试</button>
      </div>
    </div>

    <footer class="list-pagination">
      <span>共 {{ total }} 条</span>
      <select v-model.number="query.pageSize" @change="reload">
        <option :value="200">200条/页</option>
        <option :value="500">500条/页</option>
        <option :value="1000">1000条/页</option>
      </select>
      <button type="button" :disabled="query.page === 1" @click="goPage(query.page - 1)">上一页</button>
      <span>第 {{ query.page }} 页</span>
      <button type="button" :disabled="query.page * query.pageSize >= total" @click="goPage(query.page + 1)">下一页</button>
    </footer>

    <div v-if="columnDialogOpen" class="modal-mask" data-testid="column-settings-dialog">
      <div class="dialog column-dialog">
        <h3>列设置</h3>
        <div class="column-setting-list">
          <div v-for="column in columns" :key="column.field" class="column-setting-row">
            <label><input v-model="column.visible" type="checkbox" /> {{ column.title }}</label>
            <select v-model="column.fixed">
              <option value="">不固定</option>
              <option value="left">固定左侧</option>
              <option value="right">固定右侧</option>
            </select>
          </div>
        </div>
        <div class="dialog-actions">
          <button type="button" @click="resetColumnsToDefault">恢复默认</button>
          <button class="primary-action" type="button" data-testid="column-settings-ok" @click="closeColumnSettings">确定</button>
        </div>
      </div>
    </div>

    <component
      :is="masterFormComponent"
      v-if="masterFormComponent"
      :open="masterDialogOpen"
      :editing="masterEditing"
      :title="definition.title"
      :form="masterForm"
      :error="masterCreateError"
      @close="masterMaintenance.closeDialog"
      @save="masterMaintenance.submitForm"
      @update-field="masterMaintenance.updateField"
    />

    <div
      v-if="filterDialogOpen && activeFilterColumn"
      class="column-filter-popover"
      :style="{ left: `${filterPopoverLeft}px`, top: `${filterPopoverTop}px` }"
      data-testid="column-filter-dialog"
    >
      <div class="filter-operator-list">
        <button
          v-for="operator in filterOperators"
          :key="operator"
          type="button"
          :class="{ active: activeFilterOperator === operator }"
          @click="activeFilterOperator = operator"
        >
          {{ operator }}
        </button>
      </div>
      <div class="column-filter-input-row">
          <input
            v-model="activeFilterValue"
            data-testid="column-filter-input"
            placeholder="输入过滤关键字"
            @keydown.enter="applyColumnFilter"
          />
      </div>
      <div class="column-filter-actions">
        <button type="button" @click="clearColumnFilter">重置</button>
        <button class="primary-action" type="button" data-testid="column-filter-ok" @click="applyColumnFilter">确定</button>
      </div>
    </div>

    <div v-if="pendingAction" class="modal-mask" data-testid="batch-confirm-dialog">
      <div class="dialog">
        <h3>操作确认</h3>
        <p>确定要{{ pendingAction }}已选中的 {{ selectedRows.length }} 条数据吗？</p>
        <div class="dialog-actions">
          <button type="button" @click="pendingAction = ''">取消</button>
          <button class="danger-action" type="button" @click="pendingAction = ''">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  deleteListPreset,
  exportListRows,
  fetchListPresets,
  fetchListRows,
  saveListPreset,
  type ListFilterPreset
} from "../services/listApi";
import { useMasterDataMaintenance } from "../modules/master-data/useMasterDataMaintenance";
import { useSessionStore } from "../stores/session";

interface ListColumn {
  field: string;
  title: string;
  width?: number;
  minWidth?: number;
  fixed?: "" | "left" | "right";
  align?: "left" | "center" | "right";
  visible: boolean;
}

interface ListDefinition {
  title: string;
  subtitle: string;
  keywordPlaceholder: string;
  statuses: string[];
  columns: ListColumn[];
}

interface ColumnFilter {
  operator: string;
  value: string;
}

type OpenableDocumentType = "salesOrder" | "salesOut" | "purchaseOrder" | "purchaseIn" | "materialIssue" | "productIn" | "otherStockIn" | "otherStockOut" | "stockTransfer" | "stockCount" | "stockCountGain" | "stockCountLoss";

const props = defineProps<{
  listKey: string;
  locked?: boolean;
}>();
const emit = defineEmits<{
  pushDownSalesOut: [row: Record<string, unknown>];
  pushDownPurchaseIn: [row: Record<string, unknown>];
  openDocument: [payload: { type: OpenableDocumentType; row: Record<string, unknown> }];
}>();

const tableRef = ref();
const tableVersion = ref(0);
const loading = ref(false);
const listState = ref<"ready" | "empty" | "error" | "forbidden">("ready");
const stateMessage = ref("");
const filtersExpanded = ref(false);
const columnDialogOpen = ref(false);
const filterDialogOpen = ref(false);
const pendingAction = ref("");
const rows = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const selectedRows = ref<Record<string, unknown>[]>([]);
const exportMessage = ref("");
const presetMessage = ref("");
const presetName = ref("");
const selectedPresetId = ref("");
const operationLogPresets = ref<ListFilterPreset[]>([]);
const activeFilterColumn = ref<ListColumn | null>(null);
const activeFilterOperator = ref("包含");
const activeFilterValue = ref("");
const columnFilters = reactive<Record<string, ColumnFilter>>({});
const filterPopoverLeft = ref(0);
const filterPopoverTop = ref(0);
const draggingColumnField = ref("");
const dragOverColumnField = ref("");
const query = reactive({
  keyword: "",
  status: "",
  page: 1,
  pageSize: 200,
  module: "",
  action: "",
  operator: "",
  targetType: "",
  dateFrom: "",
  dateTo: ""
});
const filterOperators = ["包含", "不包含", "等于", "不等于", "以……开始", "以……结束", "为空", "不为空"];
const operationLogModules = ["SALES", "PURCHASE", "INVENTORY", "PRODUCTION", "FINANCE", "MASTER", "SYSTEM"];
const operationLogActions = [
  "AUDIT",
  "REVERSE",
  "RED_REVERSE",
  "ISSUE",
  "REVERSE_ISSUE",
  "RED_REVERSE_ISSUE",
  "COMPLETE",
  "REVERSE_COMPLETE",
  "RED_REVERSE_COMPLETE",
  "CREATE_TASK",
  "SAVE_BOM",
  "RECEIVE",
  "PAY"
];
const operationLogTargetTypes = [
  "sales_order",
  "sales_out",
  "purchase_order",
  "purchase_in",
  "other_stock_in",
  "production_task",
  "production_material_issue",
  "production_completion",
  "ar_receivable",
  "ap_payable",
  "prod_bom"
];
const definitions: Record<string, ListDefinition> = {
  "product-master-list": {
    title: "商品资料",
    subtitle: "编码、名称、规格型号、类别、单位和状态按高密度列表范式展示。",
    keywordPlaceholder: "商品编码、名称、规格型号",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "商品编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "商品名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "category", title: "商品类别", width: 130, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ]
  },
  "customer-master-list": {
    title: "客户",
    subtitle: "客户编码、联系人、电话、地区和状态保持同一列表骨架。",
    keywordPlaceholder: "客户编码、客户名称、联系人",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "客户编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "客户名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "region", title: "地区", width: 160, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "supplier-master-list": {
    title: "供应商",
    subtitle: "供应商资料使用与客户一致的筛选、勾选、列设置和分页范式。",
    keywordPlaceholder: "供应商编码、供应商名称",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "供应商编码", width: 150, fixed: "left", visible: true },
      { field: "name", title: "供应商名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "sales-order-form-list": {
    title: "销售订单列表",
    subtitle: "销售订单列表承载查询、批量动作、列设置、页签锁定和分页。",
    keywordPlaceholder: "单据编号、客户、商品",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customer", title: "客户/对象", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "outStatus", title: "出库状态", width: 110, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "purchase-order-form-list": {
    title: "采购订单列表",
    subtitle: "采购订单列表承载供应商、审核状态、入库状态和金额查询。",
    keywordPlaceholder: "单据编号、供应商、商品",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "inStatus", title: "入库状态", width: 110, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "purchase-in-list": {
    title: "采购入库单",
    subtitle: "采购入库单用于验证业务列表的供应商、仓库、金额和状态列。",
    keywordPlaceholder: "单据编号、供应商、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "purchase-in-form-list": {
    title: "采购入库单",
    subtitle: "采购入库单读取真实单据，审核后增加库存。",
    keywordPlaceholder: "单据编号、供应商、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "sales-out-list": {
    title: "销售出库单",
    subtitle: "销售出库单读取真实单据，审核后减少库存。",
    keywordPlaceholder: "单据编号、客户、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已红冲"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customer", title: "客户", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "sales-out-form-list": {
    title: "销售出库单",
    subtitle: "销售出库单读取真实单据，审核后减少库存。",
    keywordPlaceholder: "单据编号、客户、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已红冲"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customer", title: "客户", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "inventory-query-list": {
    title: "库存查询",
    subtitle: "库存查询只展示数据库余额口径的现存量和可用量，不做业务结果缓存。",
    keywordPlaceholder: "商品编码、商品名称、仓库",
    statuses: ["正常", "低库存"],
    columns: [
      { field: "code", title: "商品编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "商品名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "onHand", title: "现存量", width: 110, align: "right", visible: true },
      { field: "available", title: "可用量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "warehouse-master-list": {
    title: "仓库",
    subtitle: "仓库资料展示编码、名称、库存策略和启用状态。",
    keywordPlaceholder: "仓库编码、仓库名称",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "仓库编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "仓库名称", width: 220, visible: true },
      { field: "stockPolicy", title: "库存策略", width: 150, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "receivable-list": {
    title: "应收单",
    subtitle: "销售出库审核自动生成应收，收款后按未核销、部分核销、已核销展示。",
    keywordPlaceholder: "应收单号、源单号、客户",
    statuses: ["未核销", "部分核销", "已核销"],
    columns: [
      { field: "billNo", title: "应收单号", width: 160, fixed: "left", visible: true },
      { field: "sourceBillNo", title: "源单号", width: 150, visible: true },
      { field: "customer", title: "客户", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "amount", title: "应收金额", width: 120, align: "right", visible: true },
      { field: "receivedAmount", title: "已收金额", width: 120, align: "right", visible: true },
      { field: "status", title: "状态", width: 110, visible: true }
    ]
  },
  "payable-list": {
    title: "应付单",
    subtitle: "采购入库审核自动生成应付，付款后按未核销、部分核销、已核销展示。",
    keywordPlaceholder: "应付单号、源单号、供应商",
    statuses: ["未核销", "部分核销", "已核销"],
    columns: [
      { field: "billNo", title: "应付单号", width: 160, fixed: "left", visible: true },
      { field: "sourceBillNo", title: "源单号", width: 150, visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "amount", title: "应付金额", width: 120, align: "right", visible: true },
      { field: "paidAmount", title: "已付金额", width: 120, align: "right", visible: true },
      { field: "status", title: "状态", width: 110, visible: true }
    ]
  },
  "production-task-form-list": {
    title: "生产任务单",
    subtitle: "生产任务展示 BOM、计划数、已领料数、完工数和执行状态。",
    keywordPlaceholder: "任务单号、BOM、商品",
    statuses: ["已审核", "已领料", "已完工"],
    columns: [
      { field: "billNo", title: "任务单号", width: 160, fixed: "left", visible: true },
      { field: "bomCode", title: "BOM", width: 120, visible: true },
      { field: "productCode", title: "商品编码", width: 130, visible: true },
      { field: "productName", title: "商品名称", width: 180, visible: true },
      { field: "warehouse", title: "完工仓库", width: 130, visible: true },
      { field: "qty", title: "计划数", width: 100, align: "right", visible: true },
      { field: "issuedQty", title: "已领料数", width: 110, align: "right", visible: true },
      { field: "completedQty", title: "完工数", width: 100, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "material-issue-form-list": {
    title: "生产领料单",
    subtitle: "生产领料单展示来源任务、领料仓库、金额和审核/冲销状态。",
    keywordPlaceholder: "领料单号、生产任务单、仓库",
    statuses: ["已审核", "已反审核", "已红冲"],
    columns: [
      { field: "billNo", title: "单据编号", width: 160, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "生产任务单", width: 170, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "product-in-form-list": {
    title: "产品入库单",
    subtitle: "产品入库单展示来源任务、入库仓库、金额和审核/冲销状态。",
    keywordPlaceholder: "入库单号、生产任务单、仓库",
    statuses: ["已审核", "已反审核", "已红冲"],
    columns: [
      { field: "billNo", title: "单据编号", width: 160, fixed: "left", visible: true },
      { field: "sourceOrderNo", title: "生产任务单", width: 170, visible: true },
      { field: "billDate", title: "日期", width: 120, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "other-in-form-list": {
    title: "其他入库单列表",
    subtitle: "其他入库单按库存业务列表范式展示，审核后只增加库存数量。",
    keywordPlaceholder: "单据编号、商品编码、商品名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "商品编码", width: 130, visible: true },
      { field: "productName", title: "商品名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "数量", width: 100, align: "right", visible: true },
      { field: "unitCost", title: "单位成本", width: 110, align: "right", visible: true },
      { field: "inCost", title: "入库成本", width: 120, align: "right", visible: true }
    ]
  },
  "other-out-form-list": {
    title: "其他出库单列表",
    subtitle: "其他出库单按库存业务列表范式展示，审核后只减少库存数量。",
    keywordPlaceholder: "单据编号、商品编码、商品名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "商品编码", width: 130, visible: true },
      { field: "productName", title: "商品名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "数量", width: 100, align: "right", visible: true },
      { field: "unitCost", title: "单位成本", width: 110, align: "right", visible: true },
      { field: "outCost", title: "出库成本", width: 120, align: "right", visible: true }
    ]
  },
  "stock-transfer-form-list": {
    title: "调拨单列表",
    subtitle: "调拨单按库存业务列表范式展示，审核后源仓减少、目标仓增加。",
    keywordPlaceholder: "单据编号、商品编码、商品名称、源仓、目标仓",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "商品编码", width: 130, visible: true },
      { field: "productName", title: "商品名称", width: 180, visible: true },
      { field: "sourceWarehouse", title: "源仓库", width: 140, visible: true },
      { field: "targetWarehouse", title: "目标仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "数量", width: 100, align: "right", visible: true }
    ]
  },
  "stock-count-form-list": {
    title: "盘点单列表",
    subtitle: "盘点单展示系统库存、实盘数量和差异，审核后生成盘盈/盘亏草稿。",
    keywordPlaceholder: "单据编号、商品编码、商品名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "商品编码", width: 130, visible: true },
      { field: "productName", title: "商品名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "systemQty", title: "系统库存", width: 110, align: "right", visible: true },
      { field: "countedQty", title: "实盘数量", width: 110, align: "right", visible: true },
      { field: "diffQty", title: "差异", width: 100, align: "right", visible: true }
    ]
  },
  "stock-count-gain-form-list": {
    title: "盘盈单列表",
    subtitle: "盘盈单按库存业务列表范式展示，审核后增加库存数量。",
    keywordPlaceholder: "单据编号、源盘点单、商品编码、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "sourceBillNo", title: "源盘点单", width: 180, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "productCode", title: "商品编码", width: 130, visible: true },
      { field: "productName", title: "商品名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "qty", title: "盘盈数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true }
    ]
  },
  "stock-count-loss-form-list": {
    title: "盘亏单列表",
    subtitle: "盘亏单按库存业务列表范式展示，审核后减少库存数量。",
    keywordPlaceholder: "单据编号、源盘点单、商品编码、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "sourceBillNo", title: "源盘点单", width: 180, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "productCode", title: "商品编码", width: 130, visible: true },
      { field: "productName", title: "商品名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "qty", title: "盘亏数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true }
    ]
  },
  "bom-list": {
    title: "BOM维护",
    subtitle: "BOM 维护展示成品、基准数量和启用状态，明细由后端 BOM 接口维护。",
    keywordPlaceholder: "BOM编码、商品编码、商品名称",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "BOM编码", width: 150, fixed: "left", visible: true },
      { field: "productCode", title: "成品编码", width: 140, visible: true },
      { field: "productName", title: "成品名称", width: 200, visible: true },
      { field: "qty", title: "基准数量", width: 100, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "user-role-list": {
    title: "用户角色",
    subtitle: "角色和权限码以最小 RBAC 口径展示，后续可扩展到授权矩阵。",
    keywordPlaceholder: "角色编码、角色名称、权限码",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "角色编码", width: 150, fixed: "left", visible: true },
      { field: "name", title: "角色名称", width: 160, visible: true },
      { field: "permissions", title: "权限码", width: 520, visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "operation-log-list": {
    title: "操作日志",
    subtitle: "关键审核、冲销、核销、生产动作写入操作日志，供追溯审计。",
    keywordPlaceholder: "模块、动作、对象、时间",
    statuses: ["成功", "失败"],
    columns: [
      { field: "operatedAt", title: "操作时间", width: 170, visible: true },
      { field: "module", title: "模块", width: 120, visible: true },
      { field: "action", title: "动作", width: 160, visible: true },
      { field: "targetType", title: "对象类型", width: 160, visible: true },
      { field: "targetNo", title: "业务单号", width: 210, visible: true },
      { field: "operator", title: "操作人", width: 120, visible: true },
      { field: "targetId", title: "对象ID", width: 250, visible: false },
      { field: "status", title: "状态", width: 90, visible: true },
      { field: "reason", title: "失败原因", width: 180, visible: true }
    ]
  }
};

const fallbackDefinition: ListDefinition = {
  title: "标准列表",
  subtitle: "该入口暂用 B1 标准列表骨架承载。",
  keywordPlaceholder: "编码、名称、单据编号",
  statuses: ["草稿", "已审核", "启用"],
  columns: definitions["sales-order-form-list"].columns
};

const definition = computed(() => definitions[props.listKey] ?? fallbackDefinition);
const session = useSessionStore();
const masterMaintenance = useMasterDataMaintenance(computed(() => props.listKey), rows, selectedRows, reload);
const isMasterList = masterMaintenance.isMasterList;
const masterFormComponent = masterMaintenance.formComponent;
const masterDialogOpen = masterMaintenance.dialogOpen;
const masterEditing = masterMaintenance.editing;
const masterForm = masterMaintenance.form;
const masterCreateError = masterMaintenance.createError;
const isSalesOrderList = computed(() => props.listKey === "sales-order-form-list");
const isPurchaseOrderList = computed(() => props.listKey === "purchase-order-form-list");
const isOperationLogList = computed(() => props.listKey === "operation-log-list");
const auditPermissionByListKey: Partial<Record<string, string>> = {
  "sales-order-form-list": "sales.order.audit",
  "sales-out-list": "sales.out.audit",
  "sales-out-form-list": "sales.out.audit",
  "purchase-order-form-list": "purchase.order.audit",
  "purchase-in-list": "purchase.in.audit",
  "purchase-in-form-list": "purchase.in.audit",
  "material-issue-form-list": "production.document.audit",
  "product-in-form-list": "production.document.audit",
  "other-in-form-list": "inventory.other_stock_in.audit",
  "other-out-form-list": "inventory.other_stock_out.audit",
  "stock-transfer-form-list": "inventory.stock_transfer.audit",
  "stock-count-form-list": "inventory.stock_count.audit",
  "stock-count-gain-form-list": "inventory.stock_count_gain.audit",
  "stock-count-loss-form-list": "inventory.stock_count_loss.audit"
};
const maintainPermissionByListKey: Partial<Record<string, string>> = {
  "product-master-list": "master.data.manage",
  "customer-master-list": "master.data.manage",
  "supplier-master-list": "master.data.manage",
  "warehouse-master-list": "master.data.manage",
  "sales-order-form-list": "sales.order.audit",
  "sales-out-list": "sales.out.audit",
  "sales-out-form-list": "sales.out.audit",
  "purchase-order-form-list": "purchase.order.audit",
  "purchase-in-list": "purchase.in.audit",
  "purchase-in-form-list": "purchase.in.audit",
  "material-issue-form-list": "production.document.audit",
  "product-in-form-list": "production.document.audit",
  "other-in-form-list": "inventory.other_stock_in.audit",
  "other-out-form-list": "inventory.other_stock_out.audit",
  "stock-transfer-form-list": "inventory.stock_transfer.audit",
  "stock-count-form-list": "inventory.stock_count.audit",
  "stock-count-gain-form-list": "inventory.stock_count_gain.audit",
  "stock-count-loss-form-list": "inventory.stock_count_loss.audit"
};
const canAuditCurrentList = computed(() => session.hasPermission(auditPermissionByListKey[props.listKey]));
const canMaintainCurrentList = computed(() => session.hasPermission(maintainPermissionByListKey[props.listKey]));
const documentOpenTypeByListKey: Partial<Record<string, OpenableDocumentType>> = {
  "sales-order-form-list": "salesOrder",
  "sales-out-list": "salesOut",
  "sales-out-form-list": "salesOut",
  "purchase-order-form-list": "purchaseOrder",
  "purchase-in-list": "purchaseIn",
  "purchase-in-form-list": "purchaseIn",
  "material-issue-form-list": "materialIssue",
  "product-in-form-list": "productIn",
  "other-in-form-list": "otherStockIn",
  "other-out-form-list": "otherStockOut",
  "stock-transfer-form-list": "stockTransfer",
  "stock-count-form-list": "stockCount",
  "stock-count-gain-form-list": "stockCountGain",
  "stock-count-loss-form-list": "stockCountLoss"
};
const openableDocumentType = computed(() => documentOpenTypeByListKey[props.listKey] ?? null);
const isOpenableDocumentList = computed(() => Boolean(openableDocumentType.value));
const canPushDownSalesOut = computed(() => {
  const row = selectedRows.value[0];
  return Boolean(
    isSalesOrderList.value &&
    !props.locked &&
    session.hasPermission("sales.out.audit") &&
    selectedRows.value.length === 1 &&
    row?.status === "已审核" &&
    row?.outStatus !== "全部出库"
  );
});
const canPushDownPurchaseIn = computed(() => {
  const row = selectedRows.value[0];
  return Boolean(
    isPurchaseOrderList.value &&
    !props.locked &&
    session.hasPermission("purchase.in.audit") &&
    selectedRows.value.length === 1 &&
    row?.status === "已审核" &&
    row?.inStatus !== "全部入库"
  );
});
const columns = ref<ListColumn[]>([]);
const visibleColumns = computed(() => columns.value.filter((column) => column.visible));
const displayedRows = computed(() => rows.value);
const selectedPreset = computed(() => operationLogPresets.value.find((preset) => preset.id === selectedPresetId.value));

watch(() => props.listKey, () => {
  resetColumns();
  resetQuery(false);
  void loadOperationLogPresets(true);
}, { immediate: true });

onMounted(() => {
  reload();
});

onBeforeUnmount(() => {
  window.removeEventListener("mousemove", trackColumnMouseDrag);
  window.removeEventListener("mouseup", finishColumnMouseDrag);
});

function resetColumns() {
  const defaults = definition.value.columns.map((column) => ({ ...column }));
  const saved = loadColumnPreferences();
  if (!saved.length) {
    columns.value = defaults;
    return;
  }
  const defaultByField = new Map(defaults.map((column) => [column.field, column]));
  const restored: ListColumn[] = [];
  saved.forEach((savedColumn) => {
    const current = defaultByField.get(savedColumn.field);
    if (!current) {
      return;
    }
    restored.push({
      ...current,
      width: savedColumn.width ?? current.width,
      fixed: savedColumn.fixed ?? "",
      visible: savedColumn.visible
    });
  });
  const restoredFields = new Set(restored.map((column) => column.field));
  columns.value = [
    ...restored,
    ...defaults.filter((column) => !restoredFields.has(column.field))
  ];
}

async function reload() {
  exportMessage.value = "";
  loading.value = true;
  listState.value = "ready";
  stateMessage.value = "";
  selectedRows.value = [];
  const response = await fetchListRows(props.listKey, { ...query, columnFilters });
  if (response.ok && response.data) {
    rows.value = response.data.rows;
    total.value = response.data.total;
    listState.value = response.data.rows.length ? "ready" : "empty";
    tableVersion.value += 1;
  } else {
    rows.value = [];
    total.value = 0;
    listState.value = response.forbidden ? "forbidden" : "error";
    stateMessage.value = response.message;
  }
  loading.value = false;
}

async function exportCurrentList() {
  exportMessage.value = "";
  const result = await exportListRows(props.listKey, { ...query, columnFilters });
  if (!result.ok || !result.blob) {
    exportMessage.value = result.message;
    return;
  }
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.fileName;
  link.dataset.testid = "list-export-download-link";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  exportMessage.value = "引出文件已生成";
}

async function saveCurrentPreset() {
  if (!isOperationLogList.value) {
    return;
  }
  const name = presetName.value.trim() || "未命名预设";
  const existing = operationLogPresets.value.find((preset) => preset.name === name && Boolean(preset.userName));
  const preset = {
    name,
    query: snapshotOperationLogQuery(),
    columnFilters: snapshotColumnFilters(),
    shared: true,
    isDefault: false
  };
  const response = await saveListPreset(props.listKey, preset);
  if (response.ok && response.data) {
    const savedPreset = response.data;
    operationLogPresets.value = existing
      ? operationLogPresets.value.map((item) => item.id === existing.id ? savedPreset : item)
      : [savedPreset, ...operationLogPresets.value];
    selectedPresetId.value = savedPreset.id;
    persistOperationLogPresets();
    presetMessage.value = "预设已保存";
    return;
  }
  const fallbackPreset: ListFilterPreset = {
    id: existing?.id ?? `operation-log-preset-${Date.now()}`,
    ...preset
  };
  operationLogPresets.value = existing
    ? operationLogPresets.value.map((item) => item.id === existing.id ? fallbackPreset : item)
    : [...operationLogPresets.value, fallbackPreset];
  selectedPresetId.value = fallbackPreset.id;
  persistOperationLogPresets();
  presetMessage.value = "预设已本机保存";
}

function applySelectedPreset() {
  const preset = operationLogPresets.value.find((item) => item.id === selectedPresetId.value);
  if (!preset) {
    return;
  }
  applyOperationLogPreset(preset);
  presetMessage.value = "预设已应用";
}

async function deleteSelectedPreset() {
  const preset = operationLogPresets.value.find((item) => item.id === selectedPresetId.value);
  if (!preset) {
    return;
  }
  if (preset.readOnly) {
    presetMessage.value = "系统预设不可删除";
    return;
  }
  if (!preset.id.startsWith("operation-log-preset-")) {
    const response = await deleteListPreset(props.listKey, preset.id);
    if (!response.ok) {
      presetMessage.value = response.message;
      return;
    }
  }
  operationLogPresets.value = operationLogPresets.value.filter((item) => item.id !== preset.id);
  selectedPresetId.value = "";
  presetName.value = "";
  persistOperationLogPresets();
  presetMessage.value = "预设已删除";
}

function snapshotOperationLogQuery(): Record<string, string> {
  return {
    keyword: query.keyword,
    status: query.status,
    module: query.module,
    action: query.action,
    operator: query.operator,
    targetType: query.targetType,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo
  };
}

function snapshotColumnFilters() {
  return Object.fromEntries(Object.entries(columnFilters).map(([field, filter]) => [field, { ...filter }]));
}

function presetScopeLabel(preset: ListFilterPreset) {
  if (preset.userName) {
    return `本人:${preset.userName}`;
  }
  if (preset.roleCode) {
    return preset.roleCode;
  }
  return "通用";
}

function replaceColumnFilters(nextFilters: Record<string, ColumnFilter>) {
  Object.keys(columnFilters).forEach((field) => delete columnFilters[field]);
  Object.entries(nextFilters).forEach(([field, filter]) => {
    columnFilters[field] = { ...filter };
  });
}

async function loadOperationLogPresets(applyDefault = false) {
  if (!isOperationLogList.value) {
    operationLogPresets.value = [];
    selectedPresetId.value = "";
    presetName.value = "";
    return;
  }
  const response = await fetchListPresets(props.listKey);
  if (response.ok) {
    operationLogPresets.value = response.data;
    persistOperationLogPresets();
    if (applyDefault) {
      const defaultPreset = response.data.find((preset) => preset.isDefault);
      if (defaultPreset) {
        applyOperationLogPreset(defaultPreset, "默认预设已应用");
        return;
      }
      reload();
    }
    return;
  }
  try {
    operationLogPresets.value = JSON.parse(localStorage.getItem(operationLogPresetKey()) || "[]") as ListFilterPreset[];
  } catch {
    operationLogPresets.value = [];
  }
  if (applyDefault) {
    reload();
  }
}

function applyOperationLogPreset(preset: ListFilterPreset, message = "") {
  Object.assign(query, {
    ...preset.query,
    page: 1
  });
  replaceColumnFilters(preset.columnFilters);
  filtersExpanded.value = true;
  selectedPresetId.value = preset.id;
  presetName.value = preset.name;
  presetMessage.value = message;
  reload();
}

function persistOperationLogPresets() {
  localStorage.setItem(operationLogPresetKey(), JSON.stringify(operationLogPresets.value));
}

function operationLogPresetKey() {
  return "jdy:operation-log-filter-presets";
}

function resetQuery(shouldReload = true) {
  query.keyword = "";
  query.status = "";
  query.module = "";
  query.action = "";
  query.operator = "";
  query.targetType = "";
  query.dateFrom = "";
  query.dateTo = "";
  query.page = 1;
  presetMessage.value = "";
  if (shouldReload) {
    reload();
  }
}

function goPage(page: number) {
  query.page = page;
  reload();
}

function syncSelected(event?: { records?: Record<string, unknown>[] }) {
  selectedRows.value = event?.records ?? tableRef.value?.getCheckboxRecords?.() ?? [];
}

function checkboxCheckMethod() {
  return !props.locked;
}

function confirmAction(action: string) {
  pendingAction.value = action;
}

function pushDownSalesOut() {
  const row = selectedRows.value[0];
  if (canPushDownSalesOut.value && row) {
    emit("pushDownSalesOut", row);
  }
}

function pushDownPurchaseIn() {
  const row = selectedRows.value[0];
  if (canPushDownPurchaseIn.value && row) {
    emit("pushDownPurchaseIn", row);
  }
}

function openDocument(row: Record<string, unknown>) {
  if (!props.locked && openableDocumentType.value) {
    emit("openDocument", { type: openableDocumentType.value, row });
  }
}

function openCreateDialog() {
  if (!masterMaintenance.openCreateDialog()) {
    pendingAction.value = "新增";
  }
}

function openEditDialog() {
  masterMaintenance.openEditDialog();
}

async function submitMasterStatus(enabled: boolean) {
  await masterMaintenance.submitStatus(enabled);
}

async function submitMasterDelete() {
  await masterMaintenance.submitDelete();
}

function openColumnFilter(column: ListColumn, event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  activeFilterColumn.value = column;
  activeFilterOperator.value = columnFilters[column.field]?.operator ?? "包含";
  activeFilterValue.value = columnFilters[column.field]?.value ?? "";
  filterPopoverLeft.value = Math.min(rect.right - 136, window.innerWidth - 150);
  filterPopoverTop.value = rect.bottom + 4;
  filterDialogOpen.value = true;
}

function applyColumnFilter() {
  if (!activeFilterColumn.value) {
    return;
  }
  const value = activeFilterValue.value.trim();
  if (value || ["为空", "不为空"].includes(activeFilterOperator.value)) {
    columnFilters[activeFilterColumn.value.field] = {
      operator: activeFilterOperator.value,
      value
    };
  } else {
    delete columnFilters[activeFilterColumn.value.field];
  }
  filterDialogOpen.value = false;
  query.page = 1;
  reload();
}

function clearColumnFilter() {
  if (activeFilterColumn.value) {
    delete columnFilters[activeFilterColumn.value.field];
  }
  activeFilterValue.value = "";
  filterDialogOpen.value = false;
  query.page = 1;
  reload();
}

function startColumnMouseDrag(column: ListColumn, event: MouseEvent) {
  event.preventDefault();
  draggingColumnField.value = column.field;
  dragOverColumnField.value = column.field;
  window.addEventListener("mousemove", trackColumnMouseDrag);
  window.addEventListener("mouseup", finishColumnMouseDrag, { once: true });
}

function trackColumnMouseDrag(event: MouseEvent) {
  if (!draggingColumnField.value) {
    return;
  }
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const header = element?.closest<HTMLElement>(".column-header-cell");
  const field = header?.dataset.columnField;
  if (field) {
    dragOverColumnField.value = field;
  }
}

function finishColumnMouseDrag() {
  const targetField = dragOverColumnField.value;
  const sourceField = draggingColumnField.value;
  if (!sourceField || !targetField || sourceField === targetField) {
    finishColumnDrag();
    return;
  }
  const sourceIndex = columns.value.findIndex((column) => column.field === sourceField);
  const targetIndex = columns.value.findIndex((column) => column.field === targetField);
  if (sourceIndex === -1 || targetIndex === -1) {
    finishColumnDrag();
    return;
  }
  const nextColumns = [...columns.value];
  const [sourceColumn] = nextColumns.splice(sourceIndex, 1);
  sourceColumn.fixed = "";
  const targetColumn = nextColumns.find((column) => column.field === targetField);
  if (targetColumn) {
    targetColumn.fixed = "";
  }
  nextColumns.splice(targetIndex, 0, sourceColumn);
  columns.value = nextColumns;
  tableVersion.value += 1;
  saveColumnPreferences();
  finishColumnDrag();
}

function finishColumnDrag() {
  window.removeEventListener("mousemove", trackColumnMouseDrag);
  draggingColumnField.value = "";
  dragOverColumnField.value = "";
}

function handleColumnResize(event: { column?: { field?: string }, resizeWidth?: number }) {
  const field = event.column?.field;
  if (!field || !event.resizeWidth) {
    return;
  }
  const target = columns.value.find((column) => column.field === field);
  if (target) {
    target.width = event.resizeWidth;
    saveColumnPreferences();
  }
}

function closeColumnSettings() {
  saveColumnPreferences();
  columnDialogOpen.value = false;
}

function resetColumnsToDefault() {
  localStorage.removeItem(columnPreferenceKey());
  columns.value = definition.value.columns.map((column) => ({ ...column }));
  tableVersion.value += 1;
}

function columnPreferenceKey() {
  return `jdy:list-columns:${props.listKey}`;
}

function loadColumnPreferences(): ListColumn[] {
  try {
    const raw = localStorage.getItem(columnPreferenceKey());
    return raw ? JSON.parse(raw) as ListColumn[] : [];
  } catch {
    return [];
  }
}

function saveColumnPreferences() {
  const preference = columns.value.map((column) => ({
    field: column.field,
    width: column.width,
    fixed: column.fixed ?? "",
    visible: column.visible
  }));
  localStorage.setItem(columnPreferenceKey(), JSON.stringify(preference));
}
</script>
