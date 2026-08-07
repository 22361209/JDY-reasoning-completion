<template>
  <div class="data-list-page" :data-testid="`list-page-${listKey}`">
    <div class="business-head list-head">
      <div>
        <h2>{{ definition.title }}</h2>
        <p v-if="definition.subtitle">{{ definition.subtitle }}</p>
      </div>
      <div class="status-stamp">列表</div>
    </div>

    <ListQueryBar
      v-model:keyword="query.keyword"
      :keyword-placeholder="definition.keywordPlaceholder"
      :supports-quick-date-filter="definition.supportsQuickDateFilter"
      :date-from="query.dateFrom"
      :date-to="query.dateTo"
      :expanded="filtersExpanded"
      :has-expanded-filters="isOperationLogList"
      @update-date-range="applyQueryBarDateRange"
      @query="submitQuery"
      @reset="resetQuery()"
      @toggle-expanded="filtersExpanded = !filtersExpanded"
    >
      <template #expanded-fields="{ expanded }">
        <label v-if="expanded && isOperationLogList">
          查看范围
          <select v-model="query.scope" data-testid="operation-log-scope">
            <option value="current">当前账套</option>
            <option v-if="canViewOperationLogPlatformScopes" value="platform">平台</option>
            <option v-if="canViewOperationLogPlatformScopes" value="historical">历史未归属</option>
          </select>
        </label>
        <label v-if="expanded && isOperationLogList">
          模块
          <select v-model="query.module" data-testid="operation-log-module">
            <option value="">全部</option>
            <option v-for="module in operationLogModules" :key="module" :value="module">{{ module }}</option>
          </select>
        </label>
        <label v-if="expanded && isOperationLogList">
          动作
          <select v-model="query.action" data-testid="operation-log-action">
            <option value="">全部</option>
            <option v-for="action in operationLogActions" :key="action" :value="action">{{ action }}</option>
          </select>
        </label>
        <label v-if="expanded && isOperationLogList">
          主体类型
          <select v-model="query.actorType" data-testid="operation-log-actor-type">
            <option value="">全部</option>
            <option value="USER">用户</option>
            <option value="SYSTEM">系统任务</option>
            <option value="ANONYMOUS">未认证请求</option>
            <option value="HISTORICAL_UNKNOWN">历史未知</option>
          </select>
        </label>
        <label v-if="expanded && isOperationLogList">
          操作人
          <input v-model="query.operator" data-testid="operation-log-operator" placeholder="操作人" @keydown.enter="submitQuery" />
        </label>
        <label v-if="expanded && isOperationLogList">
          对象类型
          <select v-model="query.targetType" data-testid="operation-log-target-type">
            <option value="">全部</option>
            <option v-for="targetType in operationLogTargetTypes" :key="targetType" :value="targetType">{{ targetType }}</option>
          </select>
        </label>
      </template>
      <template #preset-row="{ expanded }">
        <div v-if="expanded && isOperationLogList" class="filter-preset-row">
          <label>
            预设名称
            <input v-model="presetName" data-testid="operation-log-preset-name" placeholder="如 红冲审计" @keydown.enter="saveCurrentPreset" />
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
      </template>
    </ListQueryBar>

    <div class="list-toolbar">
      <ActionBar bar-class="list-toolbar-actions" :actions="listToolbarActions" @action="handleListAction" />
      <div class="list-more-actions">
        <button type="button" class="list-more-trigger" data-testid="list-more-actions">更多</button>
        <div class="list-more-menu">
          <ActionBar bar-class="list-more-menu-actions" :actions="listMoreActions" @action="handleListAction" />
        </div>
      </div>
      <span class="selected-count">已选中 {{ selectedRows.length }} 条</span>
      <span v-if="exportMessage" class="list-export-message" data-testid="list-export-message">{{ exportMessage }}</span>
      <span v-if="batchMessage" class="list-export-message" data-testid="list-batch-message">{{ batchMessage }}</span>
      <div class="list-toolbar-utilities">
        <button v-if="supportsDetailView" type="button" class="view-switch-button" data-testid="list-detail-view-toggle" @click="toggleDetailView">
          {{ isDetailView ? "整单视图" : "明细视图" }}
        </button>
        <button type="button" data-testid="column-settings" @click="openColumnSettings">列设置</button>
        <button v-if="!isOperationLogList" type="button" data-testid="list-refresh-stock" @click="reload">更新库存</button>
      </div>
    </div>

    <div class="data-list-content" :class="{ 'has-product-category-sidebar': isProductMasterList }">
      <ProductCategorySidebar
        v-if="isProductMasterList"
        :categories="productCategories"
        :selected-category="selectedProductCategory"
        :loading="loadingProductCategories"
        :message="productCategoryMessage"
        @select="selectProductCategory"
      />

      <div class="data-list-main">
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
                aria-hidden="true"
                tabindex="-1"
                data-testid="list-select-all"
                @change="toggleAllDisplayedRows(($event.target as HTMLInputElement).checked)"
              />
              <span
                class="vxe-checkbox--icon"
                role="checkbox"
                aria-label="全选列表行"
                :aria-checked="allDisplayedRowsSelected"
                tabindex="0"
                data-testid="list-select-all-toggle"
                @click="toggleAllDisplayedRows(!allDisplayedRowsSelected)"
                @keydown.enter.prevent="toggleAllDisplayedRows(!allDisplayedRowsSelected)"
                @keydown.space.prevent="toggleAllDisplayedRows(!allDisplayedRowsSelected)"
              />
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
                aria-hidden="true"
                tabindex="-1"
                :data-testid="`list-select-${rowKey(row)}`"
                @change="toggleRowSelection(row, ($event.target as HTMLInputElement).checked)"
              />
              <span
                class="vxe-checkbox--icon"
                role="checkbox"
                aria-label="选择列表行"
                :aria-checked="isRowSelected(row)"
                tabindex="0"
                :data-testid="`list-select-toggle-${rowKey(row)}`"
                @click="toggleRowSelection(row, !isRowSelected(row))"
                @keydown.enter.prevent="toggleRowSelection(row, !isRowSelected(row))"
                @keydown.space.prevent="toggleRowSelection(row, !isRowSelected(row))"
              />
            </template>
            <div v-else class="vxe-cell">
              <span v-if="isStatusColumn(column.key)" class="status-pill" :class="statusClass(row[column.key])">{{ row[column.key] }}</span>
              <span v-else-if="isOperationLogList && column.key === 'actorType'">{{ operationLogActorTypeLabel(row.actorType) }}</span>
              <button
                v-else-if="isOperationLogList && column.key === 'operatedAt'"
                class="list-cell-link"
                type="button"
                :data-testid="`operation-log-open-detail-${row.id}`"
                @click.stop="openOperationLogDetail(row)"
              >
                {{ cellValue(row, listColumnByKey(column.key)) }}
              </button>
              <button
                v-else-if="isOpenableListRecord && column.key === 'billNo'"
                class="list-cell-link"
                type="button"
                :data-testid="`open-document-${cellValue(row, listColumnByKey(column.key))}`"
                @click.stop="openDocument(row)"
              >
                {{ cellValue(row, listColumnByKey(column.key)) }}
              </button>
              <button
                v-else-if="isOpenableMasterCodeColumn(column.key)"
                class="list-cell-link"
                type="button"
                :data-testid="`open-master-${cellValue(row, listColumnByKey(column.key))}`"
                @click.stop="openMasterRecord(row)"
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
          <span v-if="loading" data-testid="list-total-loading">正在加载列表…</span>
          <span v-else>共 {{ total }} 条</span>
          <select v-model.number="query.pageSize" @change="reload">
            <option :value="200">200条/页</option>
            <option :value="500">500条/页</option>
            <option :value="1000">1000条/页</option>
          </select>
          <button type="button" :disabled="query.page === 1" @click="goPage(query.page - 1)">上一页</button>
          <span>第 {{ query.page }} 页</span>
          <button type="button" :disabled="query.page * query.pageSize >= total" @click="goPage(query.page + 1)">下一页</button>
        </footer>
      </div>
    </div>

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
      :operators="tableFilterOperators"
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
        <template v-if="pendingAction === '删除'">
          <p>确定要删除已选中的 {{ pendingActionTargetCount }} 条数据吗？</p>
          <p class="danger-text">删除不可逆，草稿单据删除后不会再出现在普通业务列表中，编号不复用。</p>
        </template>
        <p v-else>确定要{{ pendingAction }}已选中的 {{ pendingActionTargetCount }} 条数据吗？</p>
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

    <OperationLogDetailDrawer
      :open="operationLogDetailOpen"
      :loading="operationLogDetailLoading"
      :message="operationLogDetailMessage"
      :scope="query.scope"
      :detail="operationLogDetail"
      @close="closeOperationLogDetail"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import ActionBar from "./ActionBar.vue";
import { defineAction, type ActionBarItem } from "./actions/actionRegistry";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { tableFilterOperators, type TableColumnFilter } from "./table/useColumnFilters";
import { useListColumnFilters } from "./table/useListColumnFilters";
import { useColumnReorder } from "./table/useColumnReorder";
import {
  deleteListPreset,
  deleteStockAlertSetting,
  exportListRows,
  fetchOperationLogDetail,
  fetchListPresets,
  fetchListRows,
  fetchStockAlertSettings,
  saveListPreset,
  saveStockAlertSetting,
  type StockAlertSetting,
  type ListFilterPreset,
  type OperationLogDetail
} from "../services/listApi";
import { auditDocument, deleteDocument, lifecycleDocument, reverseDocument, voidDocumentHardened, type DocumentType } from "../services/documentApi";
import { setBomEnabled } from "../services/productionApi";
import {
  isAuditedBillStatus,
  isDraftBillStatus,
  lifecyclePolicyFor
} from "../app/documentLifecyclePolicy";
import { useMasterDataMaintenance } from "../modules/master-data/useMasterDataMaintenance";
import { masterDataImportListKeys } from "../modules/master-data/import/importRegistry";
import { useSessionStore } from "../stores/session";
import { useDataListDefinition, type ListColumn, type OpenableDocumentType } from "./list/useDataListDefinition";
import {
  isValidColumnPreference as isValidStoredColumnPreference,
  loadColumnPreferences as loadStoredColumnPreferences,
  mergeSavedColumnsWithDefaults,
  normalizeListColumns,
  saveColumnPreferences as saveStoredColumnPreferences
} from "./list/useDataListColumnPreferences";
import { useDataListSelection } from "./list/useDataListSelection";
import { useDataListSummary } from "./list/useDataListSummary";
import ListQueryBar from "./list/ListQueryBar.vue";
import ProductCategorySidebar from "./ProductCategorySidebar.vue";
import { useProductCategoryFacet } from "./useProductCategoryFacet";
import OperationLogDetailDrawer from "../modules/system/operation-log/OperationLogDetailDrawer.vue";

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
  createListRecord: [payload: { listKey: string; row?: Record<string, unknown>; mode?: "copy" }];
  createMasterData: [payload: { listKey: string }];
  viewMasterData: [payload: { listKey: string; row: Record<string, unknown> }];
  editMasterData: [payload: { listKey: string; row: Record<string, unknown> }];
  copyMasterData: [payload: { listKey: string; row: Record<string, unknown> }];
  openMasterDataImport: [payload: { listKey: string }];
}>();

const tableVersion = ref(0);
const loading = ref(true);
const listState = ref<"ready" | "empty" | "error" | "forbidden">("ready");
const stateMessage = ref("");
let reloadSerial = 0;
let exportSerial = 0;
let operationLogDetailSerial = 0;
const filtersExpanded = ref(false);
const columnDialogOpen = ref(false);
const selectedProductCategory = ref("");
const pendingAction = ref("");
const pendingReason = ref("");
const pendingVoidUsername = ref("");
const pendingVoidPassword = ref("");
const pendingActionMessage = ref("");
const batchMessage = ref("");
const rows = ref<Record<string, unknown>[]>([]);
const total = ref(0);
const exportMessage = ref("");
const presetMessage = ref("");
const presetName = ref("");
const selectedPresetId = ref("");
const operationLogPresets = ref<ListFilterPreset[]>([]);
const operationLogDetailOpen = ref(false);
const operationLogDetailLoading = ref(false);
const operationLogDetailMessage = ref("");
const operationLogDetail = ref<OperationLogDetail | null>(null);
const stockAlertSettings = ref<StockAlertSetting[]>([]);
const stockAlertSettingsOpen = ref(false);
const stockAlertSettingsMessage = ref("");
const stockAlertSettingForm = reactive({
  productCode: "",
  warehouseCode: "",
  safetyQty: "",
  maxQty: ""
});
const columnFilterSnapshots = reactive<Record<string, Record<string, TableColumnFilter>>>({});
const columnPreferenceVersion = "v3";
const query = reactive({
  keyword: "",
  status: defaultListStatus(),
  page: 1,
  pageSize: 200,
  module: "",
  action: "",
  operator: "",
  targetType: "",
  actorType: "",
  scope: "current" as "current" | "platform" | "historical",
  dateFrom: "",
  dateTo: ""
});
const {
  columnFilters,
  activeFilterColumn,
  filterDialogOpen,
  activeFilterOperator,
  activeFilterValue,
  filterPopoverLeft,
  filterPopoverTop,
  openColumnFilter,
  applyColumnFilter,
  clearColumnFilter,
  snapshotColumnFilters,
  replaceColumnFilters,
  isFilterActive
} = useListColumnFilters<ListColumn>(() => {
  query.page = 1;
  reload();
});
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
  "production_material_scrap",
  "production_completion",
  "ar_receivable",
  "ap_payable",
  "prod_bom"
];
const { billDefinition, definition, detailColumnsForList } = useDataListDefinition(() => props.listKey);
const displayedRows = computed(() => rows.value);
const {
  selectedRows,
  allDisplayedRowsSelected,
  rowKey,
  isRowSelected,
  toggleRowSelection,
  toggleAllDisplayedRows
} = useDataListSelection(displayedRows);
const session = useSessionStore();
const masterMaintenance = useMasterDataMaintenance(computed(() => props.listKey), rows, selectedRows, reload);
const isMasterList = masterMaintenance.isMasterList;
const usesSparseMasterPatch = masterMaintenance.usesSparsePatch;
const canDeleteMaster = masterMaintenance.canDelete;
const isProductMasterList = computed(() => props.listKey === "product-master-list");
const canCopyMasterRecord = computed(() => props.listKey === "product-master-list");
const isBomList = computed(() => props.listKey === "bom-list");
const canCopyCurrentRecord = computed(() => canCopyMasterRecord.value || isBomList.value);
const isSalesOrderList = computed(() => props.listKey === "sales-order-form-list");
const isPurchaseOrderList = computed(() => props.listKey === "purchase-order-form-list");
const isOperationLogList = computed(() => props.listKey === "operation-log-list");
const canViewOperationLogPlatformScopes = computed(() =>
  session.userRoleCode.value === "ADMIN"
    && session.hasPermission("system.audit_log.view")
    && session.hasPermission("system.account_set.manage")
);
const isStockAlertList = computed(() => props.listKey === "stock-alert-list");
const isDetailView = ref(false);
const auditPermissionByListKey: Partial<Record<string, string>> = {
  "sales-quote-form-list": "sales.order.audit",
  "sales-order-form-list": "sales.order.audit",
  "delivery-notice-form-list": "sales.out.audit",
  "sales-out-list": "sales.out.audit",
  "sales-out-form-list": "sales.out.audit",
  "sales-return-form-list": "sales.out.audit",
  "purchase-requisition-list": "purchase.order.audit",
  "purchase-order-form-list": "purchase.order.audit",
  "purchase-in-list": "purchase.in.audit",
  "purchase-in-form-list": "purchase.in.audit",
  "purchase-return-form-list": "purchase.return.audit",
  "material-issue-form-list": "production.document.audit",
  "material-scrap-form-list": "production.document.audit",
  "product-in-form-list": "production.document.audit",
  "other-in-form-list": "inventory.other_stock_in.audit",
  "other-out-form-list": "inventory.other_stock_out.audit",
  "stock-transfer-form-list": "inventory.stock_transfer.audit",
  "stock-count-form-list": "inventory.stock_count.audit",
  "stock-count-gain-form-list": "inventory.stock_count_gain.audit",
  "stock-count-loss-form-list": "inventory.stock_count_loss.audit",
  "ar-receipt-form-list": "finance.settle",
  "ap-payment-form-list": "finance.settle"
};
const maintainPermissionByListKey: Partial<Record<string, string>> = {
  "product-master-list": "master.data.manage",
  "product-name-list": "master.data.manage",
  "product-category-list": "master.data.manage",
  "unit-master-list": "master.data.manage",
  "customer-master-list": "master.data.manage",
  "supplier-master-list": "master.data.manage",
  "warehouse-master-list": "master.data.manage",
  "production-department-list": "master.data.manage",
  "employee-master-list": "master.data.manage",
  "financial-account-master-list": "master.data.manage",
  "bom-list": "master.data.manage",
  "production-plan-list": "production.task.audit",
  "production-task-form-list": "production.task.audit",
  "outsourcing-work-order-list": "production.document.audit",
  "outsourcing-issue-list": "production.document.audit",
  "outsourcing-receipt-list": "production.document.audit",
  "outsourcing-return-list": "production.document.audit",
  "outsourcing-scrap-list": "production.document.audit",
  "sales-quote-form-list": "sales.order.audit",
  "sales-order-form-list": "sales.order.audit",
  "delivery-notice-form-list": "sales.out.audit",
  "sales-out-list": "sales.out.audit",
  "sales-out-form-list": "sales.out.audit",
  "sales-return-form-list": "sales.out.audit",
  "purchase-order-form-list": "purchase.order.audit",
  "purchase-in-list": "purchase.in.audit",
  "purchase-in-form-list": "purchase.in.audit",
  "purchase-return-form-list": "purchase.return.audit",
  "material-issue-form-list": "production.document.audit",
  "material-scrap-form-list": "production.document.audit",
  "product-in-form-list": "production.document.audit",
  "other-in-form-list": "inventory.other_stock_in.audit",
  "other-out-form-list": "inventory.other_stock_out.audit",
  "stock-transfer-form-list": "inventory.stock_transfer.audit",
  "stock-count-form-list": "inventory.stock_count.audit",
  "stock-count-gain-form-list": "inventory.stock_count_gain.audit",
  "stock-count-loss-form-list": "inventory.stock_count_loss.audit",
  "ar-receipt-form-list": "finance.settle",
  "ap-payment-form-list": "finance.settle",
  "stock-alert-list": "inventory.stock_alert.manage"
};
const canAuditCurrentList = computed(() => {
  const permission = auditPermissionByListKey[props.listKey];
  return Boolean(permission) && session.hasPermission(permission);
});
const canMaintainCurrentList = computed(() => {
  const permission = maintainPermissionByListKey[props.listKey];
  return Boolean(permission) && session.hasPermission(permission);
});
const supportsMasterDataImport = computed(() => masterDataImportListKeys.has(props.listKey));
const canMaintainStockAlert = computed(() => session.hasPermission("inventory.stock_alert.manage"));
const supportsCreateCurrentList = computed(() => !isStockAlertList.value && (isMasterList.value || Boolean(openableDocumentType.value) || canCreateListRecord(props.listKey)));
const supportsAuditCurrentList = computed(() => !isStockAlertList.value && Boolean(auditPermissionByListKey[props.listKey]));
const documentOpenTypeByListKey: Partial<Record<string, OpenableDocumentType>> = {
  "sales-quote-form-list": "salesQuote",
  "sales-order-form-list": "salesOrder",
  "delivery-notice-form-list": "deliveryNotice",
  "sales-out-list": "salesOut",
  "sales-out-form-list": "salesOut",
  "sales-return-form-list": "salesReturn",
  "purchase-order-form-list": "purchaseOrder",
  "purchase-in-list": "purchaseIn",
  "purchase-in-form-list": "purchaseIn",
  "purchase-return-form-list": "purchaseReturn",
  "material-issue-form-list": "materialIssue",
  "material-scrap-form-list": "materialScrap",
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
const isOpenableListRecord = computed(() => isOpenableDocumentList.value || canOpenListRecord(props.listKey));
const supportsDetailView = computed(() => isOpenableDocumentList.value);
const currentLifecyclePolicy = computed(() => lifecyclePolicyFor(documentActionTypeByListKey[props.listKey] ?? null));
const isReverseableDocumentList = computed(() => Boolean(documentActionTypeByListKey[props.listKey]));
const isLifecycleDocumentList = computed(() => Boolean(currentLifecyclePolicy.value));
const supportsBatchAudit = computed(() => Boolean(documentActionTypeByListKey[props.listKey]) && supportsAuditCurrentList.value);
const supportsBatchDelete = computed(() => {
  const type = documentActionTypeByListKey[props.listKey];
  return Boolean(type && deleteSupportedDocumentTypes.has(type));
});
const supportsBatchCloseFreeze = computed(() => Boolean(isLifecycleDocumentList.value && currentLifecyclePolicy.value?.closeFreezeAllowed));
const selectedBillRows = computed(() => selectedRows.value.filter((row) => String(row.billNo ?? "").trim()));
const selectedUniqueBillRows = computed(() => {
  const seen = new Set<string>();
  return selectedBillRows.value.filter((row) => {
    const billNo = String(row.billNo ?? "").trim();
    if (!billNo || seen.has(billNo)) {
      return false;
    }
    seen.add(billNo);
    return true;
  });
});
const canOperateLifecycle = computed(() => canMaintainCurrentList.value && selectedBillRows.value.length > 0 && !selectedContainsLockedRow.value);
const canBatchAudit = computed(() => supportsBatchAudit.value && canAuditCurrentList.value && selectedBillRows.value.length > 0 && !selectedContainsLockedRow.value && selectedBillRows.value.every(isDraftBillStatus));
const canBatchClose = computed(() => supportsBatchCloseFreeze.value && canOperateLifecycle.value && selectedBillRows.value.every((row) => isAuditedRow(row) && row.closeStatus !== "CLOSED" && row.frozenStatus !== "FROZEN"));
const canUncloseSelectedRow = (row: Record<string, unknown>) => {
  if (!isAuditedRow(row) || row.closeStatus !== "CLOSED") {
    return false;
  }
  return props.listKey !== "sales-order-form-list" || row.closeMode === "MANUAL";
};
const canBatchUnclose = computed(() => supportsBatchCloseFreeze.value && canOperateLifecycle.value && selectedBillRows.value.every(canUncloseSelectedRow));
const canBatchFreeze = computed(() => supportsBatchCloseFreeze.value && canOperateLifecycle.value && selectedBillRows.value.every((row) => isAuditedRow(row) && row.frozenStatus !== "FROZEN" && row.closeStatus !== "CLOSED"));
const canBatchUnfreeze = computed(() => supportsBatchCloseFreeze.value && canOperateLifecycle.value && selectedBillRows.value.every((row) => isAuditedRow(row) && row.frozenStatus === "FROZEN"));
const canBatchVoid = computed(() => Boolean(currentLifecyclePolicy.value?.voidAllowed) && canOperateLifecycle.value && selectedBillRows.value.every(isDraftBillStatus));
const canBatchDelete = computed(() => supportsBatchDelete.value
  && canOperateLifecycle.value
  && selectedBillRows.value.every(isDraftBillStatus)
  && selectedBillRows.value.every((row) => row.legacy !== true && String(row.legacy ?? "").toLowerCase() !== "true"));
const selectedBomRows = computed(() => selectedRows.value.filter((row) => String(row.code ?? "").trim()));
const canOperateBomStatus = computed(() => isBomList.value && canMaintainCurrentList.value && selectedBomRows.value.length === 1 && !selectedContainsLockedRow.value);
const canEnableSelectedBom = computed(() => canOperateBomStatus.value && !isBomRowEnabled(selectedBomRows.value[0]));
const canDisableSelectedBom = computed(() => canOperateBomStatus.value && isBomRowEnabled(selectedBomRows.value[0]));
const pendingActionRequiresReason = computed(() => ["关闭", "冻结", "作废"].includes(pendingAction.value));
const pendingActionTargetCount = computed(() => {
  if (pendingAction.value === "删除" && !isMasterList.value) {
    return selectedUniqueBillRows.value.length;
  }
  return selectedRows.value.length;
});
const canPushDownSalesOut = computed(() => {
  const row = selectedRows.value[0];
  return Boolean(
    isSalesOrderList.value &&
    session.hasPermission("sales.out.audit") &&
    selectedRows.value.length === 1 &&
    row &&
    isAuditedBillStatus(row) &&
    row?.closeStatus !== "CLOSED" &&
    row?.frozenStatus !== "FROZEN" &&
    hasPositiveQuantity(row?.remainingQty)
  );
});
const canPushDownPurchaseIn = computed(() => {
  const row = selectedRows.value[0];
  return Boolean(
    isPurchaseOrderList.value &&
    session.hasPermission("purchase.in.audit") &&
    selectedRows.value.length === 1 &&
    row &&
    isAuditedBillStatus(row) &&
    row?.closeStatus !== "CLOSED" &&
    row?.frozenStatus !== "FROZEN" &&
    hasPositiveQuantity(row?.remainingQty)
  );
});
const columns = ref<ListColumn[]>([]);
const visibleColumns = computed(() => columns.value.filter((column) => column.visible));
const {
  hasListSummary,
  listSummaryRowTestId,
  listSummaryFooterValue,
  listSummaryCellTestId,
  cellValue
} = useDataListSummary(visibleColumns, displayedRows, isSalesOrderList);
const selectedPreset = computed(() => operationLogPresets.value.find((preset) => preset.id === selectedPresetId.value));
const selectedContainsLockedRow = computed(() => false);
const listToolbarActions = computed<ActionBarItem[]>(() => [
  defineAction("create", {
    visible: supportsCreateCurrentList.value,
    enabled: canMaintainCurrentList.value,
    testId: "list-create"
  }),
  defineAction("stockAlertSettings", {
    label: "安全库存设置",
    order: 20,
    visible: isStockAlertList.value,
    enabled: canMaintainStockAlert.value,
    testId: "stock-alert-settings"
  }),
  defineAction("edit", {
    visible: isMasterList.value,
    enabled: canMaintainCurrentList.value
      && selectedRows.value.length === 1
      && (!usesSparseMasterPatch.value || !isAuditedMasterRow(selectedRows.value[0])),
    testId: "master-edit"
  }),
  defineAction("copy", {
    label: "复制",
    order: 24,
    visible: canCopyCurrentRecord.value,
    enabled: canMaintainCurrentList.value && selectedRows.value.length === 1,
    testId: isBomList.value ? "bom-copy" : "master-copy"
  }),
  defineAction("audit", {
    visible: isMasterList.value,
    enabled: canMaintainCurrentList.value
      && selectedRows.value.length > 0
      && (!usesSparseMasterPatch.value || selectedRows.value.every((row) => !isAuditedMasterRow(row))),
    testId: "master-audit"
  }),
  defineAction("reverse", {
    visible: isMasterList.value,
    enabled: canMaintainCurrentList.value
      && selectedRows.value.length > 0
      && (!usesSparseMasterPatch.value || selectedRows.value.every(isAuditedMasterRow)),
    testId: "master-reverse-audit"
  }),
  defineAction("enable", {
    visible: isMasterList.value || isBomList.value,
    enabled: isBomList.value ? canEnableSelectedBom.value : canMaintainCurrentList.value && selectedRows.value.length > 0,
    testId: isBomList.value ? "bom-enable" : "master-enable"
  }),
  defineAction("disable", {
    visible: isMasterList.value || isBomList.value,
    enabled: isBomList.value ? canDisableSelectedBom.value : canMaintainCurrentList.value && selectedRows.value.length > 0,
    testId: isBomList.value ? "bom-disable" : "master-disable"
  }),
  defineAction("bomStatusFilter", {
    label: query.status === "禁用" ? "只看启用" : "只看禁用",
    order: 172,
    visible: isBomList.value,
    enabled: true,
    testId: "bom-status-filter-toggle"
  }),
  defineAction("audit", {
    key: "batchAudit",
    visible: supportsBatchAudit.value,
    enabled: canBatchAudit.value,
    testId: "batch-audit"
  }),
  defineAction("reverse", {
    key: "batchReverse",
    visible: isReverseableDocumentList.value,
    enabled: canAuditCurrentList.value && selectedRows.value.length > 0 && !selectedContainsLockedRow.value && selectedRows.value.every(isAuditedRow),
    testId: "batch-reverse"
  }),
  defineAction("pushDown", {
    key: "pushSalesOut",
    label: "发货通知",
    visible: isSalesOrderList.value,
    enabled: canPushDownSalesOut.value,
    testId: "push-sales-out"
  }),
  defineAction("pushDown", {
    key: "pushPurchaseIn",
    label: "采购入库",
    visible: isPurchaseOrderList.value,
    enabled: canPushDownPurchaseIn.value,
    testId: "push-purchase-in"
  }),
  defineAction("close", {
    key: "batchClose",
    visible: supportsBatchCloseFreeze.value,
    enabled: canBatchClose.value,
    testId: "batch-close"
  }),
  defineAction("unclose", {
    key: "batchUnclose",
    visible: supportsBatchCloseFreeze.value,
    enabled: canBatchUnclose.value,
    testId: "batch-unclose"
  }),
  defineAction("freeze", {
    key: "batchFreeze",
    visible: supportsBatchCloseFreeze.value,
    enabled: canBatchFreeze.value,
    testId: "batch-freeze"
  }),
  defineAction("unfreeze", {
    key: "batchUnfreeze",
    visible: supportsBatchCloseFreeze.value,
    enabled: canBatchUnfreeze.value,
    testId: "batch-unfreeze"
  }),
  defineAction("void", {
    key: "batchVoid",
    visible: Boolean(currentLifecyclePolicy.value?.voidAllowed),
    enabled: canBatchVoid.value,
    testId: "batch-void"
  }),
  defineAction("refresh", {
    enabled: true,
    testId: "list-refresh"
  })
]);
const listMoreActions = computed<ActionBarItem[]>(() => [
  defineAction("importData", {
    visible: supportsMasterDataImport.value,
    enabled: canMaintainCurrentList.value,
    testId: "list-import"
  }),
  defineAction("export", {
    enabled: true,
    testId: "list-export"
  }),
  defineAction("delete", {
    key: "batchDelete",
    visible: !isMasterList.value || canDeleteMaster.value,
    enabled: isMasterList.value
      ? canMaintainCurrentList.value && selectedRows.value.length > 0 && !selectedContainsLockedRow.value
      : canBatchDelete.value,
    testId: "batch-delete"
  })
]);
const {
  categories: productCategories,
  loadingCategories: loadingProductCategories,
  categoryMessage: productCategoryMessage,
  loadCategories: loadProductCategories
} = useProductCategoryFacet();
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
    filterActive: isFilterActive(column.field),
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
  "sales-return-form-list": "salesReturn",
  "purchase-order-form-list": "purchaseOrder",
  "purchase-in-list": "purchaseIn",
  "purchase-in-form-list": "purchaseIn",
  "purchase-return-form-list": "purchaseReturn",
  "production-task-form-list": "productionTask",
  "material-issue-form-list": "materialIssue",
  "material-scrap-form-list": "materialScrap",
  "product-in-form-list": "productIn",
  "other-in-form-list": "otherStockIn",
  "other-out-form-list": "otherStockOut",
  "stock-transfer-form-list": "stockTransfer",
  "stock-count-form-list": "stockCount",
  "stock-count-gain-form-list": "stockCountGain",
  "stock-count-loss-form-list": "stockCountLoss",
  "ar-receipt-form-list": "receipt",
  "ap-payment-form-list": "payment"
};
const deleteSupportedDocumentTypes = new Set<DocumentType>([
  "salesQuote",
  "salesOrder",
  "deliveryNotice",
  "salesOut",
  "salesReturn",
  "purchaseIn",
  "purchaseReturn",
  "materialScrap",
  "receipt",
  "payment"
]);

watch(() => props.listKey, () => {
  exportSerial += 1;
  closeOperationLogDetail();
  loadDetailViewPreference();
  selectedProductCategory.value = "";
  resetColumns();
  resetQuery(false);
  replaceColumnFilters({});
  selectedRows.value = [];
  rows.value = [];
  total.value = 0;
  void loadOperationLogPresets(true);
  if (isProductMasterList.value) {
    void loadProductCategories();
  }
  void reload();
}, { immediate: false });

watch(canViewOperationLogPlatformScopes, (allowed) => {
  if (!allowed && query.scope !== "current") {
    query.scope = "current";
  }
});

watch(() => query.scope, (scope, previousScope) => {
  if (!isOperationLogList.value || scope === previousScope) {
    return;
  }
  reloadSerial += 1;
  exportSerial += 1;
  query.page = 1;
  loading.value = true;
  exportMessage.value = "";
  selectedRows.value = [];
  rows.value = [];
  total.value = 0;
  listState.value = "ready";
  stateMessage.value = "";
  closeOperationLogDetail();
  void nextTick(() => {
    if (isOperationLogList.value && query.scope === scope) {
      void reload();
    }
  });
}, { flush: "sync" });

onMounted(() => {
  loadDetailViewPreference();
  resetColumns();
  resetQuery(false);
  if (isProductMasterList.value) {
    void loadProductCategories();
  }
  void loadOperationLogPresets(true);
  reload();
});

function resetColumns() {
  const defaults = defaultColumnsForCurrentView();
  const saved = loadColumnPreferences();
  if (!saved.length || !isValidStoredColumnPreference(saved, defaults)) {
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

function defaultColumnsForCurrentView() {
  return (isDetailView.value ? detailColumnsForList() : definition.value.columns).map((column) => ({ ...column }));
}

function openColumnSettings() {
  columns.value = normalizeListColumns(mergeSavedColumnsWithDefaults(columns.value, defaultColumnsForCurrentView()));
  columnDialogOpen.value = true;
}

async function reload() {
  const serial = ++reloadSerial;
  const listKey = props.listKey;
  const view = isDetailView.value ? "detail" : "header";
  const filters = productCategoryColumnFilters(snapshotColumnFilters());
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

function productCategoryColumnFilters(filters: Record<string, TableColumnFilter>) {
  if (!isProductMasterList.value || !selectedProductCategory.value) {
    return filters;
  }
  return {
    ...filters,
    category: { operator: "等于", value: selectedProductCategory.value }
  };
}

async function exportCurrentList() {
  const serial = ++exportSerial;
  const listKey = props.listKey;
  const view = isDetailView.value ? "detail" : "header";
  const scope = isOperationLogList.value ? query.scope : null;
  exportMessage.value = "";
  const result = await exportListRows(listKey, { ...query, view, columnFilters: productCategoryColumnFilters(snapshotColumnFilters()) });
  if (
    serial !== exportSerial
    || listKey !== props.listKey
    || view !== (isDetailView.value ? "detail" : "header")
    || (scope !== null && scope !== query.scope)
  ) {
    return;
  }
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
    module: query.module,
    action: query.action,
    operator: query.operator,
    targetType: query.targetType,
    actorType: query.actorType,
    scope: query.scope,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo
  };
}

function submitQuery() {
  query.page = 1;
  reload();
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
  const previousScope = query.scope;
  const migrated = migratePresetStatusFilter(preset);
  Object.assign(query, {
    ...migrated.query,
    page: 1
  });
  query.scope = normalizeOperationLogScope(migrated.query.scope);
  replaceColumnFilters(migrated.columnFilters);
  filtersExpanded.value = true;
  selectedPresetId.value = preset.id;
  presetName.value = preset.name;
  presetMessage.value = message;
  if (query.scope === previousScope) {
    reload();
  }
}

function persistOperationLogPresets() {
  localStorage.setItem(operationLogPresetKey(), JSON.stringify(operationLogPresets.value));
}

function operationLogPresetKey() {
  return "jdy:operation-log-filter-presets";
}

function resetQuery(shouldReload = true) {
  const previousScope = query.scope;
  query.keyword = "";
  query.status = defaultListStatus();
  selectedProductCategory.value = "";
  query.module = "";
  query.action = "";
  query.operator = "";
  query.targetType = "";
  query.actorType = "";
  query.scope = "current";
  query.dateFrom = "";
  query.dateTo = "";
  query.page = 1;
  replaceColumnFilters({});
  presetMessage.value = "";
  if (shouldReload && (!isOperationLogList.value || query.scope === previousScope)) {
    reload();
  }
}

function defaultListStatus() {
  return props.listKey === "bom-list" ? "启用" : "";
}

function selectProductCategory(category: string) {
  selectedProductCategory.value = category;
  query.page = 1;
  reload();
}

function migratePresetStatusFilter(preset: ListFilterPreset) {
  const querySnapshot = { ...preset.query };
  const columnFilterSnapshot: Record<string, TableColumnFilter> = { ...preset.columnFilters };
  const legacyStatus = String(querySnapshot.status ?? "").trim();
  if (legacyStatus && !columnFilterSnapshot.status) {
    columnFilterSnapshot.status = { operator: "等于", value: legacyStatus };
  }
  querySnapshot.status = "";
  querySnapshot.actorType = String(querySnapshot.actorType ?? "");
  querySnapshot.scope = normalizeOperationLogScope(querySnapshot.scope);
  return { query: querySnapshot, columnFilters: columnFilterSnapshot };
}

function normalizeOperationLogScope(scope: unknown): "current" | "platform" | "historical" {
  const normalized = String(scope ?? "current").trim().toLowerCase();
  if ((normalized === "platform" || normalized === "historical") && canViewOperationLogPlatformScopes.value) {
    return normalized;
  }
  return "current";
}

function operationLogActorTypeLabel(actorType: unknown) {
  return ({
    USER: "用户",
    SYSTEM: "系统任务",
    ANONYMOUS: "未认证请求",
    HISTORICAL_UNKNOWN: "历史未知"
  } as Record<string, string>)[String(actorType ?? "")] ?? String(actorType ?? "-");
}

async function openOperationLogDetail(row: Record<string, unknown>) {
  const id = String(row.id ?? "").trim();
  if (!id) {
    return;
  }
  const serial = ++operationLogDetailSerial;
  const scope = query.scope;
  operationLogDetailOpen.value = true;
  operationLogDetailLoading.value = true;
  operationLogDetailMessage.value = "";
  operationLogDetail.value = null;
  const response = await fetchOperationLogDetail(id, scope);
  if (serial !== operationLogDetailSerial || !operationLogDetailOpen.value || scope !== query.scope) {
    return;
  }
  operationLogDetailLoading.value = false;
  if (!response.ok || !response.data) {
    operationLogDetailMessage.value = response.message;
    return;
  }
  operationLogDetail.value = response.data;
}

function closeOperationLogDetail() {
  operationLogDetailSerial += 1;
  operationLogDetailOpen.value = false;
  operationLogDetailLoading.value = false;
  operationLogDetailMessage.value = "";
  operationLogDetail.value = null;
}

function applyQueryBarDateRange(range: { from: string; to: string }) {
  query.dateFrom = range.from;
  query.dateTo = range.to;
  query.page = 1;
  reload();
}

function toggleDetailView() {
  persistCurrentColumnFilters();
  isDetailView.value = !isDetailView.value;
  saveDetailViewPreference();
  query.page = 1;
  selectedRows.value = [];
  restoreCurrentColumnFilters();
  resetColumns();
  reload();
}

function detailViewPreferenceKey() {
  return `jdy:list-view:${props.listKey}`;
}

function loadDetailViewPreference() {
  isDetailView.value = supportsDetailView.value && localStorage.getItem(detailViewPreferenceKey()) === "detail";
}

function saveDetailViewPreference() {
  localStorage.setItem(detailViewPreferenceKey(), isDetailView.value ? "detail" : "header");
}

function goPage(page: number) {
  query.page = page;
  reload();
}

function handleListAction(actionKey: string) {
  if (actionKey === "create") {
    openCreateDialog();
    return;
  }
  if (actionKey === "stockAlertSettings") {
    void openStockAlertSettings();
    return;
  }
  if (actionKey === "edit") {
    openEditDialog();
    return;
  }
  if (actionKey === "copy") {
    openCopyDialog();
    return;
  }
  if (actionKey === "audit") {
    void submitMasterAudit(true);
    return;
  }
  if (actionKey === "reverse") {
    void submitMasterAudit(false);
    return;
  }
  if (actionKey === "enable") {
    if (isBomList.value) {
      void submitBomStatus(true);
      return;
    }
    void submitMasterStatus(true);
    return;
  }
  if (actionKey === "disable") {
    if (isBomList.value) {
      void submitBomStatus(false);
      return;
    }
    void submitMasterStatus(false);
    return;
  }
  if (actionKey === "bomStatusFilter") {
    toggleBomStatusFilter();
    return;
  }
  if (actionKey === "batchAudit") {
    confirmAction("审核");
    return;
  }
  if (actionKey === "batchReverse") {
    confirmAction("反审核");
    return;
  }
  if (actionKey === "pushSalesOut") {
    pushDownSalesOut();
    return;
  }
  if (actionKey === "pushPurchaseIn") {
    pushDownPurchaseIn();
    return;
  }
  if (actionKey === "batchClose") {
    confirmAction("关闭");
    return;
  }
  if (actionKey === "batchUnclose") {
    confirmAction("反关闭");
    return;
  }
  if (actionKey === "batchFreeze") {
    confirmAction("冻结");
    return;
  }
  if (actionKey === "batchUnfreeze") {
    confirmAction("解冻");
    return;
  }
  if (actionKey === "batchVoid") {
    confirmAction("作废");
    return;
  }
  if (actionKey === "refresh") {
    void reload();
    return;
  }
  if (actionKey === "importData") {
    emit("openMasterDataImport", { listKey: props.listKey });
    return;
  }
  if (actionKey === "export") {
    void exportCurrentList();
    return;
  }
  if (actionKey === "batchDelete") {
    confirmAction("删除");
    return;
  }
}

function statusClass(value: unknown) {
  const status = String(value ?? "");
  return {
    draft: ["草稿", "未审核", "未领料", "未关闭", "未冻结", "未作废"].includes(status),
    audited: ["已审核", "成功", "启用", "正常", "已核销", "完全领料", "已完工"].includes(status),
    reversed: ["已反审核", "部分核销", "已关闭"].includes(status),
    warning: ["低库存", "未核销", "高于库存上限", "部分领料", "已冻结"].includes(status),
    danger: ["已作废", "已红冲", "失败", "禁用", "低于安全库存"].includes(status)
  };
}

function isStatusColumn(key: string) {
  return ["status", "auditStatus", "closeStatusLabel", "frozenStatusLabel", "voidStatus"].includes(key);
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
  if (action === "审核") {
    await submitBatchAudit();
    return;
  }
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
  if (action === "删除") {
    await submitBatchDelete();
    return;
  }
  batchMessage.value = `${action}未找到可执行的批量处理，请刷新后重试。`;
}

function closePendingAction() {
  pendingAction.value = "";
  pendingReason.value = "";
  pendingVoidUsername.value = "";
  pendingVoidPassword.value = "";
  pendingActionMessage.value = "";
}

async function submitBatchAudit() {
  const type = documentActionTypeByListKey[props.listKey];
  const targets = selectedUniqueBillRows.value.map((row) => String(row.billNo));
  if (!type || targets.length === 0) {
    batchMessage.value = "请选择可审核的草稿单据。";
    return;
  }
  const results = await Promise.all(targets.map((billNo) => auditDocument(type, billNo)));
  const failed = results.filter((result) => !result.ok);
  batchMessage.value = failed.length
    ? `审核完成 ${targets.length - failed.length}/${targets.length}，失败：${failed[0]?.message || "请检查单据状态"}`
    : `已审核 ${targets.length} 张单据。`;
  await reload();
}

async function submitBatchReverse() {
  const type = documentActionTypeByListKey[props.listKey];
  const targets = selectedUniqueBillRows.value
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
  const targets = selectedUniqueBillRows.value.map((row) => String(row.billNo));
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
  const targets = selectedUniqueBillRows.value.map((row) => String(row.billNo));
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

async function submitBatchDelete() {
  if (isMasterList.value) {
    const count = selectedRows.value.length;
    const deleted = await submitMasterDelete();
    batchMessage.value = deleted ? `已删除 ${count} 条资料。` : "请选择可删除的资料。";
    return;
  }
  const type = documentActionTypeByListKey[props.listKey];
  const targets = selectedUniqueBillRows.value
    .filter(isDraftBillStatus)
    .map((row) => String(row.billNo ?? ""))
    .filter(Boolean);
  if (!type || targets.length === 0) {
    batchMessage.value = "请选择可删除的草稿单据。";
    return;
  }
  const results = await Promise.all(targets.map((billNo) => deleteDocument(type, billNo)));
  const failed = results.filter((result) => !result.ok);
  batchMessage.value = failed.length
    ? `删除完成 ${targets.length - failed.length}/${targets.length}，失败：${failed[0]?.message || "只有草稿单据可以删除"}`
    : `已删除 ${targets.length} 张草稿单据。`;
  await reload();
}

function isAuditedRow(row: Record<string, unknown>) {
  return isAuditedBillStatus(row);
}

function isAuditedMasterRow(row: Record<string, unknown> | undefined) {
  const status = String(row?.auditStatus ?? "").trim();
  return status === "AUDITED" || status === "已审核";
}

function hasPositiveQuantity(value: unknown) {
  const normalized = typeof value === "string" ? value.replace(/,/g, "").trim() : value;
  const quantity = Number(normalized ?? 0);
  return Number.isFinite(quantity) && quantity > 0;
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
    return;
  }
  if (canOpenListRecord(props.listKey)) {
    emit("createListRecord", { listKey: props.listKey, row });
  }
}

function isOpenableMasterCodeColumn(columnKey: string) {
  return (isMasterList.value || isBomList.value)
    && (columnKey === "code" || (props.listKey === "product-name-list" && columnKey === "name"));
}

function openMasterRecord(row: Record<string, unknown>) {
  if (isBomList.value) {
    emit("createListRecord", { listKey: props.listKey, row });
    return;
  }
  if (isMasterList.value) {
    emit("viewMasterData", { listKey: props.listKey, row });
  }
}

function openCreateDialog() {
  if (isMasterList.value) {
    emit("createMasterData", { listKey: props.listKey });
    return;
  }
  if (canCreateListRecord(props.listKey)) {
    emit("createListRecord", { listKey: props.listKey });
    return;
  }
  if (openableDocumentType.value) {
    emit("createDocument", { type: openableDocumentType.value });
  }
}

function canCreateListRecord(listKey: string) {
  return [
    "bom-list",
    "production-plan-list",
    "production-task-form-list",
    "outsourcing-work-order-list",
    "outsourcing-issue-list",
    "outsourcing-receipt-list",
    "outsourcing-return-list",
    "outsourcing-scrap-list",
    "ar-receipt-form-list",
    "ap-payment-form-list"
  ].includes(listKey);
}

function canOpenListRecord(listKey: string) {
  return [
    "production-task-form-list",
    "outsourcing-work-order-list",
    "outsourcing-issue-list",
    "outsourcing-receipt-list",
    "outsourcing-return-list",
    "outsourcing-scrap-list",
    "ar-receipt-form-list",
    "ap-payment-form-list"
  ].includes(listKey);
}

function openEditDialog() {
  const row = selectedRows.value[0];
  if (isMasterList.value && row) {
    emit("editMasterData", { listKey: props.listKey, row });
  }
}

function openCopyDialog() {
  const row = selectedRows.value[0];
  if (isBomList.value && row) {
    emit("createListRecord", { listKey: props.listKey, row, mode: "copy" });
    return;
  }
  if (canCopyMasterRecord.value && row) {
    emit("copyMasterData", { listKey: props.listKey, row });
  }
}

async function submitMasterAudit(audit: boolean) {
  await masterMaintenance.submitAudit(audit);
}

async function submitMasterStatus(enabled: boolean) {
  await masterMaintenance.submitStatus(enabled);
}

async function submitBomStatus(enabled: boolean) {
  if (selectedBomRows.value.length !== 1) {
    batchMessage.value = "BOM 启用/禁用一次只能操作一条。";
    return;
  }
  const targets = selectedBomRows.value
    .filter((row) => enabled ? !isBomRowEnabled(row) : isBomRowEnabled(row))
    .map((row) => String(row.code ?? "").trim())
    .filter(Boolean);
  if (!targets.length) {
    batchMessage.value = enabled ? "请选择禁用 BOM 再启用。" : "请选择启用 BOM 再禁用。";
    return;
  }
  const results = await Promise.all(targets.map((code) => setBomEnabled(code, enabled)));
  const failed = results.filter((result) => !result.ok);
  batchMessage.value = failed.length
    ? `${enabled ? "启用" : "禁用"}完成 ${targets.length - failed.length}/${targets.length}，失败：${failed[0]?.message || "请检查 BOM 状态"}`
    : `已${enabled ? "启用" : "禁用"} ${targets.length} 条 BOM。`;
  await reload();
}

function isBomRowEnabled(row: Record<string, unknown>) {
  return row.enabled === true;
}

async function submitMasterDelete() {
  return masterMaintenance.submitDelete();
}

function toggleBomStatusFilter() {
  if (!isBomList.value) {
    return;
  }
  query.status = query.status === "禁用" ? "启用" : "禁用";
  query.page = 1;
  reload();
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
  return loadStoredColumnPreferences(columnPreferenceKey());
}

function saveColumnPreferences() {
  saveStoredColumnPreferences(columnPreferenceKey(), columns.value);
}

function normalizeListRow(row: Record<string, unknown>) {
  if ((row.billNo == null || row.billNo === "") && typeof row.bill_no === "string") {
    return { ...row, billNo: row.bill_no };
  }
  return row;
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
