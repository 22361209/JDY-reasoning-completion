<template>
  <div class="data-list-page" :data-testid="`list-page-${listKey}`">
    <div class="business-head list-head">
      <div>
        <h2>{{ definition.title }}</h2>
        <p v-if="definition.subtitle">{{ definition.subtitle }}</p>
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

    <div class="list-toolbar">
      <button v-if="!isStockAlertList" class="primary-action" type="button" :disabled="!canMaintainCurrentList" data-testid="list-create" @click="openCreateDialog">新增</button>
      <button v-if="isStockAlertList" type="button" :disabled="!canMaintainStockAlert" data-testid="stock-alert-settings" @click="openStockAlertSettings">安全库存设置</button>
      <button v-if="isMasterList" type="button" :disabled="!canMaintainCurrentList || selectedRows.length !== 1" data-testid="master-edit" @click="openEditDialog">编辑</button>
      <button v-if="!isStockAlertList" type="button" :disabled="!canAuditCurrentList || selectedRows.length === 0 || selectedContainsLockedRow" data-testid="batch-audit" @click="confirmAction('审核')">审核</button>
      <button v-if="isReverseableDocumentList" type="button" :disabled="!canAuditCurrentList || selectedRows.length === 0 || selectedContainsLockedRow || !selectedRows.every(isAuditedRow)" data-testid="batch-reverse" @click="confirmAction('反审核')">反审核</button>
      <button v-if="isSalesOrderList" type="button" :disabled="!canPushDownSalesOut" data-testid="push-sales-out" @click="pushDownSalesOut">发货通知</button>
      <button v-if="isPurchaseOrderList" type="button" :disabled="!canPushDownPurchaseIn" data-testid="push-purchase-in" @click="pushDownPurchaseIn">采购入库</button>
      <button v-if="isLifecycleDocumentList" type="button" :disabled="!canBatchClose" data-testid="batch-close" @click="confirmAction('关闭')">关闭</button>
      <button v-if="isLifecycleDocumentList" type="button" :disabled="!canBatchUnclose" data-testid="batch-unclose" @click="confirmAction('反关闭')">反关闭</button>
      <button v-if="isLifecycleDocumentList" type="button" :disabled="!canBatchFreeze" data-testid="batch-freeze" @click="confirmAction('冻结')">冻结</button>
      <button v-if="isLifecycleDocumentList" type="button" :disabled="!canBatchUnfreeze" data-testid="batch-unfreeze" @click="confirmAction('解冻')">解冻</button>
      <button v-if="isLifecycleDocumentList" class="danger-action" type="button" :disabled="!canBatchVoid" data-testid="batch-void" @click="confirmAction('作废')">作废</button>
      <button type="button" data-testid="list-refresh" @click="reload">刷新</button>
      <div class="list-more-actions">
        <button type="button" class="list-more-trigger" data-testid="list-more-actions">更多</button>
        <div class="list-more-menu">
          <button v-if="isMasterList" type="button" :disabled="!canMaintainCurrentList || selectedRows.length === 0" data-testid="master-enable" @click="submitMasterStatus(true)">启用</button>
          <button v-if="isMasterList" type="button" :disabled="!canMaintainCurrentList || selectedRows.length === 0" data-testid="master-disable" @click="submitMasterStatus(false)">禁用</button>
          <button type="button" data-testid="list-export" @click="exportCurrentList">引出</button>
          <button type="button">打印</button>
          <button class="danger-menu-action" type="button" :disabled="!canMaintainCurrentList || selectedRows.length === 0 || selectedContainsLockedRow" data-testid="batch-delete" @click="isMasterList ? submitMasterDelete() : confirmAction('删除')">删除</button>
        </div>
      </div>
      <span class="selected-count">已选中 {{ selectedRows.length }} 条</span>
      <span v-if="exportMessage" class="list-export-message" data-testid="list-export-message">{{ exportMessage }}</span>
      <span v-if="batchMessage" class="list-export-message" data-testid="list-batch-message">{{ batchMessage }}</span>
    </div>

    <div class="list-table-tools">
      <button v-if="supportsDetailView" type="button" class="view-switch-button" data-testid="list-detail-view-toggle" @click="toggleDetailView">
        {{ isDetailView ? "整单视图" : "明细视图" }}
      </button>
      <button type="button" data-testid="column-settings" @click="columnDialogOpen = true">列设置</button>
      <button type="button" data-testid="list-refresh-stock" @click="reload">更新库存</button>
    </div>

    <TableCore
      kind="list"
      test-id="vxe-list-table"
      frame-class="vxe-wrap"
      inner-class="table-core-vxe-inner"
      table-class="vxe-table data-list-native-table"
      header-wrapper-class="vxe-table--header-wrapper body--wrapper"
      body-wrapper-class="vxe-table--body-wrapper body--wrapper"
      header-row-class="vxe-header--row"
      row-class="vxe-body--row"
      :columns="listCoreColumns"
      :rows="displayedRows"
      :min-width="listTableMinWidth"
      :row-key="rowKey"
      :cell-title="listCellTitle"
      @column-drag-start="startListColumnMouseDrag"
      @column-filter="openListColumnFilter"
      @column-resize="resizeListColumn"
      @column-resize-end="finishListColumnResize"
    >
      <template #header-cell="{ column, startResize }">
        <template v-if="column.key === '__selection'">
          <input
            :checked="allDisplayedRowsSelected"
            type="checkbox"
            aria-label="全选列表行"
            data-testid="list-select-all"
            @change="toggleAllDisplayedRows(($event.target as HTMLInputElement).checked)"
          />
          <span class="vxe-checkbox--icon" @click="toggleAllDisplayedRows(!allDisplayedRowsSelected)" />
        </template>
        <TableCoreHeaderCell
          v-else
          :title="column.title"
          :column-key="column.key"
          :test-id="column.dragTestId"
          :filter-test-id="column.filterTestId"
          :resize-test-id="column.resizeTestId"
          :resizable="column.resizable !== false"
          :filter-active="Boolean(column.filterActive)"
          :dragging="Boolean(column.dragging)"
          :drag-over="Boolean(column.dragOver)"
          @drag-start="startListColumnMouseDrag(column, $event)"
          @filter="openListColumnFilter(column, $event)"
          @resize-start="startResize(column, $event)"
        />
      </template>
      <template #cell="{ row, column }">
        <template v-if="column.key === '__selection'">
          <input
            :checked="isRowSelected(row)"
            type="checkbox"
            :data-testid="`list-select-${rowKey(row)}`"
            @change="toggleRowSelection(row, ($event.target as HTMLInputElement).checked)"
          />
          <span class="vxe-checkbox--icon" @click="toggleRowSelection(row, !isRowSelected(row))" />
        </template>
        <div v-else class="vxe-cell">
          <span v-if="column.key === 'status'" class="status-pill" :class="statusClass(row[column.key])">{{ row[column.key] }}</span>
          <button
            v-else-if="isOpenableDocumentList && column.key === 'billNo'"
            class="list-cell-link"
            type="button"
            :data-testid="`open-document-${cellValue(row, listColumnByKey(column.key))}`"
            @click.stop="openDocument(row)"
          >
            {{ cellValue(row, listColumnByKey(column.key)) }}
          </button>
          <span v-else>{{ cellValue(row, listColumnByKey(column.key)) }}</span>
        </div>
      </template>
      <template #overlay>
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
      </template>
      <template v-if="hasListSummary" #footer>
        <tr class="vxe-footer--row list-total-row" :data-testid="listSummaryRowTestId">
          <td
            v-for="column in listCoreColumns"
            :key="column.key"
            class="vxe-footer--column"
            :class="`col--align-${column.align || 'left'}`"
            :style="{ width: `${column.width ?? column.minWidth ?? 120}px`, minWidth: `${column.width ?? column.minWidth ?? 120}px`, maxWidth: `${column.width ?? column.minWidth ?? 120}px` }"
            :data-testid="listSummaryCellTestId(column.key)"
          >
            <div class="vxe-cell">{{ listSummaryFooterValue(column.key) }}</div>
          </td>
        </tr>
      </template>
    </TableCore>

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

    <ColumnSettingsDialog
      :open="columnDialogOpen"
      title="列设置"
      :columns="columns"
      dialog-test-id="column-settings-dialog"
      ok-test-id="column-settings-ok"
      @reset="resetColumnsToDefault"
      @confirm="closeColumnSettings"
    />

    <ColumnFilterPopover
      :open="filterDialogOpen && Boolean(activeFilterColumn)"
      :operators="filterOperators"
      :operator="activeFilterOperator"
      :value="activeFilterValue"
      :left="filterPopoverLeft"
      :top="filterPopoverTop"
      test-id="column-filter-dialog"
      @update:operator="activeFilterOperator = $event"
      @update:value="activeFilterValue = $event"
      @apply="applyColumnFilter"
      @clear="clearColumnFilter"
    />

    <div
      v-if="columnReorder.draggingKey.value"
      class="column-drag-ghost"
      :style="{ left: `${columnReorder.dragGhostLeft.value}px`, top: `${columnReorder.dragGhostTop.value}px` }"
      data-testid="column-drag-ghost"
    >
      {{ draggingColumnTitle }}
    </div>

    <div v-if="stockAlertSettingsOpen" class="modal-mask" data-testid="stock-alert-settings-dialog">
      <div class="dialog stock-alert-settings-dialog">
        <h3>安全库存设置</h3>
        <form class="stock-alert-settings-form" @submit.prevent="submitStockAlertSetting">
          <label>
            物料编码
            <input v-model="stockAlertSettingForm.productCode" data-testid="stock-alert-product-code" placeholder="如 CP-118" />
          </label>
          <label>
            仓库编码
            <input v-model="stockAlertSettingForm.warehouseCode" data-testid="stock-alert-warehouse-code" placeholder="如 CK-001" />
          </label>
          <label>
            最低安全量
            <input v-model="stockAlertSettingForm.safetyQty" type="number" step="0.0001" min="0" data-testid="stock-alert-safety-qty" />
          </label>
          <label>
            库存上限
            <input v-model="stockAlertSettingForm.maxQty" type="number" step="0.0001" min="0" data-testid="stock-alert-max-qty" />
          </label>
          <div class="dialog-actions">
            <button type="button" @click="stockAlertSettingsOpen = false">关闭</button>
            <button class="primary-action" type="submit" data-testid="stock-alert-save">保存</button>
          </div>
          <p v-if="stockAlertSettingsMessage" class="form-message" data-testid="stock-alert-settings-message">{{ stockAlertSettingsMessage }}</p>
        </form>
        <div class="stock-alert-settings-table">
          <table>
            <thead>
              <tr>
                <th>物料编码</th>
                <th>物料名称</th>
                <th>仓库</th>
                <th>最低安全量</th>
                <th>库存上限</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="setting in stockAlertSettings" :key="setting.id" :data-testid="`stock-alert-setting-${setting.productCode}-${setting.warehouseCode}`">
                <td>{{ setting.productCode }}</td>
                <td>{{ setting.productName }}</td>
                <td>{{ setting.warehouseName }}</td>
                <td>{{ setting.safetyQty }}</td>
                <td>{{ setting.maxQty || "-" }}</td>
                <td>
                  <button type="button" :data-testid="`stock-alert-edit-${setting.productCode}-${setting.warehouseCode}`" @click="editStockAlertSetting(setting)">编辑</button>
                  <button type="button" :data-testid="`stock-alert-delete-${setting.productCode}-${setting.warehouseCode}`" @click="removeStockAlertSetting(setting.id)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-if="pendingAction" class="modal-mask" data-testid="batch-confirm-dialog">
      <div class="dialog">
        <h3>操作确认</h3>
        <p>确定要{{ pendingAction }}已选中的 {{ selectedRows.length }} 条数据吗？</p>
        <label v-if="pendingActionRequiresReason" class="batch-confirm-field">
          原因
          <input v-model="pendingReason" data-testid="batch-action-reason" placeholder="请输入操作原因" />
        </label>
        <label v-if="pendingAction === '作废'" class="batch-confirm-field">
          当前账号
          <input v-model="pendingVoidUsername" data-testid="batch-void-username" placeholder="当前账号" />
        </label>
        <label v-if="pendingAction === '作废'" class="batch-confirm-field">
          密码
          <input v-model="pendingVoidPassword" data-testid="batch-void-password" type="password" placeholder="请输入密码确认" />
        </label>
        <p v-if="pendingActionMessage" class="form-message batch-confirm-message" data-testid="batch-action-message">{{ pendingActionMessage }}</p>
        <div class="dialog-actions">
          <button type="button" @click="closePendingAction">取消</button>
          <button class="danger-action" type="button" @click="submitPendingAction">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { useColumnReorder } from "./table/useColumnReorder";
import {
  deleteListPreset,
  deleteStockAlertSetting,
  exportListRows,
  fetchListPresets,
  fetchListRows,
  fetchStockAlertSettings,
  saveListPreset,
  saveStockAlertSetting,
  type StockAlertSetting,
  type ListFilterPreset
} from "../services/listApi";
import { lifecycleDocument, reverseDocument, voidDocumentHardened, type DocumentType } from "../services/documentApi";
import { getBillDefinitionByListKey } from "../modules/metadata/registry";
import { useMasterDataMaintenance } from "../modules/master-data/useMasterDataMaintenance";
import { useSessionStore } from "../stores/session";

interface ListColumn {
  field: string;
  title: string;
  width?: number;
  minWidth?: number;
  fixed?: "" | "left" | "right";
  locked?: boolean;
  reorderable?: boolean;
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

type OpenableDocumentType = "salesQuote" | "salesOrder" | "deliveryNotice" | "salesOut" | "purchaseOrder" | "purchaseIn" | "purchaseReturn" | "materialIssue" | "productIn" | "otherStockIn" | "otherStockOut" | "stockTransfer" | "stockCount" | "stockCountGain" | "stockCountLoss";

const props = defineProps<{
  listKey: string;
  locked?: boolean;
  lockedObjectId?: string;
}>();
const emit = defineEmits<{
  pushDownSalesOut: [row: Record<string, unknown>];
  pushDownPurchaseIn: [row: Record<string, unknown>];
  openDocument: [payload: { type: OpenableDocumentType; row: Record<string, unknown> }];
  createDocument: [payload: { type: OpenableDocumentType }];
  createMasterData: [payload: { listKey: string }];
  editMasterData: [payload: { listKey: string; row: Record<string, unknown> }];
}>();

const tableVersion = ref(0);
const loading = ref(false);
const listState = ref<"ready" | "empty" | "error" | "forbidden">("ready");
const stateMessage = ref("");
let reloadSerial = 0;
const filtersExpanded = ref(false);
const columnDialogOpen = ref(false);
const filterDialogOpen = ref(false);
const pendingAction = ref("");
const pendingReason = ref("");
const pendingVoidUsername = ref("");
const pendingVoidPassword = ref("");
const pendingActionMessage = ref("");
const batchMessage = ref("");
const rows = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const selectedRows = ref<Record<string, unknown>[]>([]);
const exportMessage = ref("");
const presetMessage = ref("");
const presetName = ref("");
const selectedPresetId = ref("");
const operationLogPresets = ref<ListFilterPreset[]>([]);
const stockAlertSettings = ref<StockAlertSetting[]>([]);
const stockAlertSettingsOpen = ref(false);
const stockAlertSettingsMessage = ref("");
const stockAlertSettingForm = reactive({
  productCode: "",
  warehouseCode: "",
  safetyQty: "",
  maxQty: ""
});
const activeFilterColumn = ref<ListColumn | null>(null);
const activeFilterOperator = ref("包含");
const activeFilterValue = ref("");
const columnFilters = reactive<Record<string, ColumnFilter>>({});
const columnFilterSnapshots = reactive<Record<string, Record<string, ColumnFilter>>>({});
const filterPopoverLeft = ref(0);
const filterPopoverTop = ref(0);
const columnPreferenceVersion = "v3";
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
    subtitle: "",
    keywordPlaceholder: "物料编码、名称、规格型号",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "物料编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "物料名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "category", title: "物料分类", width: 130, visible: true },
      { field: "unit", title: "主单位", width: 80, visible: true },
      { field: "isPurchase", title: "可采购", width: 86, visible: true },
      { field: "isSale", title: "可销售", width: 86, visible: true },
      { field: "isInventory", title: "可库存", width: 86, visible: true },
      { field: "isProduce", title: "可自制", width: 86, visible: true },
      { field: "isSubcontract", title: "可委外", width: 86, visible: true },
      { field: "defaultWarehouseCode", title: "默认仓库", width: 120, visible: true },
      { field: "defaultWorkshop", title: "默认生产车间", width: 140, visible: true },
      { field: "saleUnit", title: "销售单位", width: 90, visible: false },
      { field: "purchaseUnit", title: "采购单位", width: 90, visible: false },
      { field: "bomUnit", title: "生产/BOM单位", width: 120, visible: false },
      { field: "defaultSupplierCode", title: "默认供应商", width: 130, visible: false },
      { field: "issueWarehouseCode", title: "默认领料仓", width: 130, visible: false },
      { field: "issueMethod", title: "发料方式", width: 110, visible: false },
      { field: "taxRate", title: "税率(%)", width: 90, align: "right", visible: true },
      { field: "defaultSalePrice", title: "默认销售价", width: 120, align: "right", visible: true },
      { field: "minSalePrice", title: "最低销售价", width: 120, align: "right", visible: false },
      { field: "costPrice", title: "成本价", width: 110, align: "right", visible: false },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ]
  },
  "customer-master-list": {
    title: "客户",
    subtitle: "",
    keywordPlaceholder: "客户编码、客户名称、联系人",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "客户编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "客户名称", width: 220, visible: true },
      { field: "shortName", title: "客户简称", width: 130, visible: true },
      { field: "customerLevel", title: "客户等级", width: 110, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "region", title: "地区", width: 160, visible: true },
      { field: "taxNo", title: "税号", width: 160, visible: false },
      { field: "settlementMethod", title: "结算方式", width: 110, visible: true },
      { field: "creditLimit", title: "信用额度", width: 120, align: "right", visible: true },
      { field: "ownerName", title: "负责业务员", width: 120, visible: true },
      { field: "address", title: "地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "supplier-master-list": {
    title: "供应商",
    subtitle: "",
    keywordPlaceholder: "供应商编码、供应商名称",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "供应商编码", width: 150, fixed: "left", visible: true },
      { field: "name", title: "供应商名称", width: 220, visible: true },
      { field: "shortName", title: "供应商简称", width: 140, visible: true },
      { field: "supplierLevel", title: "供应商等级", width: 120, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "settlementMethod", title: "结算方式", width: 110, visible: true },
      { field: "ownerName", title: "采购负责人", width: 120, visible: true },
      { field: "taxNo", title: "税号", width: 160, visible: false },
      { field: "bankAccount", title: "银行账号", width: 180, visible: false },
      { field: "address", title: "地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
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
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "outStatus", title: "出库状态", width: 110, visible: true },
      { field: "qty", title: "数量", width: 110, align: "right", visible: true },
      { field: "shippedQty", title: "已出库数量", width: 120, align: "right", visible: true },
      { field: "remainingQty", title: "未出库数量", width: 120, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "sales-quote-form-list": {
    title: "销售报价单列表",
    subtitle: "销售报价单保存客户报价，审核且有效期内可作为销售订单选源单依据。",
    keywordPlaceholder: "单据编号、客户、商品",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "validUntil", title: "报价有效期", width: 130, visible: true },
      { field: "validStatus", title: "有效状态", width: 110, visible: true },
      { field: "amount", title: "报价金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
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
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "inStatus", title: "入库状态", width: 110, visible: true },
      { field: "qty", title: "数量", width: 110, align: "right", visible: true },
      { field: "receivedQty", title: "已入库数量", width: 120, align: "right", visible: true },
      { field: "remainingQty", title: "未入库数量", width: 120, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "owner", title: "经办人", width: 120, visible: true }
    ]
  },
  "purchase-return-form-list": {
    title: "采购退货单",
    subtitle: "采购退货单从已审核采购入库单选源，审核后扣减库存。",
    keywordPlaceholder: "单据编号、供应商、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "qty", title: "退货数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "sourceBillNo", title: "源采购入库单", width: 170, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
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
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "qty", title: "入库数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
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
      { field: "supplierCode", title: "供应商编码", width: 130, visible: true },
      { field: "supplier", title: "供应商", width: 220, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "qty", title: "入库数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "purchase-summary-report": {
    title: "采购汇总表",
    subtitle: "按供应商和物料汇总采购订单、入库、退货与净采购金额。",
    keywordPlaceholder: "供应商、物料编码、物料名称",
    statuses: ["全部"],
    columns: [
      { field: "supplierCode", title: "供应商编码", width: 130, fixed: "left", visible: true },
      { field: "supplier", title: "供应商", width: 200, visible: true },
      { field: "productCode", title: "物料编码", width: 140, visible: true },
      { field: "productName", title: "物料名称", width: 200, visible: true },
      { field: "orderQty", title: "订单数量", width: 110, align: "right", visible: true },
      { field: "inQty", title: "入库数量", width: 110, align: "right", visible: true },
      { field: "returnQty", title: "退货数量", width: 110, align: "right", visible: true },
      { field: "remainingQty", title: "未入库数量", width: 120, align: "right", visible: true },
      { field: "orderAmount", title: "订单金额", width: 120, align: "right", visible: true },
      { field: "inAmount", title: "入库金额", width: 120, align: "right", visible: true },
      { field: "returnAmount", title: "退货金额", width: 120, align: "right", visible: true },
      { field: "netPurchaseAmount", title: "净采购含税金额", width: 150, align: "right", visible: true }
    ]
  },
  "delivery-notice-form-list": {
    title: "发货通知单",
    subtitle: "发货通知单读取真实单据，审核后锁定库存，不扣减现存量。",
    keywordPlaceholder: "单据编号、客户、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billNo", title: "单据编号", width: 150, fixed: "left", visible: true },
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "sourceBillNo", title: "源销售订单", width: 160, visible: true },
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
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
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
      { field: "customerCode", title: "客户编码", width: 120, visible: true },
      { field: "customer", title: "客户名称", width: 200, visible: true },
      { field: "billDate", title: "单据日期", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true },
      { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
      { field: "remark", title: "整单备注", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true }
    ]
  },
  "inventory-query-list": {
    title: "库存查询",
    subtitle: "库存查询只展示数据库余额口径的现存量和可用量，不做业务结果缓存。",
    keywordPlaceholder: "物料编码、物料名称、仓库",
    statuses: ["正常", "低库存"],
    columns: [
      { field: "code", title: "物料编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "物料名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "onHand", title: "现存量", width: 110, align: "right", visible: true },
      { field: "available", title: "可用量", width: 110, align: "right", visible: true },
      { field: "status", title: "状态", width: 100, visible: true }
    ]
  },
  "stock-alert-list": {
    title: "库存预警查询表",
    subtitle: "按商品与仓库的安全库存阈值直查当前库存余额，低于安全库存或高于上限时进入预警列表。",
    keywordPlaceholder: "物料编码、物料名称、仓库",
    statuses: ["低于安全库存", "高于库存上限"],
    columns: [
      { field: "productCode", title: "物料编码", width: 140, fixed: "left", visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "productCategory", title: "商品类别", width: 130, visible: true },
      { field: "warehouseName", title: "仓库名称", width: 140, visible: true },
      { field: "spec", title: "规格型号", width: 160, visible: true },
      { field: "unit", title: "基本单位", width: 90, visible: true },
      { field: "available", title: "可用量", width: 100, align: "right", visible: true },
      { field: "safetyQty", title: "最低安全量", width: 120, align: "right", visible: true },
      { field: "maxQty", title: "库存上限", width: 110, align: "right", visible: true },
      { field: "diffQty", title: "预警差量", width: 110, align: "right", visible: true },
      { field: "status", title: "安全库存状况", width: 140, visible: true }
    ]
  },
  "warehouse-master-list": {
    title: "仓库",
    subtitle: "",
    keywordPlaceholder: "仓库编码、仓库名称",
    statuses: ["启用", "禁用"],
    columns: [
      { field: "code", title: "仓库编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "仓库名称", width: 220, visible: true },
      { field: "warehouseType", title: "仓库类型", width: 110, visible: true },
      { field: "stockPolicy", title: "库存策略", width: 150, visible: true },
      { field: "manager", title: "仓管员", width: 110, visible: true },
      { field: "phone", title: "联系电话", width: 140, visible: true },
      { field: "address", title: "仓库地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
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
      { field: "customer", title: "客户名称", width: 220, visible: true },
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
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
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
    keywordPlaceholder: "单据编号、物料编码、物料名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
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
    keywordPlaceholder: "单据编号、物料编码、物料名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
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
    keywordPlaceholder: "单据编号、物料编码、物料名称、源仓、目标仓",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "sourceWarehouse", title: "源仓库", width: 140, visible: true },
      { field: "targetWarehouse", title: "目标仓库", width: 140, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "qty", title: "数量", width: 100, align: "right", visible: true }
    ]
  },
  "stock-count-form-list": {
    title: "盘点单列表",
    subtitle: "盘点单展示系统库存、实盘数量和差异，审核后生成盘盈/盘亏草稿。",
    keywordPlaceholder: "单据编号、物料编码、物料名称、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "businessType", title: "业务类型", width: 120, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "department", title: "部门", width: 120, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
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
    keywordPlaceholder: "单据编号、源盘点单、物料编码、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "sourceBillNo", title: "源盘点单", width: 180, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "qty", title: "盘盈数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true }
    ]
  },
  "stock-count-loss-form-list": {
    title: "盘亏单列表",
    subtitle: "盘亏单按库存业务列表范式展示，审核后减少库存数量。",
    keywordPlaceholder: "单据编号、源盘点单、物料编码、仓库",
    statuses: ["草稿", "已审核", "已反审核", "已作废"],
    columns: [
      { field: "billDate", title: "单据日期", width: 120, visible: true },
      { field: "billNo", title: "单据编号", width: 220, visible: true },
      { field: "sourceBillNo", title: "源盘点单", width: 180, visible: true },
      { field: "status", title: "审核状态", width: 100, visible: true },
      { field: "productCode", title: "物料编码", width: 130, visible: true },
      { field: "productName", title: "物料名称", width: 180, visible: true },
      { field: "warehouse", title: "仓库", width: 140, visible: true },
      { field: "qty", title: "盘亏数量", width: 110, align: "right", visible: true },
      { field: "amount", title: "金额", width: 120, align: "right", visible: true }
    ]
  },
  "bom-list": {
    title: "BOM维护",
    subtitle: "BOM 维护展示成品、基准数量和启用状态，明细由后端 BOM 接口维护。",
    keywordPlaceholder: "BOM编码、物料编码、物料名称",
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

const billDefinition = computed(() => getBillDefinitionByListKey(props.listKey));
const definition = computed(() => {
  const metadataDefinition = billDefinition.value;
  if (metadataDefinition) {
    return {
      title: `${metadataDefinition.title}列表`,
      subtitle: metadataDefinition.subtitle,
      keywordPlaceholder: metadataDefinition.keywordPlaceholder,
      statuses: metadataDefinition.statuses,
      columns: metadataDefinition.listViews.header
    };
  }
  return definitions[props.listKey] ?? fallbackDefinition;
});
function detailColumnsForList(): ListColumn[] {
  if (props.listKey === "purchase-summary-report") {
    return definition.value.columns.map((column) => ({ ...column }));
  }
  const metadataDefinition = billDefinition.value;
  if (metadataDefinition) {
    return metadataDefinition.listViews.detail.map((column) => ({ ...column }));
  }
  const isPurchase = props.listKey.includes("purchase");
  const isSales = ["sales-quote-form-list", "sales-order-form-list", "delivery-notice-form-list", "sales-out-list", "sales-out-form-list"].includes(props.listKey);
  const showsSourceColumns = [
    "sales-order-form-list",
    "delivery-notice-form-list",
    "sales-out-list",
    "sales-out-form-list",
    "purchase-in-list",
    "purchase-in-form-list",
    "purchase-return-form-list"
  ].includes(props.listKey);
  const partyCodeColumn: ListColumn[] = isPurchase || isSales
    ? [{ field: isPurchase ? "supplierCode" : "customerCode", title: isPurchase ? "供应商编码" : "客户编码", width: 120, visible: true }]
    : [];
  const customerOnlyColumns: ListColumn[] = isSales
    ? [
        { field: "customerMaterialCode", title: "客户物料编码", width: 150, visible: true },
        { field: "customerOrderNo", title: "客户订单号", width: 150, visible: true },
        { field: "planDeliveryDate", title: "预计交期", width: 120, visible: true }
      ]
    : [];
  const sourceColumns: ListColumn[] = showsSourceColumns
    ? [
        { field: "sourceBillNo", title: "源单号", width: 170, visible: true },
        { field: "sourceLineNo", title: "源行号", width: 90, align: "right", visible: true }
      ]
    : [];
  return [
    { field: "billNo", title: "单据编号", width: 170, fixed: "left", visible: true },
    ...partyCodeColumn,
    { field: "partner", title: isPurchase ? "供应商" : "客户名称", width: 180, visible: true },
    ...customerOnlyColumns.slice(0, 2),
    { field: "billDate", title: "单据日期", width: 120, visible: true },
    ...customerOnlyColumns.slice(2),
    { field: "status", title: "审核状态", width: 100, visible: true },
    { field: "lineNo", title: "行号", width: 80, align: "right", visible: true },
    { field: "productCode", title: "物料编码", width: 130, visible: true },
    { field: "productName", title: "物料名称", width: 180, visible: true },
    { field: "spec", title: "规格型号", width: 150, visible: true },
    { field: "warehouse", title: "仓库", width: 150, visible: true },
    { field: "qty", title: "数量", width: 110, align: "right", visible: true },
    ...(props.listKey === "sales-order-form-list" ? [
      { field: "shippedQty", title: "已出库数量", width: 120, align: "right", visible: true },
      { field: "remainingQty", title: "未出库数量", width: 120, align: "right", visible: true }
    ] satisfies ListColumn[] : []),
    ...(props.listKey === "purchase-order-form-list" ? [
      { field: "receivedQty", title: "已入库数量", width: 120, align: "right", visible: true },
      { field: "remainingQty", title: "未入库数量", width: 120, align: "right", visible: true }
    ] satisfies ListColumn[] : []),
    { field: "unitPrice", title: "单价", width: 120, align: "right", visible: true },
    { field: "taxInclusiveUnitPrice", title: "含税单价", width: 120, align: "right", visible: true },
    { field: "amount", title: "金额", width: 120, align: "right", visible: true },
    { field: "priceTaxTotal", title: "含税金额", width: 120, align: "right", visible: true },
    { field: "lineRemark", title: "行备注", width: 180, visible: true },
    ...sourceColumns
  ];
}
const session = useSessionStore();
const masterMaintenance = useMasterDataMaintenance(computed(() => props.listKey), rows, selectedRows, reload);
const isMasterList = masterMaintenance.isMasterList;
const isSalesOrderList = computed(() => props.listKey === "sales-order-form-list");
const isPurchaseOrderList = computed(() => props.listKey === "purchase-order-form-list");
const isOperationLogList = computed(() => props.listKey === "operation-log-list");
const isStockAlertList = computed(() => props.listKey === "stock-alert-list");
const isDetailView = ref(false);
const auditPermissionByListKey: Partial<Record<string, string>> = {
  "sales-quote-form-list": "sales.order.audit",
  "sales-order-form-list": "sales.order.audit",
  "delivery-notice-form-list": "sales.out.audit",
  "sales-out-list": "sales.out.audit",
  "sales-out-form-list": "sales.out.audit",
  "purchase-order-form-list": "purchase.order.audit",
  "purchase-in-list": "purchase.in.audit",
  "purchase-in-form-list": "purchase.in.audit",
  "purchase-return-form-list": "purchase.return.audit",
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
  "sales-quote-form-list": "sales.order.audit",
  "sales-order-form-list": "sales.order.audit",
  "delivery-notice-form-list": "sales.out.audit",
  "sales-out-list": "sales.out.audit",
  "sales-out-form-list": "sales.out.audit",
  "purchase-order-form-list": "purchase.order.audit",
  "purchase-in-list": "purchase.in.audit",
  "purchase-in-form-list": "purchase.in.audit",
  "purchase-return-form-list": "purchase.return.audit",
  "material-issue-form-list": "production.document.audit",
  "product-in-form-list": "production.document.audit",
  "other-in-form-list": "inventory.other_stock_in.audit",
  "other-out-form-list": "inventory.other_stock_out.audit",
  "stock-transfer-form-list": "inventory.stock_transfer.audit",
  "stock-count-form-list": "inventory.stock_count.audit",
  "stock-count-gain-form-list": "inventory.stock_count_gain.audit",
  "stock-count-loss-form-list": "inventory.stock_count_loss.audit",
  "stock-alert-list": "inventory.stock_alert.manage"
};
const canAuditCurrentList = computed(() => !isDetailView.value && session.hasPermission(auditPermissionByListKey[props.listKey]));
const canMaintainCurrentList = computed(() => !isDetailView.value && session.hasPermission(maintainPermissionByListKey[props.listKey]));
const canMaintainStockAlert = computed(() => session.hasPermission("inventory.stock_alert.manage"));
const documentOpenTypeByListKey: Partial<Record<string, OpenableDocumentType>> = {
  "sales-quote-form-list": "salesQuote",
  "sales-order-form-list": "salesOrder",
  "delivery-notice-form-list": "deliveryNotice",
  "sales-out-list": "salesOut",
  "sales-out-form-list": "salesOut",
  "purchase-order-form-list": "purchaseOrder",
  "purchase-in-list": "purchaseIn",
  "purchase-in-form-list": "purchaseIn",
  "purchase-return-form-list": "purchaseReturn",
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
const supportsDetailView = computed(() => isOpenableDocumentList.value);
const isReverseableDocumentList = computed(() => Boolean(documentActionTypeByListKey[props.listKey]));
const isLifecycleDocumentList = computed(() => Boolean(documentActionTypeByListKey[props.listKey]) && !isDetailView.value);
const selectedBillRows = computed(() => selectedRows.value.filter((row) => String(row.billNo ?? "").trim()));
const canOperateLifecycle = computed(() => canMaintainCurrentList.value && selectedBillRows.value.length > 0 && !selectedContainsLockedRow.value);
const canBatchClose = computed(() => canOperateLifecycle.value && selectedBillRows.value.every((row) => isAuditedRow(row) && row.closeStatus !== "CLOSED" && row.frozenStatus !== "FROZEN"));
const canBatchUnclose = computed(() => canOperateLifecycle.value && selectedBillRows.value.every((row) => row.closeStatus === "CLOSED"));
const canBatchFreeze = computed(() => canOperateLifecycle.value && selectedBillRows.value.every((row) => isAuditedRow(row) && row.frozenStatus !== "FROZEN" && row.closeStatus !== "CLOSED"));
const canBatchUnfreeze = computed(() => canOperateLifecycle.value && selectedBillRows.value.every((row) => row.frozenStatus === "FROZEN"));
const canBatchVoid = computed(() => canOperateLifecycle.value && selectedBillRows.value.every((row) => row.status === "草稿"));
const pendingActionRequiresReason = computed(() => ["关闭", "冻结", "作废"].includes(pendingAction.value));
const canPushDownSalesOut = computed(() => {
  const row = selectedRows.value[0];
  return Boolean(
    isSalesOrderList.value &&
    session.hasPermission("sales.out.audit") &&
    selectedRows.value.length === 1 &&
    row?.status === "已审核" &&
    row?.closeStatus !== "CLOSED" &&
    row?.frozenStatus !== "FROZEN" &&
    row?.outStatus !== "全部出库"
  );
});
const canPushDownPurchaseIn = computed(() => {
  const row = selectedRows.value[0];
  return Boolean(
    isPurchaseOrderList.value &&
    session.hasPermission("purchase.in.audit") &&
    selectedRows.value.length === 1 &&
    row?.status === "已审核" &&
    row?.closeStatus !== "CLOSED" &&
    row?.frozenStatus !== "FROZEN" &&
    row?.inStatus !== "全部入库"
  );
});
const columns = ref<ListColumn[]>([]);
const visibleColumns = computed(() => columns.value.filter((column) => column.visible));
const displayedRows = computed(() => rows.value);
const listSummaryFields = new Map<string, number>([
  ["qty", 4],
  ["shippedQty", 4],
  ["receivedQty", 4],
  ["orderQty", 4],
  ["inQty", 4],
  ["returnQty", 4],
  ["remainingQty", 4],
  ["amount", 2],
  ["priceTaxTotal", 2],
  ["orderAmount", 2],
  ["inAmount", 2],
  ["returnAmount", 2],
  ["netPurchaseAmount", 2]
]);
const hasListSummary = computed(() => visibleColumns.value.some((column) => listSummaryFields.has(column.field)));
const listSummaryTotals = computed(() => Object.fromEntries(
  [...listSummaryFields.entries()].map(([field, maxDecimals]) => [field, sumDisplayedRows(field, maxDecimals)])
) as Record<string, string>);
const listSummaryRowTestId = computed(() => isSalesOrderList.value ? "sales-order-list-summary-row" : "list-summary-row");
const allDisplayedRowsSelected = computed(() => displayedRows.value.length > 0 && displayedRows.value.every((row) => isRowSelected(row)));
const selectedPreset = computed(() => operationLogPresets.value.find((preset) => preset.id === selectedPresetId.value));
const selectedContainsLockedRow = computed(() => false);
const columnReorder = useColumnReorder<ListColumn>({
  getColumns: () => columns.value,
  setColumns: (nextColumns) => {
    columns.value = nextColumns;
    tableVersion.value += 1;
  },
  getKey: (column) => column.field,
  getTitle: (column) => column.title,
  normalize: normalizeListColumns,
  onReorder: () => {
    saveColumnPreferences();
    void syncRenderedColumnWidths();
  }
});
const draggingColumnTitle = columnReorder.draggingTitle;
const listTableMinWidth = computed(() => {
  const utilityColumnsWidth = 42;
  const contentWidth = visibleColumns.value.reduce((sum, column) => sum + (column.width ?? column.minWidth ?? 120), utilityColumnsWidth);
  return Math.max(contentWidth, 960);
});
const listCoreColumns = computed<TableCoreColumn[]>(() => [
  {
    key: "__selection",
    title: "",
    width: 42,
    minWidth: 42,
    fixed: "left",
    filterable: false,
    resizable: false,
    headerClass: "vxe-header--column list-checkbox-column col--fixed col--checkbox",
    cellClass: "vxe-body--column list-checkbox-column col--fixed col--checkbox"
  },
  ...visibleColumns.value.map((column) => ({
    key: column.field,
    title: column.title,
    width: column.width ?? column.minWidth ?? 120,
    minWidth: column.minWidth ?? 70,
    align: column.align,
    filterable: true,
    resizable: true,
    filterActive: Boolean(columnFilters[column.field]?.value),
    dragging: columnReorder.draggingKey.value === column.field,
    dragOver: columnReorder.dragOverKey.value === column.field,
    dragTestId: `column-drag-${column.field}`,
    filterTestId: `column-filter-${column.field}`,
    resizeTestId: `column-resize-${column.field}`,
    headerClass: "vxe-header--column",
    cellClass: "vxe-body--column"
  }))
]);

const documentActionTypeByListKey: Partial<Record<string, DocumentType>> = {
  "sales-quote-form-list": "salesQuote",
  "sales-order-form-list": "salesOrder",
  "delivery-notice-form-list": "deliveryNotice",
  "sales-out-list": "salesOut",
  "sales-out-form-list": "salesOut",
  "purchase-order-form-list": "purchaseOrder",
  "purchase-in-list": "purchaseIn",
  "purchase-in-form-list": "purchaseIn",
  "purchase-return-form-list": "purchaseReturn",
  "material-issue-form-list": "materialIssue",
  "product-in-form-list": "productIn",
  "other-in-form-list": "otherStockIn",
  "other-out-form-list": "otherStockOut",
  "stock-transfer-form-list": "stockTransfer",
  "stock-count-form-list": "stockCount",
  "stock-count-gain-form-list": "stockCountGain",
  "stock-count-loss-form-list": "stockCountLoss"
};

watch(() => props.listKey, () => {
  isDetailView.value = false;
  resetColumns();
  resetQuery(false);
  replaceColumnFilters({});
  selectedRows.value = [];
  rows.value = [];
  total.value = 0;
  void loadOperationLogPresets(true);
  void reload();
}, { immediate: false });

onMounted(() => {
  resetColumns();
  resetQuery(false);
  void loadOperationLogPresets(true);
  reload();
});

function resetColumns() {
  const defaults = (isDetailView.value ? detailColumnsForList() : definition.value.columns).map((column) => ({ ...column }));
  const saved = loadColumnPreferences();
  if (!saved.length || !isValidColumnPreference(saved, defaults)) {
    columns.value = normalizeListColumns(defaults);
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
      reorderable: savedColumn.reorderable ?? current.reorderable,
      locked: savedColumn.locked ?? current.locked,
      visible: savedColumn.visible
    });
  });
  columns.value = normalizeListColumns(mergeSavedColumnsWithDefaults(restored, defaults));
}

function mergeSavedColumnsWithDefaults(restored: ListColumn[], defaults: ListColumn[]) {
  const restoredFields = new Set(restored.map((column) => column.field));
  const defaultIndexByField = new Map(defaults.map((column, index) => [column.field, index]));
  const merged = [...restored];
  defaults.forEach((defaultColumn, defaultIndex) => {
    if (restoredFields.has(defaultColumn.field)) {
      return;
    }
    let insertAt = -1;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const currentDefaultIndex = defaultIndexByField.get(merged[index].field);
      if (currentDefaultIndex != null && currentDefaultIndex < defaultIndex) {
        insertAt = index + 1;
        break;
      }
    }
    if (insertAt === -1) {
      const nextDefaultIndex = merged.findIndex((column) => {
        const currentDefaultIndex = defaultIndexByField.get(column.field);
        return currentDefaultIndex != null && currentDefaultIndex > defaultIndex;
      });
      insertAt = nextDefaultIndex === -1 ? merged.length : nextDefaultIndex;
    }
    merged.splice(insertAt, 0, defaultColumn);
    restoredFields.add(defaultColumn.field);
  });
  return merged;
}

async function reload() {
  const serial = ++reloadSerial;
  const listKey = props.listKey;
  const view = isDetailView.value ? "detail" : "header";
  const filters = snapshotColumnFilters();
  exportMessage.value = "";
  loading.value = true;
  listState.value = "ready";
  stateMessage.value = "";
  selectedRows.value = [];
  rows.value = [];
  total.value = 0;
  const response = await fetchListRows(listKey, { ...query, view, columnFilters: filters });
  if (serial !== reloadSerial || listKey !== props.listKey || view !== (isDetailView.value ? "detail" : "header")) {
    return;
  }
  if (response.ok && response.data) {
    rows.value = response.data.rows.map(normalizeListRow);
    total.value = response.data.total;
    listState.value = response.data.rows.length ? "ready" : "empty";
    tableVersion.value += 1;
    void syncRenderedColumnWidths();
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
  const result = await exportListRows(props.listKey, { ...query, view: isDetailView.value ? "detail" : "header", columnFilters });
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

async function openStockAlertSettings() {
  stockAlertSettingsOpen.value = true;
  stockAlertSettingsMessage.value = "";
  await loadStockAlertSettings();
}

async function loadStockAlertSettings() {
  const result = await fetchStockAlertSettings();
  stockAlertSettings.value = result.data;
  if (!result.ok) {
    stockAlertSettingsMessage.value = result.message;
  }
}

async function submitStockAlertSetting() {
  const safetyQty = Number(stockAlertSettingForm.safetyQty);
  const maxQty = stockAlertSettingForm.maxQty === "" ? null : Number(stockAlertSettingForm.maxQty);
  if (!stockAlertSettingForm.productCode.trim() || !stockAlertSettingForm.warehouseCode.trim() || !Number.isFinite(safetyQty)) {
    stockAlertSettingsMessage.value = "请填写物料编码、仓库编码和最低安全量。";
    return;
  }
  if (maxQty !== null && !Number.isFinite(maxQty)) {
    stockAlertSettingsMessage.value = "库存上限必须是数字。";
    return;
  }
  const result = await saveStockAlertSetting({
    productCode: stockAlertSettingForm.productCode.trim(),
    warehouseCode: stockAlertSettingForm.warehouseCode.trim(),
    safetyQty,
    maxQty
  });
  if (!result.ok) {
    stockAlertSettingsMessage.value = result.message;
    return;
  }
  stockAlertSettingsMessage.value = "安全库存设置已保存";
  await loadStockAlertSettings();
  await reload();
}

function editStockAlertSetting(setting: StockAlertSetting) {
  stockAlertSettingForm.productCode = setting.productCode;
  stockAlertSettingForm.warehouseCode = setting.warehouseCode;
  stockAlertSettingForm.safetyQty = setting.safetyQty;
  stockAlertSettingForm.maxQty = setting.maxQty ?? "";
}

async function removeStockAlertSetting(id: string) {
  const result = await deleteStockAlertSetting(id);
  if (!result.ok) {
    stockAlertSettingsMessage.value = result.message;
    return;
  }
  stockAlertSettingsMessage.value = "安全库存设置已删除";
  await loadStockAlertSettings();
  await reload();
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

function columnFilterSnapshotKey() {
  return `${props.listKey}:${isDetailView.value ? "detail" : "header"}`;
}

function persistCurrentColumnFilters() {
  columnFilterSnapshots[columnFilterSnapshotKey()] = snapshotColumnFilters();
}

function restoreCurrentColumnFilters() {
  const defaults = isDetailView.value ? detailColumnsForList() : definition.value.columns;
  const allowedFields = new Set(defaults.map((column) => column.field));
  const saved = columnFilterSnapshots[columnFilterSnapshotKey()] ?? {};
  replaceColumnFilters(Object.fromEntries(Object.entries(saved).filter(([field]) => allowedFields.has(field))));
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

function toggleDetailView() {
  persistCurrentColumnFilters();
  isDetailView.value = !isDetailView.value;
  query.page = 1;
  selectedRows.value = [];
  restoreCurrentColumnFilters();
  resetColumns();
  reload();
}

function goPage(page: number) {
  query.page = page;
  reload();
}

function rowKey(row: Record<string, unknown>) {
  return String(row.id ?? row.billNo ?? row.bill_no ?? JSON.stringify(row));
}

function isRowSelected(row: Record<string, unknown>) {
  const key = rowKey(row);
  return selectedRows.value.some((selected) => rowKey(selected) === key);
}

function toggleRowSelection(row: Record<string, unknown>, checked: boolean) {
  const key = rowKey(row);
  selectedRows.value = checked
    ? [...selectedRows.value.filter((selected) => rowKey(selected) !== key), row]
    : selectedRows.value.filter((selected) => rowKey(selected) !== key);
}

function toggleAllDisplayedRows(checked: boolean) {
  selectedRows.value = checked ? [...displayedRows.value] : [];
}

function statusClass(value: unknown) {
  const status = String(value ?? "");
  return {
    draft: status === "草稿",
    audited: ["已审核", "成功", "启用", "正常", "已核销"].includes(status),
    reversed: ["已反审核", "部分核销"].includes(status),
    warning: ["低库存", "未核销", "高于库存上限"].includes(status),
    danger: ["已作废", "已红冲", "失败", "禁用", "低于安全库存"].includes(status)
  };
}

function confirmAction(action: string) {
  pendingAction.value = action;
  pendingReason.value = "";
  pendingVoidPassword.value = "";
  pendingActionMessage.value = "";
  pendingVoidUsername.value = "admin";
}

async function submitPendingAction() {
  const action = pendingAction.value;
  pendingActionMessage.value = "";
  if (pendingActionRequiresReason.value && !pendingReason.value.trim()) {
    pendingActionMessage.value = "请填写操作原因。";
    return;
  }
  if (action === "作废" && (!pendingVoidUsername.value.trim() || !pendingVoidPassword.value)) {
    pendingActionMessage.value = "作废需要当前账号和密码确认。";
    return;
  }
  const reason = pendingReason.value.trim();
  const voidUsername = pendingVoidUsername.value.trim();
  const voidPassword = pendingVoidPassword.value;
  closePendingAction();
  if (action === "反审核") {
    await submitBatchReverse();
    return;
  }
  if (["关闭", "反关闭", "冻结", "解冻"].includes(action)) {
    await submitBatchLifecycle(action, reason);
    return;
  }
  if (action === "作废") {
    await submitBatchVoid(reason, voidUsername, voidPassword);
    return;
  }
  batchMessage.value = `${action}已确认，当前批次只接入反审核实际提交。`;
}

function closePendingAction() {
  pendingAction.value = "";
  pendingReason.value = "";
  pendingVoidUsername.value = "";
  pendingVoidPassword.value = "";
  pendingActionMessage.value = "";
}

async function submitBatchReverse() {
  const type = documentActionTypeByListKey[props.listKey];
  const targets = selectedRows.value
    .filter(isAuditedRow)
    .map((row) => String(row.billNo ?? ""))
    .filter(Boolean);
  if (!type || targets.length === 0) {
    batchMessage.value = "请选择已审核单据再反审核。";
    return;
  }
  const results = await Promise.all(targets.map((billNo) => reverseDocument(type, billNo)));
  const failed = results.filter((result) => !result.ok);
  batchMessage.value = failed.length
    ? `反审核完成 ${targets.length - failed.length}/${targets.length}，失败：${failed[0]?.message || "请检查下游单据约束"}`
    : `已反审核 ${targets.length} 张单据，状态回到草稿。`;
  await reload();
}

async function submitBatchLifecycle(action: string, reasonInput: string) {
  const type = documentActionTypeByListKey[props.listKey];
  const actionMap = {
    "关闭": "close",
    "反关闭": "unclose",
    "冻结": "freeze",
    "解冻": "unfreeze"
  } as const;
  const apiAction = actionMap[action as keyof typeof actionMap];
  const targets = selectedBillRows.value.map((row) => String(row.billNo));
  if (!type || !apiAction || targets.length === 0) {
    batchMessage.value = `请选择可${action}的单据。`;
    return;
  }
  const reason = reasonInput || `列表批量${action}`;
  const results = await Promise.all(targets.map((billNo) => lifecycleDocument(type, billNo, apiAction, reason)));
  const failed = results.filter((result) => !result.ok);
  batchMessage.value = failed.length
    ? `${action}完成 ${targets.length - failed.length}/${targets.length}，失败：${failed[0]?.message || "请检查单据状态"}`
    : `已${action} ${targets.length} 张单据。`;
  await reload();
}

async function submitBatchVoid(reason: string, username: string, password: string) {
  const type = documentActionTypeByListKey[props.listKey];
  const targets = selectedBillRows.value.map((row) => String(row.billNo));
  if (!type || targets.length === 0) {
    batchMessage.value = "请选择可作废的草稿单据。";
    return;
  }
  const payload = {
    reason,
    username,
    password
  };
  const results = await Promise.all(targets.map((billNo) => voidDocumentHardened(type, billNo, payload)));
  const failed = results.filter((result) => !result.ok);
  batchMessage.value = failed.length
    ? `作废完成 ${targets.length - failed.length}/${targets.length}，失败：${failed[0]?.message || "请检查账号密码或下游约束"}`
    : `已作废 ${targets.length} 张单据。`;
  await reload();
}

function isAuditedRow(row: Record<string, unknown>) {
  return row.status === "已审核";
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
  if (openableDocumentType.value) {
    emit("openDocument", { type: openableDocumentType.value, row });
  }
}

function openCreateDialog() {
  if (isMasterList.value) {
    emit("createMasterData", { listKey: props.listKey });
    return;
  }
  if (openableDocumentType.value) {
    emit("createDocument", { type: openableDocumentType.value });
  }
}

function openEditDialog() {
  const row = selectedRows.value[0];
  if (isMasterList.value && row) {
    emit("editMasterData", { listKey: props.listKey, row });
  }
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
  filterPopoverTop.value = Math.min(rect.bottom + 4, window.innerHeight - 260);
  filterDialogOpen.value = true;
}

function listColumnByKey(key: string) {
  return columns.value.find((column) => column.field === key) ?? {
    field: key,
    title: key,
    width: 120,
    visible: true
  };
}

function listCellTitle(row: Record<string, unknown>, column: TableCoreColumn) {
  if (column.key === "__selection") {
    return undefined;
  }
  return String(cellValue(row, listColumnByKey(column.key)));
}

function startListColumnMouseDrag(column: TableCoreColumn, event: MouseEvent) {
  const listColumn = columns.value.find((item) => item.field === column.key);
  if (listColumn) {
    columnReorder.start(listColumn, event);
  }
}

function openListColumnFilter(column: TableCoreColumn, event: MouseEvent) {
  const listColumn = columns.value.find((item) => item.field === column.key);
  if (listColumn) {
    openColumnFilter(listColumn, event);
  }
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

function resizeListColumn({ column, width }: { column: TableCoreColumn; width: number }) {
  const target = columns.value.find((item) => item.field === column.key);
  if (target) {
    target.width = Math.max(target.minWidth ?? 70, width);
  }
}

function finishListColumnResize({ column, width }: { column: TableCoreColumn; width: number }) {
  resizeListColumn({ column, width });
  if (column.key !== "__selection") {
    saveColumnPreferences();
    tableVersion.value += 1;
  }
}

function closeColumnSettings() {
  saveColumnPreferences();
  columnDialogOpen.value = false;
  void syncRenderedColumnWidths();
}

function resetColumnsToDefault() {
  localStorage.removeItem(columnPreferenceKey());
  columns.value = normalizeListColumns((isDetailView.value ? detailColumnsForList() : definition.value.columns).map((column) => ({ ...column })));
  tableVersion.value += 1;
  void syncRenderedColumnWidths();
}

function columnPreferenceKey() {
  return `jdy:list-columns:${columnPreferenceVersion}:${props.listKey}:${isDetailView.value ? "detail" : "header"}`;
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
    reorderable: column.reorderable,
    locked: column.locked,
    visible: column.visible
  }));
  localStorage.setItem(columnPreferenceKey(), JSON.stringify(preference));
}

function isValidColumnPreference(saved: ListColumn[], defaults: ListColumn[]) {
  const defaultFields = new Set(defaults.map((column) => column.field));
  const defaultVisibleCount = defaults.filter((column) => column.visible).length;
  const matched = saved.filter((column) => defaultFields.has(column.field));
  const visibleMatched = matched.filter((column) => column.visible !== false);
  if (!matched.length) {
    return false;
  }
  if (defaultVisibleCount >= 3 && visibleMatched.length <= 1) {
    return false;
  }
  return true;
}

function normalizeListRow(row: Record<string, unknown>) {
  if ((row.billNo == null || row.billNo === "") && typeof row.bill_no === "string") {
    return { ...row, billNo: row.bill_no };
  }
  return row;
}

function cellValue(row: Record<string, unknown>, column: ListColumn) {
  if (column.field === "billNo" && (row.billNo == null || row.billNo === "")) {
    return row.bill_no ?? "";
  }
  if (column.field === "taxInclusiveUnitPrice") {
    const existing = row.taxInclusiveUnitPrice;
    if (existing != null && existing !== "") {
      return existing;
    }
    const unitPrice = Number(row.unitPrice ?? 0);
    const taxRate = Number(row.taxRate ?? 0);
    if (!Number.isFinite(unitPrice) || !Number.isFinite(taxRate)) {
      return "";
    }
    return (unitPrice * (1 + taxRate / 100)).toFixed(2);
  }
  return row[column.field] ?? "";
}

function listSummaryFooterValue(columnKey: string) {
  if (columnKey === "__selection") {
    return "";
  }
  if (columnKey === summaryLabelField.value) {
    return "合计";
  }
  if (listSummaryFields.has(columnKey)) {
    return listSummaryTotals.value[columnKey] ?? "";
  }
  return "";
}

const summaryLabelField = computed(() => visibleColumns.value.find((column) => !listSummaryFields.has(column.field))?.field ?? visibleColumns.value[0]?.field ?? "");

function listSummaryCellTestId(columnKey: string) {
  return columnKey === "__selection" ? undefined : `list-summary-${columnKey}`;
}

function sumDisplayedRows(field: string, maxDecimals: number) {
  return formatListSummaryNumber(displayedRows.value.reduce((sum, row) => {
    if (field === "priceTaxTotal") {
      return sum + numericCell(cellValue(row, { field, title: "", width: 0, visible: true }));
    }
    return sum + numericCell(row[field]);
  }, 0), maxDecimals);
}

function numericCell(value: unknown) {
  if (value == null || value === "") {
    return 0;
  }
  const numeric = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatListSummaryNumber(value: number, maxDecimals: number) {
  if (!Number.isFinite(value)) {
    return maxDecimals === 2 ? "0.00" : "0";
  }
  if (maxDecimals === 2) {
    return value.toFixed(2);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(maxDecimals).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeListColumns(nextColumns: ListColumn[]) {
  return nextColumns.map((column) => ({
    ...column,
    fixed: "" as const
  }));
}

async function syncRenderedColumnWidths() {
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const frame = document.querySelector<HTMLElement>("[data-testid='vxe-list-table']");
  if (!frame) {
    return;
  }
  const widths = [42, ...visibleColumns.value.map((column) => column.width ?? column.minWidth ?? 120)];
  const tableWidth = Math.max(widths.reduce((sum, width) => sum + width, 0), 960);
  frame.querySelectorAll<HTMLElement>(".vxe-table--header-wrapper table, .vxe-table--body-wrapper table, .table-core-footer-wrapper table").forEach((table) => {
    table.style.width = `${tableWidth}px`;
    table.style.minWidth = `${tableWidth}px`;
  });
  frame.querySelectorAll<HTMLTableColElement>("colgroup col").forEach((col, index) => {
    const width = widths[index % widths.length] ?? 120;
    col.style.width = `${width}px`;
  });
  frame.querySelectorAll<HTMLElement>(".vxe-header--column, .vxe-body--column, .vxe-footer--column").forEach((cell, index) => {
    const width = widths[index % widths.length] ?? 120;
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.style.maxWidth = `${width}px`;
  });
}
</script>
