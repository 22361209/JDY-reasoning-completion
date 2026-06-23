<template>
  <div class="erp-shell" :class="{ compact: preferences.compactDensity.value, 'module-panel-open': modulePanelOpen }">
    <div class="navigation-zone" @mouseleave="closeNavigation">
      <aside class="primary-nav" aria-label="主模块导航">
        <div class="product-mark" aria-label="JDY">J</div>
        <button
          v-for="module in visibleModules"
          :key="module.name"
          class="primary-nav__item"
          :class="{ active: activeModuleName === module.name }"
          type="button"
          :title="module.name"
          :data-testid="`module-${module.name}`"
          @mouseenter="selectModule(module.name)"
          @focus="selectModule(module.name)"
          @click="selectModule(module.name)"
        >
          <span>{{ module.name }}</span>
        </button>
      </aside>

      <section v-show="modulePanelOpen" class="module-panel" data-testid="module-panel" :aria-hidden="!modulePanelOpen">
        <div class="module-panel__header">
          <div>
            <div class="panel-kicker">功能导航</div>
            <h1>{{ activeModuleName }}</h1>
          </div>
          <div class="panel-tools">
            <button class="panel-close" type="button" title="收起功能导航" @click="modulePanelOpen = false">x</button>
          </div>
        </div>

        <div v-if="activeModule.excluded" class="module-shell">
          <strong>{{ activeModuleName }}</strong>
          <span>该模块不进入首版深层业务，只保留可见壳层。</span>
        </div>

        <div v-else class="entry-groups">
          <section v-for="group in activeModule.groups" :key="group.title" class="entry-group">
            <div class="entry-group__title">{{ group.title }}</div>
            <div class="entry-list">
              <div v-for="entry in group.entries" :key="entry.id" class="entry-row">
                <button
                  class="entry-name"
                  type="button"
                  :data-testid="`entry-${entry.id}`"
                  @click="openEntry(entry)"
                >
                  {{ entry.label }}
                </button>
                <button
                  v-if="entry.queryable"
                  class="entry-query"
                  type="button"
                  :data-testid="`query-${entry.id}`"
                  @click="openEntry({ ...entry, mode: 'list' })"
                >
                  查询
                </button>
              </div>
            </div>
          </section>
        </div>

        <div class="scope-strip">
          <span>审批范围</span>
          <strong>{{ approvedCount }}</strong>
          <span>项首版/简版入口</span>
        </div>
      </section>
    </div>

    <main class="workbench">
      <header class="global-bar">
        <div class="tenant-block">
          <strong>{{ session.tenantName.value }}</strong>
          <span>{{ session.periodLabel.value }}</span>
        </div>
        <label class="global-search">
          <span>搜索</span>
          <input v-model="keyword" placeholder="功能、单据、客户、商品" />
        </label>
        <div class="global-actions">
          <button type="button">消息</button>
          <button type="button">帮助</button>
          <button type="button">反馈</button>
          <div class="user-chip">
            <strong>{{ session.userName.value }}</strong>
            <span>{{ session.userRole.value }}</span>
          </div>
        </div>
      </header>

      <nav class="work-tabs" aria-label="内部页签" data-testid="work-tabs">
        <div
          v-for="tab in tabs.tabs.value"
          :key="tab.id"
          class="work-tab"
          :class="{ active: tabs.activeTabId.value === tab.id, dirty: tab.dirty }"
          role="button"
          tabindex="0"
          :data-testid="`tab-${tab.id}`"
          @click="tabs.activeTabId.value = tab.id"
          @keydown.enter="tabs.activeTabId.value = tab.id"
          @keydown.space.prevent="tabs.activeTabId.value = tab.id"
        >
          <span>{{ tab.title }}</span>
          <button
            v-if="tab.id !== 'home'"
            class="tab-close"
            type="button"
            :aria-label="`关闭${tab.title}`"
            :data-testid="`close-${tab.id}`"
            @click.stop="tabs.requestClose(tab.id)"
          >
            x
          </button>
        </div>
      </nav>

      <section class="content-area" data-testid="content-area">
        <div v-if="tabs.activeTab.value.kind === 'home'" class="home-board">
          <section class="home-head">
            <div>
              <h2>首页工作台</h2>
              <p>统一外壳已承载左侧模块、顶部账套期间、内部页签和高密度主内容区。</p>
            </div>
            <button class="primary-action" type="button" @click="openEntry(demoDirtyEntry)">打开未保存样例</button>
          </section>

          <div class="metric-row">
            <div class="metric">
              <span>首版入口</span>
              <strong>{{ approvedCount }}</strong>
            </div>
            <div class="metric">
              <span>当前页签</span>
              <strong>{{ tabs.tabs.value.length }}/{{ tabs.maxTabs }}</strong>
            </div>
            <div class="metric">
              <span>期间状态</span>
              <strong>打开</strong>
            </div>
            <div class="metric">
              <span>库存缓存</span>
              <strong>无</strong>
            </div>
          </div>

          <div class="quick-grid">
            <button
              v-for="entry in quickEntries"
              :key="entry.id"
              type="button"
              class="quick-entry"
              @click="openEntry(entry)"
            >
              <span>{{ entry.module }}</span>
              <strong>{{ entry.label }}</strong>
              <em>{{ entry.mode === 'form' ? '直达新增' : entry.mode === 'report' ? '报表/工作台' : '查询列表' }}</em>
            </button>
          </div>
        </div>

        <div v-else-if="tabs.activeTab.value.kind === 'panel'" class="panel-page">
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <p>模块功能面板在统一工作容器内打开，左侧和顶部全局区保持稳定。</p>
          <div class="empty-shell">请选择功能名称、查询小按钮或直达新增入口继续。</div>
        </div>

        <div v-else-if="tabs.activeTab.value.kind === 'shell'" class="panel-page">
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <div class="empty-shell">首版范围裁剪：该入口仅保留壳层，不进入深层业务页。</div>
        </div>

        <DataListPage
          v-else-if="tabs.activeTab.value.kind === 'list' || tabs.activeTab.value.kind === 'report'"
          :list-key="tabs.activeTab.value.id"
          :locked="isLockedList"
        />

        <div v-else class="business-page">
          <div class="business-head">
            <div>
              <h2>{{ tabs.activeTab.value.title }}</h2>
              <p>{{ pageSubtitle }}</p>
            </div>
            <div class="status-stamp" :class="tabs.activeTab.value.kind">草稿</div>
          </div>

          <div v-if="isLockedList" class="lock-banner" data-testid="lock-banner">
            单据已在其他页签打开，列表的审核/删除/批量操作已锁定。
            <button type="button" @click="tabs.activeTabId.value = 'sales-order-form'">查看已有单据</button>
          </div>

          <div class="action-bar">
            <button class="primary-action" type="button" :disabled="isLockedList">新增</button>
            <button type="button" :disabled="!isDocumentForm" data-testid="save-sales-order" @click="saveCurrentDocument">保存</button>
            <button type="button" :disabled="!isDocumentForm" data-testid="audit-sales-order" @click="auditCurrentDocument">审核</button>
            <button type="button" :disabled="!isSalesOrderForm" data-testid="delete-sales-order" @click="deleteCurrentSalesOrder">删除</button>
            <button type="button" :disabled="!isSalesOrderForm" data-testid="export-sales-order" @click="exportCurrentSalesOrder">引出</button>
            <button type="button" :disabled="!isSalesOrderForm" data-testid="print-sales-order" @click="printCurrentSalesOrder">打印</button>
            <span v-if="tabs.activeTab.value.dirty" class="dirty-tip">有未保存改动</span>
            <span v-if="formMessage" class="form-message" data-testid="form-message">{{ formMessage }}</span>
          </div>

          <div v-if="isDocumentForm" class="form-layout">
            <section class="form-head-fields">
              <label v-if="isStockDocumentForm">源订单号<input v-model="currentOrderForm.sourceOrderNo" :data-testid="`${formTestPrefix}-source-order-no`" @input="markActiveDirty" /></label>
              <label>
                {{ partyLabel }}编码
                <span class="master-selector">
                  <input
                    v-model="currentOrderForm.partyCode"
                    :data-testid="`${formTestPrefix}-party-code`"
                    @focus="searchMasterOptions(partyType, currentOrderForm.partyCode, `${formTestPrefix}-party`)"
                    @input="handleMasterInput(partyType, currentOrderForm.partyCode, `${formTestPrefix}-party`)"
                  />
                  <span v-if="activeSelector === `${formTestPrefix}-party`" class="master-selector__menu">
                    <button
                      v-for="option in selectorOptions"
                      :key="option.code"
                      type="button"
                      @mousedown.prevent="selectPartyOption(option)"
                    >
                      <strong>{{ option.code }}</strong>
                      <span>{{ option.name }}</span>
                    </button>
                  </span>
                </span>
              </label>
              <label>业务日期<input v-model="currentOrderForm.billDate" :data-testid="`${formTestPrefix}-bill-date`" @input="markActiveDirty" /></label>
              <label>单据编号<input v-model="currentOrderForm.billNo" :data-testid="`${formTestPrefix}-bill-no`" @input="markActiveDirty" /></label>
              <label>部门<input v-model="currentOrderForm.department" :data-testid="`${formTestPrefix}-department`" @input="markActiveDirty" /></label>
            </section>
            <div class="entry-table">
              <table>
                <thead>
                  <tr>
                    <th>商品编码</th>
                    <th>商品名称</th>
                    <th>规格型号</th>
                    <th>仓库</th>
                    <th>数量</th>
                    <th>单价</th>
                    <th>金额</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span class="master-selector in-cell">
                        <input
                          v-model="currentOrderForm.lines[0].productCode"
                          :data-testid="`${formTestPrefix}-line-product`"
                          @focus="searchMasterOptions('product', currentOrderForm.lines[0].productCode, `${formTestPrefix}-product`)"
                          @input="handleMasterInput('product', currentOrderForm.lines[0].productCode, `${formTestPrefix}-product`)"
                        />
                        <span v-if="activeSelector === `${formTestPrefix}-product`" class="master-selector__menu">
                          <button
                            v-for="option in selectorOptions"
                            :key="option.code"
                            type="button"
                            @mousedown.prevent="selectLineProduct(option)"
                          >
                            <strong>{{ option.code }}</strong>
                            <span>{{ option.name }}</span>
                          </button>
                        </span>
                      </span>
                    </td>
                    <td>{{ selectedProduct.name }}</td>
                    <td>{{ selectedProduct.spec }}</td>
                    <td>
                      <span class="master-selector in-cell">
                        <input
                          v-model="currentOrderForm.lines[0].warehouseCode"
                          :data-testid="`${formTestPrefix}-line-warehouse`"
                          @focus="searchMasterOptions('warehouse', currentOrderForm.lines[0].warehouseCode, `${formTestPrefix}-warehouse`)"
                          @input="handleMasterInput('warehouse', currentOrderForm.lines[0].warehouseCode, `${formTestPrefix}-warehouse`)"
                        />
                        <span v-if="activeSelector === `${formTestPrefix}-warehouse`" class="master-selector__menu">
                          <button
                            v-for="option in selectorOptions"
                            :key="option.code"
                            type="button"
                            @mousedown.prevent="selectWarehouseOption(option)"
                          >
                            <strong>{{ option.code }}</strong>
                            <span>{{ option.name }}</span>
                          </button>
                        </span>
                      </span>
                    </td>
                    <td><input v-model.number="currentOrderForm.lines[0].qty" :data-testid="`${formTestPrefix}-line-qty`" @input="markActiveDirty" /></td>
                    <td><input v-model.number="currentOrderForm.lines[0].unitPrice" :data-testid="`${formTestPrefix}-line-price`" @input="markActiveDirty" /></td>
                    <td>{{ currentOrderAmount }}</td>
                  </tr>
                  <tr>
                    <td colspan="7" class="add-line">+ 增加明细行</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-else class="empty-shell">该表单正在等待本批次接入，先保留统一工作区和页签行为。</div>

        </div>
      </section>

      <aside v-if="preferences.showAssistantRail.value" class="assist-rail">
        <button type="button" title="帮助">?</button>
        <button type="button" title="列设置">列</button>
        <button type="button" title="整单">单</button>
      </aside>
    </main>

    <div v-if="tabs.overflowMessage.value" class="modal-mask" data-testid="tab-overflow-modal">
      <div class="dialog">
        <h3>提示</h3>
        <p>{{ tabs.overflowMessage.value }}</p>
        <button class="primary-action" type="button" @click="tabs.clearOverflow">确定</button>
      </div>
    </div>

    <div v-if="tabs.pendingCloseTab.value" class="modal-mask" data-testid="dirty-close-modal">
      <div class="dialog">
        <h3>关闭确认</h3>
        <p>{{ tabs.pendingCloseTab.value.title }} 有未保存内容，关闭后将丢失本次修改。</p>
        <div class="dialog-actions">
          <button type="button" @click="tabs.cancelClose">取消</button>
          <button class="danger-action" type="button" @click="tabs.closeNow(tabs.pendingCloseTab.value!.id)">不保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { featureScope } from "./featureScope";
import DataListPage from "../components/DataListPage.vue";
import { auditDocument, saveDocumentDraft, type DocumentType } from "../services/documentApi";
import { fetchListRows } from "../services/listApi";
import { auditSalesOrder, deleteSalesOrder, exportSalesOrder, printSalesOrder, saveSalesOrderDraft } from "../services/salesOrderApi";
import { fetchSystemSession } from "../services/systemApi";
import { usePreferenceStore } from "../stores/preferences";
import { useSessionStore } from "../stores/session";
import { type WorkTabKind, useTabStore } from "../stores/tabs";

interface ShellEntry {
  id: string;
  label: string;
  module: string;
  mode: WorkTabKind;
  queryable?: boolean;
  dirty?: boolean;
}

interface EntryGroup {
  title: string;
  entries: ShellEntry[];
}

interface ShellModule {
  name: string;
  short: string;
  excluded?: boolean;
  groups: EntryGroup[];
}

interface MasterOption {
  code: string;
  name: string;
  spec?: string;
  unit?: string;
}

interface OrderLineForm {
  productCode: string;
  warehouseCode: string;
  qty: number;
  unitPrice: number;
}

interface OrderForm {
  billNo: string;
  sourceOrderNo?: string;
  partyCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  lines: OrderLineForm[];
}

const session = useSessionStore();
const tabs = useTabStore();
const preferences = usePreferenceStore();
const keyword = ref("");
const activeModuleName = ref("销售管理");
const modulePanelOpen = ref(false);
const suppressNavigationUntil = ref(0);
const formMessage = ref("");
const salesOrderForm = reactive<OrderForm>({
  billNo: "XSDD-00001",
  partyCode: "KH-001",
  billDate: "2026-06-23",
  department: "销售部",
  ownerName: "本地管理员",
  lines: [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 20, unitPrice: 86 }
  ]
});
const purchaseOrderForm = reactive<OrderForm>({
  billNo: "CGDD-00001",
  partyCode: "GYS-001",
  billDate: "2026-06-23",
  department: "采购部",
  ownerName: "本地管理员",
  lines: [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 50, unitPrice: 72 }
  ]
});
const purchaseInForm = reactive<OrderForm>({
  billNo: "CGRK-00001",
  sourceOrderNo: "CGDD-00001",
  partyCode: "GYS-001",
  billDate: "2026-06-23",
  department: "采购部",
  ownerName: "本地管理员",
  lines: [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 72 }
  ]
});
const salesOutForm = reactive<OrderForm>({
  billNo: "XSCK-00001",
  sourceOrderNo: "XSDD-00001",
  partyCode: "KH-001",
  billDate: "2026-06-23",
  department: "销售部",
  ownerName: "本地管理员",
  lines: [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 86 }
  ]
});
const activeSelector = ref("");
const selectorOptions = ref<MasterOption[]>([]);
let selectorRequestSeq = 0;

const moduleCatalog: ShellModule[] = [
  {
    name: "销售管理",
    short: "销",
    groups: [
      { title: "销售业务", entries: [
        { id: "sales-order-form", label: "销售订单", module: "销售管理", mode: "form", queryable: true, dirty: true },
        { id: "sales-out-form", label: "销售出库单", module: "销售管理", mode: "form", queryable: true, dirty: true },
        { id: "sales-return-form", label: "销售退货申请", module: "销售管理", mode: "form" }
      ] },
      { title: "报表查询", entries: [
        { id: "sales-detail-report", label: "销售明细表", module: "销售管理", mode: "report", queryable: true },
        { id: "sales-profit-report", label: "销售利润表", module: "销售管理", mode: "report" }
      ] }
    ]
  },
  {
    name: "采购管理",
    short: "采",
    groups: [
      { title: "采购业务", entries: [
        { id: "purchase-order-form", label: "采购订单", module: "采购管理", mode: "form", queryable: true, dirty: true },
        { id: "purchase-in-form", label: "采购入库单", module: "采购管理", mode: "form", queryable: true, dirty: true },
        { id: "purchase-return-form", label: "采购退货单", module: "采购管理", mode: "form" }
      ] },
      { title: "报表查询", entries: [
        { id: "purchase-summary-report", label: "采购汇总表", module: "采购管理", mode: "report", queryable: true }
      ] }
    ]
  },
  {
    name: "库存管理",
    short: "库",
    groups: [
      { title: "库存业务", entries: [
        { id: "inventory-query-list", label: "库存查询", module: "库存管理", mode: "report", queryable: true },
        { id: "stock-transfer-form", label: "调拨单", module: "库存管理", mode: "form", queryable: true },
        { id: "other-in-form", label: "其他入库单", module: "库存管理", mode: "form" }
      ] },
      { title: "流水报表", entries: [
        { id: "stock-flow-report", label: "商品收发明细表", module: "库存管理", mode: "report", queryable: true },
        { id: "scrap-report", label: "材料报废统计表", module: "库存管理", mode: "report" }
      ] }
    ]
  },
  {
    name: "应收应付",
    short: "款",
    groups: [
      { title: "往来单据", entries: [
        { id: "receivable-list", label: "应收单", module: "应收应付", mode: "list", queryable: true },
        { id: "payable-list", label: "应付单", module: "应收应付", mode: "list", queryable: true }
      ] },
      { title: "往来报表", entries: [
        { id: "ar-summary-report", label: "应收汇总表", module: "应收应付", mode: "report", queryable: true }
      ] }
    ]
  },
  {
    name: "生产管理",
    short: "产",
    groups: [
      { title: "生产执行", entries: [
        { id: "production-task-form", label: "生产任务单", module: "生产管理", mode: "form", queryable: true },
        { id: "material-issue-form", label: "生产领料单", module: "生产管理", mode: "form", queryable: true },
        { id: "product-in-form", label: "产品入库单", module: "生产管理", mode: "form", queryable: true }
      ] },
      { title: "BOM 与报表", entries: [
        { id: "bom-list", label: "BOM维护", module: "生产管理", mode: "list", queryable: true },
        { id: "task-track-report", label: "生产任务跟踪表", module: "生产管理", mode: "report", queryable: true }
      ] }
    ]
  },
  {
    name: "委外管理",
    short: "委",
    groups: [
      { title: "委外业务", entries: [
        { id: "outsourcing-order-form", label: "委外订单", module: "委外管理", mode: "form", queryable: true },
        { id: "outsourcing-in-list", label: "委外入库单", module: "委外管理", mode: "list", queryable: true }
      ] }
    ]
  },
  {
    name: "基础资料",
    short: "资",
    groups: [
      { title: "资料维护", entries: [
        { id: "product-master-list", label: "商品资料", module: "基础资料", mode: "list", queryable: true },
        { id: "customer-master-list", label: "客户", module: "基础资料", mode: "list", queryable: true },
        { id: "supplier-master-list", label: "供应商", module: "基础资料", mode: "list", queryable: true },
        { id: "warehouse-master-list", label: "仓库", module: "基础资料", mode: "list", queryable: true }
      ] }
    ]
  },
  {
    name: "系统设置",
    short: "设",
    groups: [
      { title: "系统基础", entries: [
        { id: "coding-rule-list", label: "编码规则", module: "系统设置", mode: "list", queryable: true },
        { id: "user-role-list", label: "用户角色", module: "系统设置", mode: "list", queryable: true },
        { id: "operation-log-list", label: "操作日志", module: "系统设置", mode: "list", queryable: true }
      ] }
    ]
  },
  {
    name: "快捷应用",
    short: "快",
    groups: [
      { title: "可见壳层", entries: [
        { id: "quick-sales-shell", label: "销售快速发起", module: "快捷应用", mode: "shell" },
        { id: "quick-purchase-shell", label: "采购快速发起", module: "快捷应用", mode: "shell" }
      ] }
    ]
  }
];

const excludedModules = ["老板参谋", "客户经营", "协同助手", "自定义中心"].map((name) => ({
  name,
  short: name.slice(0, 1),
  excluded: true,
  groups: []
}));

const visibleModules = [...moduleCatalog, ...excludedModules];
const activeModule = computed(() => visibleModules.find((module) => module.name === activeModuleName.value) ?? moduleCatalog[0]);
const approvedCount = computed(() => featureScope.filter((feature) => feature.decision === "build" || feature.decision === "simple").length);
const quickEntries = computed(() => moduleCatalog.flatMap((module) => module.groups.flatMap((group) => group.entries)).slice(0, 8));
const demoDirtyEntry = computed<ShellEntry>(() => ({ id: "sales-order-form", label: "销售订单", module: "销售管理", mode: "form", queryable: true, dirty: true })).value;

const pageSubtitle = computed(() => {
  if (tabs.activeTab.value.kind === "report") {
    return "查询条件、结果表、列设置和打印/引出入口在统一工作区内承载。";
  }
  if (tabs.activeTab.value.kind === "form") {
    return "单头字段、分录表格、保存/审核动作和未保存状态使用同一外壳。";
  }
  return "列表工具栏、批量动作、选中态、锁定态和分页预留在同一范式内。";
});

const isLockedList = computed(() => {
  return tabs.activeTab.value.id === "sales-order-form-list" && tabs.tabs.value.some((tab) => tab.id === "sales-order-form");
});
const isSalesOrderForm = computed(() => tabs.activeTab.value.id === "sales-order-form");
const isPurchaseOrderForm = computed(() => tabs.activeTab.value.id === "purchase-order-form");
const isPurchaseInForm = computed(() => tabs.activeTab.value.id === "purchase-in-form");
const isSalesOutForm = computed(() => tabs.activeTab.value.id === "sales-out-form");
const isStockDocumentForm = computed(() => isPurchaseInForm.value || isSalesOutForm.value);
const isDocumentForm = computed(() => isSalesOrderForm.value || isPurchaseOrderForm.value || isPurchaseInForm.value || isSalesOutForm.value);
const currentOrderForm = computed(() => {
  if (isPurchaseOrderForm.value) {
    return purchaseOrderForm;
  }
  if (isPurchaseInForm.value) {
    return purchaseInForm;
  }
  if (isSalesOutForm.value) {
    return salesOutForm;
  }
  return salesOrderForm;
});
const formTestPrefix = computed(() => {
  if (isPurchaseOrderForm.value) {
    return "purchase";
  }
  if (isPurchaseInForm.value) {
    return "purchase-in";
  }
  if (isSalesOutForm.value) {
    return "sales-out";
  }
  return "sales";
});
const partyLabel = computed(() => (isPurchaseOrderForm.value || isPurchaseInForm.value) ? "供应商" : "客户");
const partyType = computed(() => (isPurchaseOrderForm.value || isPurchaseInForm.value) ? "supplier" : "customer");
const currentOrderAmount = computed(() => (currentOrderForm.value.lines[0].qty * currentOrderForm.value.lines[0].unitPrice).toFixed(2));
const selectedProduct = computed(() => {
  const product = selectorOptions.value.find((option) => option.code === currentOrderForm.value.lines[0].productCode);
  if (product) {
    return { name: product.name, spec: product.spec ?? "", unit: product.unit ?? "" };
  }
  if (currentOrderForm.value.lines[0].productCode === "CP-001") {
    return { name: "控制臂总成", spec: "左前 / 黑色", unit: "只" };
  }
  return { name: "", spec: "", unit: "" };
});

onMounted(async () => {
  const remoteSession = await fetchSystemSession();
  if (remoteSession) {
    session.userName.value = remoteSession.user.name;
    session.userRole.value = remoteSession.user.role;
    session.tenantName.value = remoteSession.tenant.name;
    session.accountingPeriod.value = remoteSession.period.accounting;
    session.businessPeriod.value = remoteSession.period.business;
  }
});

function selectModule(name: string) {
  if (Date.now() < suppressNavigationUntil.value) {
    return;
  }
  activeModuleName.value = name;
  modulePanelOpen.value = true;
}

function openEntry(entry: ShellEntry) {
  activeModuleName.value = entry.module;
  const isQuery = entry.mode === "list" || entry.mode === "report";
  const id = entry.mode === "list" && !entry.id.endsWith("-list") ? `${entry.id}-list` : entry.id;
  tabs.openTab({
    id,
    title: isQuery && !entry.label.includes("表") && !entry.label.includes("查询") ? `${entry.label}列表` : entry.label,
    module: entry.module,
    kind: entry.mode,
    dirty: entry.dirty,
    lockedObjectId: entry.id === "sales-order-form" ? "XSDD-00001" : undefined
  });
  modulePanelOpen.value = false;
  suppressNavigationUntil.value = Date.now() + 250;
}

function closeNavigation() {
  modulePanelOpen.value = false;
  suppressNavigationUntil.value = 0;
}

async function saveCurrentSalesOrder() {
  formMessage.value = "";
  const result = await saveSalesOrderDraft({
    billNo: salesOrderForm.billNo,
    customerCode: salesOrderForm.partyCode,
    billDate: salesOrderForm.billDate,
    department: salesOrderForm.department,
    ownerName: salesOrderForm.ownerName,
    lines: salesOrderForm.lines.map((line) => ({ ...line }))
  });
  formMessage.value = result.ok ? "草稿已保存" : result.message;
  if (result.ok) {
    const activeTab = tabs.tabs.value.find((tab) => tab.id === tabs.activeTabId.value);
    if (activeTab) {
      activeTab.dirty = false;
    }
  }
}

async function saveCurrentDocument() {
  if (isSalesOrderForm.value) {
    await saveCurrentSalesOrder();
    return;
  }
  const type = currentDocumentType();
  if (!type) {
    return;
  }
  formMessage.value = "";
  const result = await saveDocumentDraft(type, {
    billNo: currentOrderForm.value.billNo,
    sourceOrderNo: currentOrderForm.value.sourceOrderNo,
    partyCode: currentOrderForm.value.partyCode,
    billDate: currentOrderForm.value.billDate,
    department: currentOrderForm.value.department,
    ownerName: currentOrderForm.value.ownerName,
    lines: currentOrderForm.value.lines.map((line) => ({ ...line }))
  });
  formMessage.value = result.ok ? "草稿已保存" : result.message;
  if (result.ok) {
    clearActiveDirty();
  }
}

async function auditCurrentSalesOrder() {
  const result = await auditSalesOrder(salesOrderForm.billNo);
  formMessage.value = result.ok ? "审核成功" : result.message;
}

async function auditCurrentDocument() {
  if (isSalesOrderForm.value) {
    await auditCurrentSalesOrder();
    return;
  }
  const type = currentDocumentType();
  if (!type) {
    return;
  }
  const result = await auditDocument(type, currentOrderForm.value.billNo);
  formMessage.value = result.ok ? "审核成功" : result.message;
}

async function deleteCurrentSalesOrder() {
  const result = await deleteSalesOrder(salesOrderForm.billNo);
  formMessage.value = result.ok ? "删除成功" : result.message;
  if (result.ok) {
    const activeTab = tabs.tabs.value.find((tab) => tab.id === tabs.activeTabId.value);
    if (activeTab) {
      activeTab.dirty = false;
    }
  }
}

async function exportCurrentSalesOrder() {
  const result = await exportSalesOrder(salesOrderForm.billNo);
  formMessage.value = result.ok ? "引出数据已生成" : result.message;
}

async function printCurrentSalesOrder() {
  const result = await printSalesOrder(salesOrderForm.billNo);
  formMessage.value = result.ok ? "打印数据已生成" : result.message;
}

function markActiveDirty() {
  const activeTab = tabs.tabs.value.find((tab) => tab.id === tabs.activeTabId.value);
  if (activeTab && activeTab.kind === "form") {
    activeTab.dirty = true;
  }
}

function clearActiveDirty() {
  const activeTab = tabs.tabs.value.find((tab) => tab.id === tabs.activeTabId.value);
  if (activeTab) {
    activeTab.dirty = false;
  }
}

function currentDocumentType(): DocumentType | null {
  if (isPurchaseOrderForm.value) {
    return "purchaseOrder";
  }
  if (isPurchaseInForm.value) {
    return "purchaseIn";
  }
  if (isSalesOutForm.value) {
    return "salesOut";
  }
  return null;
}

function handleMasterInput(type: string, keywordValue: string, selectorId: string) {
  markActiveDirty();
  void searchMasterOptions(type, keywordValue, selectorId);
}

async function searchMasterOptions(type: string, keywordValue: string, selectorId: string) {
  activeSelector.value = selectorId;
  selectorOptions.value = [];
  const requestSeq = selectorRequestSeq + 1;
  selectorRequestSeq = requestSeq;
  const listKeyByType: Record<string, string> = {
    customer: "customer-master-list",
    supplier: "supplier-master-list",
    product: "product-master-list",
    warehouse: "warehouse-master-list"
  };
  const result = await fetchListRows(listKeyByType[type], {
    keyword: keywordValue,
    status: "",
    page: 1,
    pageSize: 20
  });
  if (requestSeq !== selectorRequestSeq || activeSelector.value !== selectorId) {
    return;
  }
  if (!result.ok || !result.data) {
    selectorOptions.value = [];
    return;
  }
  selectorOptions.value = result.data.rows.map((row) => ({
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    spec: row.spec ? String(row.spec) : "",
    unit: row.unit ? String(row.unit) : ""
  }));
}

function selectPartyOption(option: MasterOption) {
  currentOrderForm.value.partyCode = option.code;
  activeSelector.value = "";
  markActiveDirty();
}

function selectWarehouseOption(option: MasterOption) {
  currentOrderForm.value.lines[0].warehouseCode = option.code;
  activeSelector.value = "";
  markActiveDirty();
}

function selectLineProduct(option: MasterOption) {
  currentOrderForm.value.lines[0].productCode = option.code;
  activeSelector.value = "";
  markActiveDirty();
}
</script>
