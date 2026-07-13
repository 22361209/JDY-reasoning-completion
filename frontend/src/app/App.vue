<template>
  <LoginPage v-if="!isAuthenticated" ref="loginPageRef" :account-sets="loginAccountSets" :message="loginPageMessage" @login-success="handleLoginSuccess" />
  <div v-else class="erp-shell" :class="{ compact: preferences.compactDensity.value, 'module-panel-open': modulePanelOpen }">
    <div class="navigation-zone" @mouseleave="closeNavigation">
      <aside class="primary-nav" aria-label="主模块导航">
        <div class="product-mark" aria-label="BLD">BLD</div>
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
          <section v-for="group in activeEntryGroups" :key="group.title" class="entry-group">
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
                  @click="openQueryEntry(entry)"
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
        <details class="tenant-switcher">
          <summary>
            <strong>{{ session.tenantName.value }}</strong>
            <span>{{ session.periodLabel.value }}</span>
          </summary>
          <div class="global-menu tenant-menu" data-testid="tenant-switch-menu">
            <strong>当前账套</strong>
            <span>{{ currentAccountSet?.name || session.tenantName.value }}</span>
            <em>{{ session.accountSetCode.value }} / {{ currentAccountSetStatus }}</em>
            <div class="tenant-menu__list" data-testid="tenant-switch-list">
              <button
                v-for="accountSet in accountSets"
                :key="accountSet.code"
                type="button"
                class="tenant-menu__row"
                :class="{ active: accountSet.code === session.accountSetCode.value }"
                :disabled="accountSet.code === session.accountSetCode.value || accountSetSwitching"
                :data-testid="`tenant-switch-${accountSet.code}`"
                @click="requestAccountSetSwitch(accountSet.code)"
              >
                <strong>{{ accountSet.name }}</strong>
                <span>{{ accountSet.code }} / {{ accountSet.initialized ? "已初始化" : "未初始化" }}</span>
              </button>
            </div>
            <button v-if="isAdminUser" type="button" data-testid="tenant-menu-open-account-set" @click="openAccountSetSettings">账套管理/初始化</button>
          </div>
        </details>
        <label class="global-search">
          <span>搜索</span>
          <input v-model="keyword" placeholder="功能、单据、客户、商品" />
        </label>
        <div class="global-actions">
          <details class="user-menu">
            <summary class="user-chip" data-testid="session-account-menu">
              <strong data-testid="session-user-name">{{ session.userName.value }}</strong>
              <span data-testid="session-user-role">{{ session.userRole.value }}</span>
            </summary>
            <div class="global-menu account-menu">
              <div v-if="isAdminUser" class="account-menu__section">
                <strong>账套</strong>
                <select v-model="selectedAccountSetCode" data-testid="account-menu-account-set">
                  <option v-for="accountSet in accountSets" :key="accountSet.code" :value="accountSet.code">{{ accountSet.name }}</option>
                </select>
                <button type="button" data-testid="account-menu-switch-account-set" @click="switchAccountSetFromMenu">切换账套</button>
                <button type="button" data-testid="account-menu-open-account-set" @click="openAccountSetSettings">账套管理/初始化</button>
                <small v-if="accountSetSwitchMessage" data-testid="account-set-switch-message">{{ accountSetSwitchMessage }}</small>
              </div>
              <button type="button" data-testid="session-password-change" @click="passwordChangeDialogRef?.openPasswordDialog()">修改密码</button>
              <button type="button" data-testid="session-logout" @click="logoutCurrentUser">退出登录</button>
            </div>
          </details>
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
              <p data-testid="home-account-set-summary">当前账套：{{ session.tenantName.value }}（{{ session.accountSetCode.value }} / {{ currentAccountSetStatus }}）</p>
            </div>
          </section>
          <div class="quick-grid">
            <section v-for="group in homeQuickGroups" :key="group.module" class="quick-card">
              <div class="quick-card__head">
                <strong>{{ group.module }}</strong>
                <span>{{ group.entries.length }}</span>
              </div>
              <div class="quick-card__body">
                <button
                  v-for="entry in group.entries"
                  :key="entry.id"
                  type="button"
                  class="quick-entry"
                  @click="openEntry(entry)"
                >
                  {{ entry.label }}
                </button>
              </div>
            </section>
          </div>
        </div>
        <div v-else-if="tabs.activeTab.value.kind === 'panel'" class="panel-page">
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <p>模块功能面板在统一工作容器内打开，左侧和顶部全局区保持稳定。</p>
          <div class="empty-shell">请选择功能名称、查询小按钮或直达新增入口继续。</div>
        </div>
        <div v-else-if="tabs.activeTab.value.kind === 'shell' && !['account-set-settings', 'opening-stock-settings', 'numbering-rule-settings', 'print-template-settings', 'role-permission-settings', 'user-role-list', 'security-settings', 'notification-provider-settings'].includes(tabs.activeTab.value.id)" class="panel-page">
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <div class="empty-shell">首版范围裁剪：该入口仅保留壳层，不进入深层业务页。</div>
        </div>
        <AccountSetSettingsPage
          v-else-if="tabs.activeTab.value.id === 'account-set-settings'"
          :account-sets="accountSets"
          :current-account-set-code="session.accountSetCode.value"
          :can-manage="isAdminUser"
          @account-sets-changed="replaceAccountSets"
          @account-set-switch-requested="requestAccountSetSwitch"
        />
        <OpeningStockPage
          v-else-if="tabs.activeTab.value.id === 'opening-stock-settings'"
        />
        <NumberingRuleSettingsPage
          v-else-if="tabs.activeTab.value.id === 'numbering-rule-settings'"
          :can-manage="canManageNumberingRules"
        />
        <SecuritySettingsPage
          v-else-if="tabs.activeTab.value.id === 'security-settings'"
          :can-manage="canManageSecuritySettings"
          @password-policy-updated="activePasswordPolicy = $event"
        />
        <NotificationProviderSettingsPage
          v-else-if="tabs.activeTab.value.id === 'notification-provider-settings'"
          :can-manage="canManageNotificationProviderSettings"
        />
        <UserManagementPage
          v-else-if="tabs.activeTab.value.id === 'user-role-list'"
          :can-manage="canManageRolePermissions"
        />
        <PermissionMatrixPage
          v-else-if="tabs.activeTab.value.id === 'role-permission-settings'"
          :can-manage="canManageRolePermissions"
        />
        <div v-else-if="tabs.activeTab.value.id === 'print-template-settings'" class="print-template-page">
          <section class="print-template-head">
            <div>
              <h2>打印模板</h2>
              <p>维护单据 PDF/HTML 输出的公司抬头、模板名、页脚、签字栏、公司章和默认模板。</p>
            </div>
            <div class="print-template-head__actions">
              <button type="button" :disabled="!canManagePrintTemplates" data-testid="print-template-copy" @click="copyActivePrintTemplate">另存为副本</button>
              <button class="primary-action" type="button" :disabled="!canManagePrintTemplates" data-testid="print-template-save" @click="saveActivePrintTemplate">保存</button>
            </div>
          </section>
          <section class="print-template-body">
            <aside class="print-template-list" aria-label="单据类型">
              <button
                v-for="template in printDocumentOptions"
                :key="template.documentType"
                type="button"
                :class="{ active: template.documentType === printTemplateForm.documentType }"
                :data-testid="`print-template-row-${template.documentType}`"
                @click="selectPrintTemplate(template.documentType)"
              >
                <strong>{{ template.documentTitle }}</strong>
                <span>{{ template.templateName }}{{ template.roleCode ? ` / ${template.roleCode}` : "" }}</span>
              </button>
            </aside>
            <form class="print-template-form" @submit.prevent="saveActivePrintTemplate">
              <label>
                单据类型
                <select v-model="printTemplateForm.documentType" data-testid="print-template-document-type" @change="selectPrintTemplate(printTemplateForm.documentType)">
                  <option v-for="template in printDocumentOptions" :key="template.documentType" :value="template.documentType">{{ template.documentTitle }}</option>
                </select>
              </label>
              <label>
                当前模板
                <select v-model="printTemplateForm.templateCode" data-testid="print-template-code" @change="selectPrintTemplate(printTemplateForm.documentType, printTemplateForm.templateCode)">
                  <option v-for="template in currentDocumentTemplates" :key="template.templateCode" :value="template.templateCode">
                    {{ template.templateName }}（{{ template.roleCode || "通用" }}）{{ template.isDefault ? "（默认）" : "" }}
                  </option>
                </select>
              </label>
              <label>
                作用范围
                <select v-model="printTemplateForm.roleCode" data-testid="print-template-role-code">
                  <option value="">通用</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </label>
              <label>
                模板名称
                <input v-model="printTemplateForm.templateName" data-testid="print-template-name" @input="printTemplateEdited = true" />
              </label>
              <label>
                纸张
                <select v-model="printTemplateForm.paperSize" data-testid="print-template-paper-size">
                  <option value="A4">A4</option>
                  <option value="A5">A5</option>
                </select>
              </label>
              <label>
                方向
                <select v-model="printTemplateForm.pageOrientation" data-testid="print-template-page-orientation">
                  <option value="PORTRAIT">纵向</option>
                  <option value="LANDSCAPE">横向</option>
                </select>
              </label>
              <label>
                联次
                <input v-model.number="printTemplateForm.copyCount" type="number" min="1" max="5" step="1" data-testid="print-template-copy-count" />
              </label>
              <label>
                公司抬头
                <input v-model="printTemplateForm.companyName" data-testid="print-template-company" @input="printTemplateEdited = true" />
              </label>
              <div class="print-template-margin-grid print-template-form__wide">
                <label>
                  上边距 mm
                  <input v-model="printTemplateForm.marginTopMm" inputmode="decimal" data-testid="print-template-margin-top" />
                </label>
                <label>
                  右边距 mm
                  <input v-model="printTemplateForm.marginRightMm" inputmode="decimal" data-testid="print-template-margin-right" />
                </label>
                <label>
                  下边距 mm
                  <input v-model="printTemplateForm.marginBottomMm" inputmode="decimal" data-testid="print-template-margin-bottom" />
                </label>
                <label>
                  左边距 mm
                  <input v-model="printTemplateForm.marginLeftMm" inputmode="decimal" data-testid="print-template-margin-left" />
                </label>
              </div>
              <label>
                页眉说明
                <input v-model="printTemplateForm.headerNote" data-testid="print-template-header-note" @input="printTemplateEdited = true" />
              </label>
              <label class="print-template-form__wide">
                页脚说明
                <textarea v-model="printTemplateForm.footerNote" rows="3" data-testid="print-template-footer-note" @input="printTemplateEdited = true"></textarea>
              </label>
              <div class="print-template-switches">
                <label>
                  <input v-model="printTemplateForm.showSignature" type="checkbox" data-testid="print-template-show-signature" />
                  签字栏
                </label>
                <label>
                  <input v-model="printTemplateForm.showSeal" type="checkbox" data-testid="print-template-show-seal" />
                  公司章区域
                </label>
                <label>
                  <input v-model="printTemplateForm.isDefault" type="checkbox" data-testid="print-template-is-default" />
                  默认模板
                </label>
              </div>
              <div class="print-template-preview" data-testid="print-template-preview">
                <strong>{{ activePrintTemplateTitle }}</strong>
                <span>{{ printTemplateForm.companyName }}</span>
                <span>{{ printTemplateForm.templateName }}</span>
                <span>{{ printTemplateForm.paperSize }} / {{ printTemplateForm.pageOrientation === "LANDSCAPE" ? "横向" : "纵向" }} / {{ printTemplateForm.copyCount }}联</span>
                <small>边距 {{ printTemplateForm.marginTopMm }} / {{ printTemplateForm.marginRightMm }} / {{ printTemplateForm.marginBottomMm }} / {{ printTemplateForm.marginLeftMm }} mm</small>
                <small>{{ printTemplateForm.footerNote }}</small>
              </div>
              <p v-if="printTemplateMessage" class="form-message" data-testid="print-template-message">{{ printTemplateMessage }}</p>
            </form>
          </section>
        </div>
        <DataListPage
          v-else-if="tabs.activeTab.value.kind === 'list' || tabs.activeTab.value.kind === 'report' || Boolean(documentTypeByListTabId(tabs.activeTabId.value))"
          :list-key="tabs.activeTabId.value"
          :locked="false"
          locked-object-id=""
          @push-down-sales-out="openDeliveryNoticeFromSalesOrder"
          @push-down-purchase-in="openPurchaseInFromPurchaseOrder"
          @open-document="openDocumentFromList"
          @create-document="openCreateDocumentFromList"
          @create-list-record="openCreateListRecord"
          @create-master-data="openCreateMasterData"
          @view-master-data="openViewMasterData"
          @edit-master-data="openEditMasterData"
          @copy-master-data="openCopyMasterData"
        />
        <MasterDataRecordPage
          v-else-if="activeMasterRecord"
          :record-id="activeMasterRecord.id"
          :editing="activeMasterRecord.editing"
          :read-only="activeMasterRecord.readOnly"
          :persisted="Boolean(activeMasterRecord.originalCode)"
          :dirty="activeMasterRecordDirty"
          :protect-audited-edit="activeMasterRecord.sparsePatch"
          :can-maintain="canMaintainActiveMasterRecord"
          :allow-delete="activeMasterRecord.allowDelete"
          :title="activeMasterRecord.title"
          :fields="activeMasterRecord.fields"
          :form="activeMasterRecord.form"
          :original-form="activeMasterRecord.originalForm"
          :error="activeMasterRecord.error"
          @cancel="cancelActiveMasterRecord"
          @new-record="openNewActiveMasterRecord"
          @save="saveActiveMasterRecord"
          @audit="auditActiveMasterRecord"
          @reverse-audit="reverseAuditActiveMasterRecord"
          @toggle-status="toggleActiveMasterStatus"
          @delete-record="deleteActiveMasterRecord"
          @edit-record="editActiveMasterRecord"
          @update-field="updateActiveMasterField"
        />
        <SalesOrderForm
          v-else-if="isSalesOrderForm"
          ref="salesOrderFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = 'sales-order-form'"
          @override-lock="overrideActiveDocumentLock"
          @push-down-delivery-notice="openDeliveryNoticeFromSalesOrder"
          @request-open-document="openDocumentFromModule"
        />
        <SalesQuoteForm
          v-else-if="isSalesQuoteForm"
          ref="salesQuoteFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = salesQuoteTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <SalesOutForm
          v-else-if="tabs.activeTab.value.id === outboundTabId"
          ref="outboundFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = outboundTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
          @request-settlement="openSettlementFromSource('receipt', $event)"
        />
        <DeliveryNoticeForm
          v-else-if="tabs.activeTab.value.id === deliveryNoticeTabId"
          ref="deliveryNoticeFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = deliveryNoticeTabId"
          @override-lock="overrideActiveDocumentLock"
          @push-down-sales-out="openOutboundFromDeliveryNotice"
          @request-open-document="openDocumentFromModule"
        />
        <PurchaseOrderForm
          v-else-if="tabs.activeTab.value.id === purchaseOrderTabId"
          ref="purchaseOrderFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = purchaseOrderTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <PurchaseInForm
          v-else-if="tabs.activeTab.value.id === purchaseInTabId"
          ref="purchaseInFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = purchaseInTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
          @request-settlement="openSettlementFromSource('payment', $event)"
        />
        <SettlementDocumentForm
          v-else-if="tabs.activeTab.value.id === receiptTabId"
          ref="receiptFormRef"
          kind="receipt"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
        />
        <SettlementDocumentForm
          v-else-if="tabs.activeTab.value.id === paymentTabId"
          ref="paymentFormRef"
          kind="payment"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
        />
        <PurchaseReturnForm
          v-else-if="tabs.activeTab.value.id === purchaseReturnTabId"
          ref="purchaseReturnFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = purchaseReturnTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <MaterialIssueForm
          v-else-if="tabs.activeTab.value.id === materialIssueTabId"
          ref="materialIssueFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = materialIssueTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <ProductInForm
          v-else-if="tabs.activeTab.value.id === productInTabId"
          ref="productInFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = productInTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <BomForm
          v-else-if="tabs.activeTab.value.id === bomFormTabId"
          ref="bomFormRef"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = 'bom-list'"
        />
        <ProductionPlanForm
          v-else-if="tabs.activeTab.value.id === productionPlanTabId"
          ref="productionPlanFormRef"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = 'production-plan-list'"
        />
        <ProductionTaskForm
          v-else-if="tabs.activeTab.value.id === productionTaskTabId"
          ref="productionTaskFormRef"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @request-open-document="openDocumentFromModule"
        />
        <OutsourcingDocumentForm
          v-else-if="tabs.activeTab.value.id === outsourcingWorkOrderTabId"
          ref="outsourcingWorkOrderFormRef"
          kind="workOrder"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
        />
        <OutsourcingDocumentForm
          v-else-if="tabs.activeTab.value.id === outsourcingIssueTabId"
          ref="outsourcingIssueFormRef"
          kind="issue"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
        />
        <OutsourcingDocumentForm
          v-else-if="tabs.activeTab.value.id === outsourcingReceiptTabId"
          ref="outsourcingReceiptFormRef"
          kind="receipt"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
        />
        <OutsourcingDocumentForm
          v-else-if="tabs.activeTab.value.id === outsourcingReturnTabId"
          ref="outsourcingReturnFormRef"
          kind="return"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
        />
        <OutsourcingDocumentForm
          v-else-if="tabs.activeTab.value.id === outsourcingScrapTabId"
          ref="outsourcingScrapFormRef"
          kind="scrap"
          :title="tabs.activeTab.value.title"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
        />
        <OtherStockInForm
          v-else-if="tabs.activeTab.value.id === otherStockInTabId"
          ref="otherStockInFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = otherStockInTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <OtherStockOutForm
          v-else-if="tabs.activeTab.value.id === otherStockOutTabId"
          ref="otherStockOutFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = otherStockOutTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <StockTransferForm
          v-else-if="tabs.activeTab.value.id === stockTransferTabId"
          ref="stockTransferFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = stockTransferTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <StockCountForm
          v-else-if="tabs.activeTab.value.id === stockCountTabId"
          ref="stockCountFormRef"
          variant="count"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = stockCountTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <StockCountForm
          v-else-if="tabs.activeTab.value.id === stockCountGainTabId"
          ref="stockCountGainFormRef"
          variant="gain"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = stockCountGainTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <StockCountForm
          v-else-if="tabs.activeTab.value.id === stockCountLossTabId"
          ref="stockCountLossFormRef"
          variant="loss"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="activeLockReadOnly"
          :lock-message="activeLockMessage"
          :can-override-lock="activeLockCanOverride"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = stockCountLossTabId"
          @override-lock="overrideActiveDocumentLock"
          @request-open-document="openDocumentFromModule"
        />
        <div
          v-else
          class="panel-page"
        >
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <p>该入口保留统一工作区页签，等待后续批次接入。</p>
        </div>
      </section>
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
    <PasswordChangeDialog ref="passwordChangeDialogRef" :password-policy="activePasswordPolicy" @changed="handlePasswordChanged" />
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { featureScope } from "./featureScope";
import {
  defaultPrintTemplateForm,
  normalizeDocumentCurrency,
  printTemplateDocumentTypes,
  type PendingPushLine,
} from "./documentModel";
import { excludedModules, moduleCatalog } from "../modules/catalog";
import DataListPage from "../components/DataListPage.vue";
import { fieldOptionValue } from "../components/fields/fieldOptions";
import OtherStockInForm from "../modules/inventory/other-stock-in/OtherStockInForm.vue";
import OtherStockOutForm from "../modules/inventory/other-stock-out/OtherStockOutForm.vue";
import StockCountForm from "../modules/inventory/stock-count/StockCountForm.vue";
import StockTransferForm from "../modules/inventory/stock-transfer/StockTransferForm.vue";
import MaterialIssueForm from "../modules/production/material-issue/MaterialIssueForm.vue";
import BomForm from "../modules/production/bom/BomForm.vue";
import ProductionPlanForm from "../modules/production/production-plan/ProductionPlanForm.vue";
import ProductionTaskForm from "../modules/production/production-task/ProductionTaskForm.vue";
import ProductInForm from "../modules/production/product-in/ProductInForm.vue";
import OutsourcingDocumentForm from "../modules/outsourcing/OutsourcingDocumentForm.vue";
import PurchaseInForm from "../modules/purchase/purchase-in/PurchaseInForm.vue";
import PurchaseOrderForm from "../modules/purchase/purchase-order/PurchaseOrderForm.vue";
import PurchaseReturnForm from "../modules/purchase/purchase-return/PurchaseReturnForm.vue";
import SalesQuoteForm from "../modules/sales/sales-quote/SalesQuoteForm.vue";
import SalesOrderForm from "../modules/sales/sales-order/SalesOrderForm.vue";
import DeliveryNoticeForm from "../modules/sales/delivery-notice/DeliveryNoticeForm.vue";
import SalesOutForm from "../modules/sales/sales-out/SalesOutForm.vue";
import SettlementDocumentForm from "../modules/finance/SettlementDocumentForm.vue";
import type { SettlementCurrency, SettlementKind } from "../services/financeApi";
import MasterDataRecordPage from "../modules/master-data/MasterDataRecordPage.vue";
import { masterDataDefinitions } from "../modules/master-data/registry";
import type { MasterDataField } from "../modules/master-data/types";
import LoginPage from "../modules/system/auth/LoginPage.vue";
import PasswordChangeDialog from "../modules/system/auth/PasswordChangeDialog.vue";
import { backendStatusLabel, formatAmount, formatQty } from "../modules/shell/formatters";
import { useShellSession } from "../modules/shell/useShellSession";
import NotificationProviderSettingsPage from "../modules/system/notification/NotificationProviderSettingsPage.vue";
import AccountSetSettingsPage from "../modules/system/account-set/AccountSetSettingsPage.vue";
import NumberingRuleSettingsPage from "../modules/system/numbering/NumberingRuleSettingsPage.vue";
import OpeningStockPage from "../modules/inventory/opening-stock/OpeningStockPage.vue";
import PermissionMatrixPage from "../modules/system/permission/PermissionMatrixPage.vue";
import SecuritySettingsPage from "../modules/system/security/SecuritySettingsPage.vue";
import UserManagementPage from "../modules/system/user/UserManagementPage.vue";
import { acquireDocumentLock, fetchDocumentDetail, fetchPrintTemplates, overrideDocumentLock, releaseDocumentLock, savePrintTemplate, type DocumentDetail, type DocumentLockState, type DownstreamDocumentRef, type OpenableDocumentType, type PrintTemplateConfig } from "../services/documentApi";
import { auditMasterData, createMasterData, deleteMasterData, patchMasterData, reverseAuditMasterData, setMasterDataStatus, updateMasterData, type MasterDataPatchValue } from "../services/listApi";
import { fetchSalesOrderDetail } from "../services/salesOrderApi";
import { switchCurrentAccountSet, type SystemAccountSet } from "../services/systemApi";
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
  permission?: string;
  permissions?: string[];
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
interface MasterRecordState {
  id: string;
  listKey: string;
  type: string;
  title: string;
  editing: boolean;
  readOnly: boolean;
  originalCode: string;
  version: number | null;
  sparsePatch: boolean;
  maintainPermission: string;
  allowDelete: boolean;
  fields: MasterDataField[];
  form: Record<string, string>;
  originalForm: Record<string, string>;
  error: string;
}
const session = useSessionStore();
const tabs = useTabStore();
const preferences = usePreferenceStore();
const outboundTabId = "sales-out-form";
const outboundDocumentType = ("sales" + "Out") as OpenableDocumentType;
const salesQuoteTabId = "sales-quote-form";
const deliveryNoticeTabId = "delivery-notice-form";
const purchaseOrderTabId = "purchase-order-form";
const purchaseInTabId = "purchase-in-form";
const receiptTabId = "ar-receipt-form";
const paymentTabId = "ap-payment-form";
const purchaseReturnTabId = "purchase-return-form";
const materialIssueTabId = "material-issue-form";
const productInTabId = "product-in-form";
const bomFormTabId = "bom-form";
const productionPlanTabId = "production-plan-form";
const productionTaskTabId = "production-task-form";
const outsourcingWorkOrderTabId = "outsourcing-work-order-form";
const outsourcingIssueTabId = "outsourcing-issue-form";
const outsourcingReceiptTabId = "outsourcing-receipt-form";
const outsourcingReturnTabId = "outsourcing-return-form";
const outsourcingScrapTabId = "outsourcing-scrap-form";
const otherStockInTabId = "other-in-form";
const otherStockOutTabId = "other-out-form";
const stockTransferTabId = "stock-transfer-form";
const stockCountTabId = "stock-count-form";
const stockCountGainTabId = "stock-count-gain-form";
const stockCountLossTabId = "stock-count-loss-form";
const masterRecords = reactive<Record<string, MasterRecordState>>({});
const activeMasterRecord = computed(() => masterRecords[tabs.activeTabId.value] ?? null);
const activeMasterRecordDirty = computed(() => Boolean(tabs.activeTab.value?.dirty));
const canMaintainActiveMasterRecord = computed(() => {
  const record = activeMasterRecord.value;
  return Boolean(record && canMaintainMasterRecord(record));
});
tabs.onBeforeClose((tab) => {
  const type = documentTypeByFormTabId(tab.id);
  if (type && tab.lockedObjectId) {
    void releaseDocumentLock(type, tab.lockedObjectId);
  }
  if (masterRecords[tab.id]) {
    delete masterRecords[tab.id];
  }
});
const salesOrderFormRef = ref<InstanceType<typeof SalesOrderForm> | null>(null);
const salesQuoteFormRef = ref<InstanceType<typeof SalesQuoteForm> | null>(null);
const deliveryNoticeFormRef = ref<InstanceType<typeof DeliveryNoticeForm> | null>(null);
const outboundFormRef = ref<InstanceType<typeof SalesOutForm> | null>(null);
const purchaseOrderFormRef = ref<InstanceType<typeof PurchaseOrderForm> | null>(null);
const purchaseInFormRef = ref<InstanceType<typeof PurchaseInForm> | null>(null);
const receiptFormRef = ref<InstanceType<typeof SettlementDocumentForm> | null>(null);
const paymentFormRef = ref<InstanceType<typeof SettlementDocumentForm> | null>(null);
const purchaseReturnFormRef = ref<InstanceType<typeof PurchaseReturnForm> | null>(null);
const materialIssueFormRef = ref<InstanceType<typeof MaterialIssueForm> | null>(null);
const productInFormRef = ref<InstanceType<typeof ProductInForm> | null>(null);
const bomFormRef = ref<InstanceType<typeof BomForm> | null>(null);
const productionPlanFormRef = ref<InstanceType<typeof ProductionPlanForm> | null>(null);
const productionTaskFormRef = ref<InstanceType<typeof ProductionTaskForm> | null>(null);
const outsourcingWorkOrderFormRef = ref<InstanceType<typeof OutsourcingDocumentForm> | null>(null);
const outsourcingIssueFormRef = ref<InstanceType<typeof OutsourcingDocumentForm> | null>(null);
const outsourcingReceiptFormRef = ref<InstanceType<typeof OutsourcingDocumentForm> | null>(null);
const outsourcingReturnFormRef = ref<InstanceType<typeof OutsourcingDocumentForm> | null>(null);
const outsourcingScrapFormRef = ref<InstanceType<typeof OutsourcingDocumentForm> | null>(null);
const otherStockInFormRef = ref<InstanceType<typeof OtherStockInForm> | null>(null);
const otherStockOutFormRef = ref<InstanceType<typeof OtherStockOutForm> | null>(null);
const stockTransferFormRef = ref<InstanceType<typeof StockTransferForm> | null>(null);
const stockCountFormRef = ref<InstanceType<typeof StockCountForm> | null>(null);
const stockCountGainFormRef = ref<InstanceType<typeof StockCountForm> | null>(null);
const stockCountLossFormRef = ref<InstanceType<typeof StockCountForm> | null>(null);
const loginPageRef = ref<InstanceType<typeof LoginPage> | null>(null);
const passwordChangeDialogRef = ref<InstanceType<typeof PasswordChangeDialog> | null>(null);
const shellSession = useShellSession({ loginPageRef, passwordChangeDialogRef });
const activePasswordPolicy = shellSession.activePasswordPolicy;
const loginAccountSets = shellSession.loginAccountSets;
const accountSets = shellSession.accountSets;
const isAuthenticated = shellSession.isAuthenticated;
const loginPageMessage = shellSession.loginPageMessage;
const handleLoginSuccess = shellSession.handleLoginSuccess;
const logoutCurrentUser = shellSession.logoutCurrentUser;
const handlePasswordChanged = shellSession.handlePasswordChanged;
const keyword = ref("");
const selectedAccountSetCode = ref(session.accountSetCode.value);
const accountSetSwitching = ref(false);
const accountSetSwitchMessage = ref("");
const activeModuleName = ref("销售管理");
const modulePanelOpen = ref(false);
const suppressNavigationUntil = ref(0);
const formMessage = ref("");
const highlightedSourceBillNo = ref("");
const highlightedSourceLineNo = ref<number | null>(null);
const printTemplates = ref<PrintTemplateConfig[]>([]);
const printTemplateEdited = ref(false);
const printTemplateMessage = ref("");
const printTemplateForm = reactive<PrintTemplateConfig>({ ...defaultPrintTemplateForm });
const typedModuleCatalog = moduleCatalog as unknown as ShellModule[];
const typedExcludedModules = excludedModules as unknown as ShellModule[];
const visibleModules = [...typedModuleCatalog, ...typedExcludedModules];
const activeModule = computed(() => visibleModules.find((module) => module.name === activeModuleName.value) ?? typedModuleCatalog[0]);
const activeEntryGroups = computed(() => activeModule.value.groups
  .map((group) => ({ ...group, entries: group.entries.filter((entry) => canOpenEntry(entry)) }))
  .filter((group) => group.entries.length > 0));
const approvedCount = computed(() => featureScope.filter((feature) => feature.decision === "build" || feature.decision === "simple").length);
const homeQuickGroups = computed(() => typedModuleCatalog
  .map((module) => ({
    module: module.name,
    entries: module.groups
      .flatMap((group) => group.entries)
      .filter((entry) => canOpenEntry(entry))
      .slice(0, 6)
  }))
  .filter((group) => group.entries.length > 0)
  .slice(0, 8));
const pageSubtitle = computed(() => {
  if (tabs.activeTab.value.kind === "report") {
    return "查询条件、结果表、列设置和打印/引出入口在统一工作区内承载。";
  }
  if (tabs.activeTab.value.kind === "form") {
    return "单头字段、分录表格、保存/审核动作和未保存状态使用同一外壳。";
  }
  return "列表工具栏、批量动作、选中态、锁定态和分页预留在同一范式内。";
});
const printDocumentOptions = computed(() => printTemplateDocumentTypes.map((document) => {
  const templates = printTemplates.value.filter((template) => template.documentType === document.documentType);
  const defaultTemplate = preferredPrintTemplate(templates);
  return defaultTemplate ?? {
    ...document,
    templateCode: "STANDARD",
    templateName: "标准套打模板",
    roleCode: "",
    companyName: "博莱德机械测试账套",
    headerNote: "会计期间 2026-06 / 业务期间 2026-06",
    footerNote: "本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。",
    showSignature: true,
    showSeal: true,
    isDefault: true,
    enabled: true
  };
}));
const currentDocumentTemplates = computed(() => printTemplates.value.filter((template) => template.documentType === printTemplateForm.documentType));
const activePrintTemplateTitle = computed(() => printTemplateDocumentTypes.find((template) => template.documentType === printTemplateForm.documentType)?.documentTitle ?? printTemplateForm.documentTitle);
const canManagePrintTemplates = computed(() => session.hasPermission("system.print_template.manage"));
const canManageRolePermissions = computed(() => session.hasPermission("system.role_permission.manage"));
const canManageSecuritySettings = computed(() => session.hasPermission("system.security.manage"));
const canManageNotificationProviderSettings = computed(() => session.hasPermission("system.notification_provider.manage"));
const canManageNumberingRules = computed(() => session.hasPermission("system.numbering_rule.manage"));
const isAdminUser = computed(() => session.userRoleCode.value === "ADMIN" || session.hasPermission("system.account_set.manage"));
const currentAccountSet = computed(() => accountSets.value.find((accountSet) => accountSet.code === session.accountSetCode.value) ?? null);
const currentAccountSetStatus = computed(() => {
  const accountSet = currentAccountSet.value;
  const environment = accountSet?.environment || session.accountSetEnvironment.value || "未标记环境";
  const initialized = accountSet?.initialized ?? session.accountSetInitialized.value;
  return `${environment} / ${initialized ? "已初始化" : "未初始化"}`;
});
const activeLockReadOnly = computed(() => Boolean(tabs.activeTab.value.lockReadOnly));
const activeLockMessage = computed(() => tabs.activeTab.value.lockMessage ?? "");
const activeLockCanOverride = computed(() => Boolean(tabs.activeTab.value.lockCanOverride));
const isSalesOrderForm = computed(() => tabs.activeTab.value.id === "sales-order-form");
const isSalesQuoteForm = computed(() => tabs.activeTab.value.id === salesQuoteTabId);
watch(() => session.accountSetCode.value, (code) => {
  selectedAccountSetCode.value = code;
});
function downstreamReverseImpact(doc: DownstreamDocumentRef) {
  const qty = formatQty(doc.qty);
  if (doc.type === "purchaseIn") {
    return `反审核将冲销${"采购"}${"入库"}库存流水，并回退源${"采购"}${"订单"}已入库数量 ${qty}。`;
  }
  return `反审核将冲销销售${"出库"}库存流水，并回退源销售订单已${"出库"}数量 ${qty}。`;
}
function downstreamRedReverseImpact(doc: DownstreamDocumentRef) {
  const qty = formatQty(doc.qty);
  if (doc.type === "purchaseIn") {
    return `红冲将生成负数${"采购"}${"入库"}草稿；审核红字单后回退源${"采购"}${"订单"}已入库数量 ${qty}。`;
  }
  return `红冲将生成负数销售${"出库"}草稿；审核红字单后回退源销售订单已${"出库"}数量 ${qty}。`;
}
function scrollHighlightedSourceLineIntoView() {
  if (!highlightedSourceLineNo.value) {
    return;
  }
  const target = document.querySelector<HTMLElement>(`.entry-table tr[data-line-no="${highlightedSourceLineNo.value}"]`);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}
function downstreamTypeLabel(type: OpenableDocumentType) {
  return openableDocumentTarget(type).title;
}
function downstreamDocTestId(index: number) {
  return index === 0 ? "downstream-doc-open" : `downstream-doc-open-${index + 1}`;
}
function entryPasteCandidateTestId(lineIndex: number, code: string) {
  return `entry-paste-candidate-${lineIndex + 1}-${code}`;
}
function selectModule(name: string) {
  if (Date.now() < suppressNavigationUntil.value) {
    return;
  }
  activeModuleName.value = name;
  modulePanelOpen.value = true;
}
function openEntry(entry: ShellEntry) {
  if (!canOpenEntry(entry)) {
    return;
  }
  const settlementReadOnlyEntry = [receiptTabId, paymentTabId].includes(entry.id) && !session.hasPermission("finance.settle");
  const effectiveEntry = settlementReadOnlyEntry ? { ...entry, mode: "list" as WorkTabKind, dirty: false } : entry;
  activeModuleName.value = effectiveEntry.module;
  const isQuery = effectiveEntry.mode === "list" || effectiveEntry.mode === "report";
  const id = effectiveEntry.mode === "list" && !effectiveEntry.id.endsWith("-list") && !effectiveEntry.id.endsWith("-report") ? `${effectiveEntry.id}-list` : effectiveEntry.id;
  if (
    effectiveEntry.mode === "form"
    && isSettlementFormTabId(id)
    && !confirmDirtyTabReplacement(id, "继续会新建空白收付款单")
  ) {
    return;
  }
  const opened = tabs.openTab({
    id,
    title: isQuery && !effectiveEntry.label.includes("表") && !effectiveEntry.label.includes("查询") ? `${effectiveEntry.label}列表` : effectiveEntry.label,
    module: effectiveEntry.module,
    kind: effectiveEntry.mode,
    dirty: effectiveEntry.mode === "form" ? effectiveEntry.dirty : false
  });
  if (opened && effectiveEntry.mode === "form") {
    void nextTick().then(() => startNewModuleDocument(effectiveEntry.id));
  }
  if (opened && effectiveEntry.id === "print-template-settings") {
    void loadPrintTemplates();
  }
  modulePanelOpen.value = false;
  suppressNavigationUntil.value = Date.now() + 250;
}

function openQueryEntry(entry: ShellEntry) {
  openEntry(entry.mode === "report" ? entry : { ...entry, mode: "list" });
}

function openAccountSetSettings() {
  openEntry({
    id: "account-set-settings",
    label: "账套管理",
    module: "系统设置",
    mode: "shell",
    permission: "system.account_set.manage"
  });
}

function switchAccountSetFromMenu() {
  void requestAccountSetSwitch(selectedAccountSetCode.value);
}

function replaceAccountSets(nextAccountSets: SystemAccountSet[]) {
  accountSets.value = nextAccountSets;
  const current = nextAccountSets.find((accountSet) => accountSet.code === session.accountSetCode.value);
  if (current) {
    applyAccountSetSummary(current);
  }
}

async function requestAccountSetSwitch(accountSetCode: string) {
  if (!accountSetCode || accountSetCode === session.accountSetCode.value || accountSetSwitching.value) {
    return;
  }
  const target = accountSets.value.find((accountSet) => accountSet.code === accountSetCode);
  const targetName = target?.name || accountSetCode;
  const dirtyTabs = tabs.tabs.value.filter((tab) => tab.id !== "home" && tab.dirty);
  const dirtySummary = dirtyTabs.slice(0, 5).map((tab) => tab.title).join("、");
  const dirtySuffix = dirtyTabs.length > 5 ? `等 ${dirtyTabs.length} 个页签` : dirtySummary;
  const confirmMessage = dirtyTabs.length > 0
    ? `当前有未保存页签：${dirtySuffix}。切换账套会关闭并刷新业务页签，未保存内容不会保留。确定切换到「${targetName}」吗？`
    : `确定切换到「${targetName}」吗？切换后当前业务页签会刷新。`;
  if (!window.confirm(confirmMessage)) {
    selectedAccountSetCode.value = session.accountSetCode.value;
    accountSetSwitchMessage.value = "已取消账套切换。";
    return;
  }
  accountSetSwitching.value = true;
  accountSetSwitchMessage.value = "";
  const result = await switchCurrentAccountSet(accountSetCode);
  if (result.ok) {
    if (result.current) {
      applyAccountSetSummary(result.current);
    }
    reloadAfterAccountSetSwitch();
    return;
  }
  selectedAccountSetCode.value = session.accountSetCode.value;
  accountSetSwitching.value = false;
  accountSetSwitchMessage.value = result.message || "账套切换失败。";
  formMessage.value = accountSetSwitchMessage.value;
}

function applyAccountSetSummary(accountSet: SystemAccountSet) {
  session.tenantName.value = accountSet.name;
  session.accountSetCode.value = accountSet.code;
  session.accountSetId.value = accountSet.id || "";
  session.accountSetEnvironment.value = accountSet.environment || "";
  session.accountSetInitialized.value = Boolean(accountSet.initialized);
  session.accountingPeriod.value = accountSet.accountingPeriod || session.accountingPeriod.value;
  session.businessPeriod.value = accountSet.businessPeriod || session.businessPeriod.value;
}

function reloadAfterAccountSetSwitch() {
  tabs.closeBusinessTabsForAccountSwitch();
  tabs.activeTabId.value = "home";
  window.location.reload();
}

function startNewModuleDocument(entryId: string) {
  if (entryId === "sales-order-form") {
    salesOrderFormRef.value?.startNew();
  } else if (entryId === salesQuoteTabId) {
    salesQuoteFormRef.value?.startNew();
  } else if (entryId === deliveryNoticeTabId) {
    deliveryNoticeFormRef.value?.startNew();
  } else if (entryId === outboundTabId) {
    outboundFormRef.value?.startNew();
  } else if (entryId === purchaseOrderTabId) {
    purchaseOrderFormRef.value?.startNew();
  } else if (entryId === purchaseInTabId) {
    purchaseInFormRef.value?.startNew();
  } else if (entryId === receiptTabId) {
    void receiptFormRef.value?.startNew();
  } else if (entryId === paymentTabId) {
    void paymentFormRef.value?.startNew();
  } else if (entryId === purchaseReturnTabId) {
    purchaseReturnFormRef.value?.startNew();
  } else if (entryId === materialIssueTabId) {
    materialIssueFormRef.value?.startNew();
  } else if (entryId === productInTabId) {
    productInFormRef.value?.startNew();
  } else if (entryId === productionTaskTabId) {
    productionTaskFormRef.value?.startNew();
  } else if (entryId === outsourcingWorkOrderTabId) {
    outsourcingWorkOrderFormRef.value?.startNew();
  } else if (entryId === outsourcingIssueTabId) {
    outsourcingIssueFormRef.value?.startNew();
  } else if (entryId === outsourcingReceiptTabId) {
    outsourcingReceiptFormRef.value?.startNew();
  } else if (entryId === outsourcingReturnTabId) {
    outsourcingReturnFormRef.value?.startNew();
  } else if (entryId === outsourcingScrapTabId) {
    outsourcingScrapFormRef.value?.startNew();
  } else if (entryId === otherStockInTabId) {
    otherStockInFormRef.value?.startNew();
  } else if (entryId === otherStockOutTabId) {
    otherStockOutFormRef.value?.startNew();
  } else if (entryId === stockTransferTabId) {
    stockTransferFormRef.value?.startNew();
  } else if (entryId === stockCountTabId) {
    stockCountFormRef.value?.startNew();
  } else if (entryId === stockCountGainTabId) {
    stockCountGainFormRef.value?.startNew();
  } else if (entryId === stockCountLossTabId) {
    stockCountLossFormRef.value?.startNew();
  }
}

async function openCreateDocumentFromList(payload: { type: OpenableDocumentType }) {
  const target = openableDocumentTarget(payload.type);
  const opened = tabs.openTab({
    id: target.tabId,
    title: target.title,
    module: target.module,
    kind: "form",
    dirty: true
  });
  activeModuleName.value = target.module;
  if (opened) {
    const tab = tabs.tabs.value.find((item) => item.id === target.tabId);
    if (tab) {
      tab.dirty = true;
      tab.lockedObjectId = undefined;
      tab.lockReadOnly = false;
      tab.lockMessage = "";
      tab.lockCanOverride = false;
    }
    await nextTick();
    target.ref.value?.startNew();
    markActiveDirty();
  }
}

async function openCreateListRecord(payload: { listKey: string; row?: Record<string, unknown>; mode?: "copy" }) {
  const target = createListRecordTarget(payload.listKey);
  if (!target) {
    return;
  }
  if (
    isSettlementFormTabId(target.tabId)
    && !confirmDirtyTabReplacement(
      target.tabId,
      payload.row ? "继续会打开列表中的收付款单" : "继续会新建空白收付款单"
    )
  ) {
    return;
  }
  const opened = tabs.openTab({
    id: target.tabId,
    title: target.title,
    module: target.module,
    kind: "form",
    dirty: !payload.row
  });
  activeModuleName.value = target.module;
  if (opened) {
    await nextTick();
    target.open(payload.row, payload.mode);
    if (!payload.row) {
      markActiveDirty();
    }
  }
}

function createListRecordTarget(listKey: string) {
  if (listKey === "ar-receipt-form-list") {
    return settlementListRecordTarget("receipt");
  }
  if (listKey === "ap-payment-form-list") {
    return settlementListRecordTarget("payment");
  }
  if (listKey === "bom-list") {
    return {
      tabId: bomFormTabId,
      title: "BOM维护",
      module: "生产管理",
      open: (row?: Record<string, unknown>, mode?: "copy") => {
        const code = row?.code == null ? "" : String(row.code);
        if (mode === "copy" && code) {
          void bomFormRef.value?.copyFromBom(code);
          return;
        }
        if (code) {
          void bomFormRef.value?.loadBom(code);
          return;
        }
        bomFormRef.value?.startNew();
      }
    };
  }
  if (listKey === "production-plan-list") {
    return {
      tabId: productionPlanTabId,
      title: "生产计划",
      module: "生产管理",
      open: () => productionPlanFormRef.value?.startNew()
    };
  }
  if (listKey === "production-task-form-list") {
    return {
      tabId: productionTaskTabId,
      title: "生产任务单",
      module: "生产管理",
      open: (row?: Record<string, unknown>) => {
        const billNo = row?.billNo == null ? "" : String(row.billNo);
        if (billNo) {
          void productionTaskFormRef.value?.loadByBillNo(billNo);
          return;
        }
        productionTaskFormRef.value?.startNew();
      }
    };
  }
  if (listKey === "outsourcing-work-order-list") {
    return {
      tabId: outsourcingWorkOrderTabId,
      title: "委外加工单",
      module: "委外管理",
      open: (row?: Record<string, unknown>) => openOutsourcingForm(row, outsourcingWorkOrderFormRef.value)
    };
  }
  if (listKey === "outsourcing-issue-list") {
    return {
      tabId: outsourcingIssueTabId,
      title: "委外发料单",
      module: "委外管理",
      open: (row?: Record<string, unknown>) => openOutsourcingForm(row, outsourcingIssueFormRef.value)
    };
  }
  if (listKey === "outsourcing-receipt-list") {
    return {
      tabId: outsourcingReceiptTabId,
      title: "委外产品入库单",
      module: "委外管理",
      open: (row?: Record<string, unknown>) => openOutsourcingForm(row, outsourcingReceiptFormRef.value)
    };
  }
  if (listKey === "outsourcing-return-list") {
    return {
      tabId: outsourcingReturnTabId,
      title: "委外产品退货单",
      module: "委外管理",
      open: (row?: Record<string, unknown>) => openOutsourcingForm(row, outsourcingReturnFormRef.value)
    };
  }
  if (listKey === "outsourcing-scrap-list") {
    return {
      tabId: outsourcingScrapTabId,
      title: "委外产品报废单",
      module: "委外管理",
      open: (row?: Record<string, unknown>) => openOutsourcingForm(row, outsourcingScrapFormRef.value)
    };
  }
  return null;
}

function settlementListRecordTarget(kind: SettlementKind) {
  const receipt = kind === "receipt";
  const targetRef = receipt ? receiptFormRef : paymentFormRef;
  return {
    tabId: receipt ? receiptTabId : paymentTabId,
    title: receipt ? "收款单" : "付款单",
    module: "应收应付",
    open: (row?: Record<string, unknown>) => {
      const billNo = String(row?.billNo ?? "").trim();
      if (billNo) {
        void targetRef.value?.loadByBillNo(billNo);
        return;
      }
      void targetRef.value?.startNew();
    }
  };
}

async function openSettlementFromSource(
  kind: SettlementKind,
  payload: { sourceBillNo: string; currency: SettlementCurrency }
) {
  const receipt = kind === "receipt";
  const tabId = receipt ? receiptTabId : paymentTabId;
  if (!confirmDirtyTabReplacement(tabId, `继续会以 ${payload.sourceBillNo} 重新预填`)) {
    return;
  }
  const opened = tabs.openTab({
    id: tabId,
    title: receipt ? "收款单" : "付款单",
    module: "应收应付",
    kind: "form",
    dirty: true
  });
  if (!opened) {
    return;
  }
  activeModuleName.value = "应收应付";
  const tab = tabs.tabs.value.find((item) => item.id === tabId);
  if (tab) {
    tab.dirty = true;
  }
  await nextTick();
  const targetRef = receipt ? receiptFormRef : paymentFormRef;
  await targetRef.value?.startNew({ sourceBillNo: payload.sourceBillNo, currency: payload.currency });
}

function isSettlementFormTabId(tabId: string) {
  return tabId === receiptTabId || tabId === paymentTabId;
}

function confirmDirtyTabReplacement(tabId: string, nextAction: string) {
  const existing = tabs.tabs.value.find((tab) => tab.id === tabId);
  return !existing?.dirty || window.confirm(`${existing.title}有未保存内容，${nextAction}。确定继续吗？`);
}

function openOutsourcingForm(row: Record<string, unknown> | undefined, refValue: InstanceType<typeof OutsourcingDocumentForm> | null) {
  const billNo = row?.billNo == null ? "" : String(row.billNo);
  if (billNo) {
    void refValue?.loadDocument(billNo);
    return;
  }
  refValue?.startNew();
}

function documentTypeByListTabId(tabId: string): OpenableDocumentType | "" {
  const listMap: Record<string, OpenableDocumentType> = {
    "sales-quote-form-list": "salesQuote",
    "sales-order-form-list": "salesOrder",
    "delivery-notice-form-list": "deliveryNotice",
    "sales-out-list": "salesOut",
    "sales-out-form-list": "salesOut",
    "purchase-order-form-list": "purchaseOrder",
    "purchase-in-list": "purchaseIn",
    "purchase-in-form-list": "purchaseIn",
    "purchase-return-list": "purchaseReturn",
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
  return listMap[tabId] ?? "";
}

function documentTypeByFormTabId(tabId: string): OpenableDocumentType | "" {
  const formMap: Record<string, OpenableDocumentType> = {
    [salesQuoteTabId]: "salesQuote",
    "sales-order-form": "salesOrder",
    [deliveryNoticeTabId]: "deliveryNotice",
    [outboundTabId]: "salesOut",
    [purchaseOrderTabId]: "purchaseOrder",
    [purchaseInTabId]: "purchaseIn",
    [purchaseReturnTabId]: "purchaseReturn",
    [materialIssueTabId]: "materialIssue",
    [productInTabId]: "productIn",
    [otherStockInTabId]: "otherStockIn",
    [otherStockOutTabId]: "otherStockOut",
    [stockTransferTabId]: "stockTransfer",
    [stockCountTabId]: "stockCount",
    [stockCountGainTabId]: "stockCountGain",
    [stockCountLossTabId]: "stockCountLoss"
  };
  return formMap[tabId] ?? "";
}
function canOpenEntry(entry: ShellEntry) {
  if (entry.permissions?.length) {
    return entry.permissions.some((permission) => session.hasPermission(permission));
  }
  return session.hasPermission(entry.permission);
}
async function loadPrintTemplates() {
  const result = await fetchPrintTemplates();
  if (!result.ok) {
    printTemplateMessage.value = result.message;
    return;
  }
  printTemplates.value = result.data;
  const current = preferredPrintTemplate(result.data.filter((template) => template.documentType === printTemplateForm.documentType)) ?? result.data[0];
  if (current && !printTemplateEdited.value) {
    applyPrintTemplateToForm(current);
  }
  printTemplateMessage.value = "";
}
function selectPrintTemplate(documentType: string, templateCode?: string) {
  const template = printTemplates.value.find((item) => item.documentType === documentType && item.templateCode === templateCode)
    ?? preferredPrintTemplate(printTemplates.value.filter((item) => item.documentType === documentType))
    ?? printTemplates.value.find((item) => item.documentType === documentType);
  if (template) {
    printTemplateEdited.value = false;
    applyPrintTemplateToForm(template);
    printTemplateMessage.value = "";
  }
}
function applyPrintTemplateToForm(template: PrintTemplateConfig) {
  printTemplateForm.documentType = template.documentType;
  printTemplateForm.documentTitle = template.documentTitle;
  printTemplateForm.templateCode = template.templateCode;
  printTemplateForm.templateName = template.templateName;
  printTemplateForm.roleCode = template.roleCode || "";
  printTemplateForm.companyName = template.companyName;
  printTemplateForm.headerNote = template.headerNote;
  printTemplateForm.footerNote = template.footerNote;
  printTemplateForm.showSignature = template.showSignature;
  printTemplateForm.showSeal = template.showSeal;
  printTemplateForm.isDefault = template.isDefault;
  printTemplateForm.paperSize = template.paperSize || "A4";
  printTemplateForm.pageOrientation = template.pageOrientation || "PORTRAIT";
  printTemplateForm.marginTopMm = template.marginTopMm || "12";
  printTemplateForm.marginRightMm = template.marginRightMm || "12";
  printTemplateForm.marginBottomMm = template.marginBottomMm || "12";
  printTemplateForm.marginLeftMm = template.marginLeftMm || "12";
  printTemplateForm.copyCount = template.copyCount || 1;
  printTemplateForm.enabled = template.enabled;
}
async function saveActivePrintTemplate() {
  if (!canManagePrintTemplates.value) {
    printTemplateMessage.value = "当前角色无权维护打印模板。";
    return;
  }
  syncPrintTemplateTextInputs();
  const result = await savePrintTemplate(printTemplateForm.documentType, {
    templateCode: printTemplateForm.templateCode,
    templateName: printTemplateForm.templateName,
    roleCode: printTemplateForm.roleCode,
    companyName: printTemplateForm.companyName,
    headerNote: printTemplateForm.headerNote,
    footerNote: printTemplateForm.footerNote,
    showSignature: printTemplateForm.showSignature,
    showSeal: printTemplateForm.showSeal,
    isDefault: printTemplateForm.isDefault,
    paperSize: printTemplateForm.paperSize,
    pageOrientation: printTemplateForm.pageOrientation,
    marginTopMm: printTemplateForm.marginTopMm,
    marginRightMm: printTemplateForm.marginRightMm,
    marginBottomMm: printTemplateForm.marginBottomMm,
    marginLeftMm: printTemplateForm.marginLeftMm,
    copyCount: Number(printTemplateForm.copyCount) || 1
  });
  if (!result.ok || !result.data) {
    printTemplateMessage.value = result.message || "打印模板保存失败。";
    return;
  }
  applyPrintTemplateToForm(result.data);
  upsertPrintTemplate(result.data);
  printTemplateEdited.value = false;
  printTemplateMessage.value = "打印模板已保存";
}

function syncPrintTemplateTextInputs() {
  printTemplateForm.templateName = document.querySelector<HTMLInputElement>("[data-testid='print-template-name']")?.value ?? printTemplateForm.templateName;
  printTemplateForm.companyName = document.querySelector<HTMLInputElement>("[data-testid='print-template-company']")?.value ?? printTemplateForm.companyName;
  printTemplateForm.headerNote = document.querySelector<HTMLTextAreaElement>("[data-testid='print-template-header-note']")?.value ?? printTemplateForm.headerNote;
  printTemplateForm.footerNote = document.querySelector<HTMLTextAreaElement>("[data-testid='print-template-footer-note']")?.value ?? printTemplateForm.footerNote;
}
async function copyActivePrintTemplate() {
  if (!canManagePrintTemplates.value) {
    printTemplateMessage.value = "当前角色无权维护打印模板。";
    return;
  }
  const suffix = Date.now().toString().slice(-8);
  const result = await savePrintTemplate(printTemplateForm.documentType, {
    templateCode: `COPY-${suffix}`,
    templateName: `${printTemplateForm.templateName} 副本`,
    roleCode: printTemplateForm.roleCode,
    companyName: printTemplateForm.companyName,
    headerNote: printTemplateForm.headerNote,
    footerNote: printTemplateForm.footerNote,
    showSignature: printTemplateForm.showSignature,
    showSeal: printTemplateForm.showSeal,
    isDefault: false,
    paperSize: printTemplateForm.paperSize,
    pageOrientation: printTemplateForm.pageOrientation,
    marginTopMm: printTemplateForm.marginTopMm,
    marginRightMm: printTemplateForm.marginRightMm,
    marginBottomMm: printTemplateForm.marginBottomMm,
    marginLeftMm: printTemplateForm.marginLeftMm,
    copyCount: Number(printTemplateForm.copyCount) || 1
  });
  if (!result.ok || !result.data) {
    printTemplateMessage.value = result.message || "模板副本保存失败。";
    return;
  }
  applyPrintTemplateToForm(result.data);
  upsertPrintTemplate(result.data);
  printTemplateMessage.value = "模板副本已保存";
}
function upsertPrintTemplate(saved: PrintTemplateConfig) {
  const others = printTemplates.value
    .filter((template) => !(template.documentType === saved.documentType && template.templateCode === saved.templateCode))
    .map((template) => saved.isDefault && template.documentType === saved.documentType && (template.roleCode || "") === (saved.roleCode || "") ? { ...template, isDefault: false } : template);
  printTemplates.value = [...others, saved];
}
function preferredPrintTemplate(templates: PrintTemplateConfig[]) {
  return templates.find((template) => template.isDefault && template.roleCode === "ADMIN")
    ?? templates.find((template) => template.isDefault && !template.roleCode)
    ?? templates.find((template) => template.roleCode === "ADMIN")
    ?? templates[0];
}
function closeNavigation() {
  modulePanelOpen.value = false;
  suppressNavigationUntil.value = 0;
}
function noop() {}
async function openDocumentFromList(payload: { type: OpenableDocumentType; row: Record<string, unknown> }) {
  const billNo = String(payload.row.billNo ?? "");
  if (!billNo) {
    return;
  }
  if (payload.type === outboundDocumentType) {
    const result = await fetchDocumentDetail(payload.type, billNo);
    if (!result.ok || !result.data) {
      formMessage.value = result.message || "单据详情加载失败。";
      return;
    }
    tabs.openTab({
      id: outboundTabId,
      title: "销售" + "出库单",
      module: "销售管理",
      kind: "form",
      dirty: false,
      lockedObjectId: billNo
    });
    await applyDocumentLock(outboundTabId, payload.type, billNo);
    activeModuleName.value = "销售管理";
    await nextTick();
    outboundFormRef.value?.applyDetail(result.data, `已打开${"销售"}${"出库单"} ${billNo}`);
    clearActiveDirty();
    return;
  }
  const result = await fetchDocumentDetail(payload.type, billNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "单据详情加载失败。";
    return;
  }
  const target = openableDocumentTarget(payload.type);
  tabs.openTab({
    id: target.tabId,
    title: target.title,
    module: target.module,
    kind: "form",
    dirty: false,
    lockedObjectId: billNo
  });
  await applyDocumentLock(target.tabId, payload.type, billNo);
  activeModuleName.value = target.module;
  await nextTick();
  target.ref.value?.applyDetail(result.data, `已打开${target.title} ${billNo}`);
  formMessage.value = `已打开${target.title} ${billNo}`;
  clearActiveDirty();
}
async function openDocumentFromModule(payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }) {
  if (
    ((tabs.activeTab.value.id === outboundTabId || tabs.activeTab.value.id === deliveryNoticeTabId) && (payload.type === "salesOrder" || payload.type === "deliveryNotice"))
    || (tabs.activeTab.value.id === purchaseInTabId && payload.type === "purchaseOrder")
    || (tabs.activeTab.value.id === purchaseReturnTabId && payload.type === "purchaseIn")
  ) {
    const result = await fetchDocumentDetail(payload.type, payload.billNo);
    if (!result.ok || !result.data) {
      formMessage.value = result.message || "源单详情加载失败。";
      return;
    }
    openSourceTraceWindow(payload.type, result.data, payload.sourceLineNo ?? null);
    formMessage.value = payload.sourceLineNo ? `已在新页签打开源单 ${payload.billNo}，定位到第 ${payload.sourceLineNo} 行` : `已在新页签打开源单 ${payload.billNo}`;
    return;
  }
  if (payload.type === outboundDocumentType) {
    const result = await fetchDocumentDetail(payload.type, payload.billNo);
    if (!result.ok || !result.data) {
      formMessage.value = result.message || "单据详情加载失败。";
      return;
    }
    tabs.openTab({
      id: outboundTabId,
      title: "销售" + "出库单",
      module: "销售管理",
      kind: "form",
      dirty: false,
      lockedObjectId: payload.billNo
    });
    await applyDocumentLock(outboundTabId, payload.type, payload.billNo);
    activeModuleName.value = "销售管理";
    await nextTick();
    outboundFormRef.value?.applyDetail(result.data, payload.sourceLineNo ? `已追踪打开${"销售"}${"出库单"} ${payload.billNo}，定位到第 ${payload.sourceLineNo} 行` : `已打开${"销售"}${"出库单"} ${payload.billNo}`, payload.sourceLineNo ?? null);
    clearActiveDirty();
    return;
  }
  const result = await fetchDocumentDetail(payload.type, payload.billNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "单据详情加载失败。";
    return;
  }
  const target = openableDocumentTarget(payload.type);
  tabs.openTab({
    id: target.tabId,
    title: target.title,
    module: target.module,
    kind: "form",
    dirty: false,
    lockedObjectId: payload.billNo
  });
  await applyDocumentLock(target.tabId, payload.type, payload.billNo);
  activeModuleName.value = target.module;
  await nextTick();
  target.ref.value?.applyDetail(result.data, payload.sourceLineNo ? `已追踪打开${target.title} ${payload.billNo}，定位到第 ${payload.sourceLineNo} 行` : `已打开${target.title} ${payload.billNo}`, payload.sourceLineNo ?? null);
  highlightedSourceBillNo.value = payload.billNo;
  highlightedSourceLineNo.value = payload.sourceLineNo ?? null;
  scrollHighlightedSourceLineIntoView();
  formMessage.value = payload.sourceLineNo ? `已追踪打开${target.title} ${payload.billNo}，定位到第 ${payload.sourceLineNo} 行` : `已打开${target.title} ${payload.billNo}`;
  clearActiveDirty();
}

function openSourceTraceWindow(type: OpenableDocumentType, detail: DocumentDetail, sourceLineNo: number | null) {
  const title = sourceTraceTitle(type);
  const document = detail.document;
  const source = detail.lines.map((line) => {
    const lineNo = Number(line.lineNo ?? 0);
    const active = sourceLineNo && lineNo === sourceLineNo;
    return `<tr${active ? " class=\"active\"" : ""}><td>${escapeTraceHtml(String(line.lineNo ?? ""))}</td><td>${escapeTraceHtml(String(line.productCode ?? ""))}</td><td>${escapeTraceHtml(String(line.productName ?? ""))}</td><td>${escapeTraceHtml(String(line.qty ?? ""))}</td><td>${escapeTraceHtml(String(line.remainingQty ?? ""))}</td><td>${escapeTraceHtml(String(line.lineRemark ?? ""))}</td></tr>`;
  }).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeTraceHtml(title)} ${escapeTraceHtml(document.billNo)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#1f2937}h1{font-size:20px;margin:0 0 12px}.meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 16px;margin-bottom:16px;color:#475569;font-size:13px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #d8e0eb;padding:8px;text-align:left}th{background:#f3f7fb}.active{background:#fff7ed;outline:2px solid #f97316}</style></head><body><h1>${escapeTraceHtml(title)} ${escapeTraceHtml(document.billNo)}</h1><section class="meta"><div>日期：${escapeTraceHtml(document.billDate)}</div><div>状态：${escapeTraceHtml(document.status)}</div><div>部门：${escapeTraceHtml(document.department ?? "")}</div><div>往来：${escapeTraceHtml(document.customer ?? document.supplier ?? "")}</div></section><table><thead><tr><th>行号</th><th>物料编码</th><th>物料名称</th><th>数量</th><th>剩余</th><th>备注</th></tr></thead><tbody>${source}</tbody></table></body></html>`;
  const opened = window.open("", "_blank");
  if (opened) {
    opened.document.open();
    opened.document.write(html);
    opened.document.close();
  }
}

function sourceTraceTitle(type: OpenableDocumentType) {
  if (type === "salesQuote") {
    return "销售报价单";
  }
  if (type === "purchaseOrder") {
    return "采购订单";
  }
  if (type === "deliveryNotice") {
    return "发货通知单";
  }
  return "销售订单";
}

function escapeTraceHtml(value: string | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function openableDocumentTarget(type: OpenableDocumentType): { tabId: string; title: string; module: string; ref: { value: { applyDetail: (detail: DocumentDetail, message?: string, sourceLineNo?: number | null) => void; startNew: () => void } | null } } {
  switch (type) {
    case "salesQuote":
      return { tabId: salesQuoteTabId, title: "销售报价单", module: "销售管理", ref: salesQuoteFormRef };
    case "deliveryNotice":
      return { tabId: deliveryNoticeTabId, title: "发货通知单", module: "销售管理", ref: deliveryNoticeFormRef };
    case "purchaseOrder":
      return { tabId: purchaseOrderTabId, title: "采购订单", module: "采购管理", ref: purchaseOrderFormRef };
    case "purchaseIn":
      return { tabId: purchaseInTabId, title: "采购入库单", module: "采购管理", ref: purchaseInFormRef };
    case "purchaseReturn":
      return { tabId: purchaseReturnTabId, title: "采购退货单", module: "采购管理", ref: purchaseReturnFormRef };
    case "materialIssue":
      return { tabId: materialIssueTabId, title: "生产领料单", module: "生产管理", ref: materialIssueFormRef };
    case "productIn":
      return { tabId: productInTabId, title: "产品入库单", module: "生产管理", ref: productInFormRef };
    case "otherStockIn":
      return { tabId: otherStockInTabId, title: "其他入库单", module: "库存管理", ref: otherStockInFormRef };
    case "otherStockOut":
      return { tabId: otherStockOutTabId, title: "其他出库单", module: "库存管理", ref: otherStockOutFormRef };
    case "stockTransfer":
      return { tabId: stockTransferTabId, title: "调拨单", module: "库存管理", ref: stockTransferFormRef };
    case "stockCount":
      return { tabId: stockCountTabId, title: "盘点单", module: "库存管理", ref: stockCountFormRef };
    case "stockCountGain":
      return { tabId: stockCountGainTabId, title: "盘盈单", module: "库存管理", ref: stockCountGainFormRef };
    case "stockCountLoss":
      return { tabId: stockCountLossTabId, title: "盘亏单", module: "库存管理", ref: stockCountLossFormRef };
    case "salesOrder":
    default:
      return { tabId: "sales-order-form", title: "销售订单", module: "销售管理", ref: salesOrderFormRef };
  }
}

async function applyDocumentLock(tabId: string, type: OpenableDocumentType, billNo: string) {
  const lock = await acquireDocumentLock(type, billNo);
  const tab = tabs.tabs.value.find((item) => item.id === tabId);
  if (!tab) {
    return;
  }
  tab.lockedObjectId = billNo;
  tab.dirty = false;
  if (!lock.ok || !lock.data) {
    tab.lockReadOnly = true;
    tab.lockMessage = lock.message || "单据锁状态异常，已转只读";
    tab.lockCanOverride = false;
    return;
  }
  applyLockStateToTab(tabId, lock.data);
}

function applyLockStateToTab(tabId: string, lock: DocumentLockState) {
  const tab = tabs.tabs.value.find((item) => item.id === tabId);
  if (tab) {
    tab.lockReadOnly = Boolean(lock.readOnly);
    tab.lockCanOverride = Boolean(lock.canOverride);
    tab.lockMessage = lock.readOnly && lock.holderName ? `已被 ${lock.holderName} 打开，只读` : "";
  }
}

async function overrideActiveDocumentLock() {
  const tab = tabs.activeTab.value;
  const type = documentTypeByFormTabId(tab.id);
  if (!type || !tab.lockedObjectId) {
    return;
  }
  const result = await overrideDocumentLock(type, tab.lockedObjectId);
  if (!result.ok || !result.data) {
    tab.lockMessage = result.message || "强制解锁失败。";
    return;
  }
  applyLockStateToTab(tab.id, result.data);
  formMessage.value = "已踢走当前持锁人，你可以编辑。";
}
async function openDeliveryNoticeFromSalesOrder(row: Record<string, unknown>) {
  const sourceBillNo = String(row.billNo ?? "");
  if (!sourceBillNo) {
    return;
  }
  const result = await fetchSalesOrderDetail(sourceBillNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "销售订单详情加载失败。";
    return;
  }
  const today = new Date();
  const dateText = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  if (result.data.order.closeStatus === "CLOSED" || result.data.order.frozenStatus === "FROZEN") {
    formMessage.value = `销售订单 ${sourceBillNo} 已关闭或冻结，不能下推`;
    return;
  }
  const lines = result.data.lines
    .filter((line) => line.lineFrozenStatus !== "FROZEN")
    .map((line) => ({ ...toPendingPushLine({ ...line, remainingQty: line.availableNoticeQty ?? line.remainingQty }, "shippedQty"), sourceOrderNo: sourceBillNo }))
    .filter((line) => line.remainingQty > 0);
  if (lines.length === 0) {
    formMessage.value = `销售订单 ${sourceBillNo} 已无剩余可通知数量`;
    return;
  }
  tabs.openTab({
    id: deliveryNoticeTabId,
    title: "发货通知单",
    module: "销售管理",
    kind: "form",
    dirty: true
  });
  activeModuleName.value = "销售管理";
  await nextTick();
  deliveryNoticeFormRef.value?.applyPushDownDraft({
    billNo: "",
    sourceOrderNo: sourceBillNo,
    partyCode: result.data.order.customerCode || "",
    partyName: result.data.order.customer || "",
    billDate: dateText,
    currency: normalizeDocumentCurrency(result.data.order),
    department: result.data.order.department || "销售部",
    ownerName: session.userName.value || result.data.order.ownerName || "本地管理员",
    lines
  });
  formMessage.value = `已由销售订单 ${sourceBillNo} 按剩余数量生成发货通知单草稿`;
}

async function openOutboundFromDeliveryNotice(row: Record<string, unknown>) {
  const sourceBillNo = String(row.billNo ?? "");
  if (!sourceBillNo) {
    return;
  }
  const result = await fetchDocumentDetail("deliveryNotice", sourceBillNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "发货通知单详情加载失败。";
    return;
  }
  if (result.data.document.status !== "AUDITED") {
    formMessage.value = `发货通知单 ${sourceBillNo} 未审核，不能下推销售出库`;
    return;
  }
  const today = new Date();
  const dateText = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  const lines = result.data.lines
    .map((line) => ({
      productId: String(line.productId ?? ""),
      productCode: String(line.productCode ?? ""),
      productName: String(line.productName ?? ""),
      spec: String(line.spec ?? ""),
      warehouseCode: String(line.warehouseCode ?? "CK-001"),
      sourceOrderNo: String(line.sourceOrderNo ?? ""),
      sourceLineNo: Number(line.sourceLineNo ?? line.lineNo ?? 0),
      sourceDeliveryNoticeNo: sourceBillNo,
      sourceDeliveryLineNo: Number(line.lineNo ?? 0),
      sourceQty: Number(line.qty ?? 0),
      executedQty: Number(line.shippedQty ?? 0),
      remainingQty: Number(line.remainingQty ?? line.qty ?? 0),
      qty: Number(line.remainingQty ?? line.qty ?? 0),
      unitPrice: Number(line.unitPrice ?? 0),
      taxRate: Number(line.taxRate ?? 13),
      lineRemark: String(line.lineRemark ?? ""),
      planDeliveryDate: String(line.planDeliveryDate ?? "")
    }))
    .filter((line) => line.remainingQty > 0);
  if (lines.length === 0) {
    formMessage.value = `发货通知单 ${sourceBillNo} 已无剩余可出数量`;
    return;
  }
  tabs.openTab({
    id: outboundTabId,
    title: "销售" + "出库单",
    module: "销售管理",
    kind: "form",
    dirty: true
  });
  activeModuleName.value = "销售管理";
  await nextTick();
  outboundFormRef.value?.applyPushDownDraft({
    billNo: "",
    sourceOrderNo: sourceBillNo,
    partyCode: result.data.document.customerCode || "",
    partyName: result.data.document.customer || "",
    billDate: dateText,
    currency: normalizeDocumentCurrency(result.data.document.currency),
    department: result.data.document.department || "销售部",
    ownerName: session.userName.value || result.data.document.ownerName || "本地管理员",
    lines
  });
  formMessage.value = `已由发货通知单 ${sourceBillNo} 生成销售出库单草稿`;
}
async function openPurchaseInFromPurchaseOrder(row: Record<string, unknown>) {
  const sourceBillNo = String(row.billNo ?? "");
  if (!sourceBillNo) {
    return;
  }
  const result = await fetchDocumentDetail("purchaseOrder", sourceBillNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || `${"采购"}${"订单"}详情加载失败。`;
    return;
  }
  const today = new Date();
  const dateText = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  if (result.data.document.closeStatus === "CLOSED" || result.data.document.frozenStatus === "FROZEN") {
    formMessage.value = `采购订单 ${sourceBillNo} 已关闭或冻结，不能下推`;
    return;
  }
  const lines = result.data.lines
    .filter((line) => line.lineCloseStatus !== "CLOSED" && line.lineFrozenStatus !== "FROZEN")
    .map((line) => ({ ...toPendingPushLine(line, "receivedQty"), sourceOrderNo: sourceBillNo }))
    .filter((line) => line.remainingQty > 0);
  if (lines.length === 0) {
    formMessage.value = `${"采购"}${"订单"} ${sourceBillNo} 已无剩余可入数量`;
    return;
  }
  tabs.openTab({
    id: purchaseInTabId,
    title: "采购入库单",
    module: "采购管理",
    kind: "form",
    dirty: true
  });
  activeModuleName.value = "采购管理";
  await nextTick();
  purchaseInFormRef.value?.applyPushDownDraft({
    billNo: "",
    sourceOrderNo: sourceBillNo,
    partyCode: result.data.document.supplierCode || "",
    billDate: dateText,
    currency: normalizeDocumentCurrency(result.data.document.currency),
    department: result.data.document.department || "采购部",
    ownerName: session.userName.value || result.data.document.ownerName || "本地管理员",
    lines
  });
  formMessage.value = `已由采购订单 ${sourceBillNo} 按剩余数量生成采购入库单草稿`;
}
function remainingLineQty(line: { qty?: number | string; remainingQty?: number | string }) {
  const remaining = Number(line.remainingQty ?? line.qty ?? 0);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}
function normalizedQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  return Number.isFinite(qty) ? qty : 0;
}
function normalizedOptionalInt(value: number | string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function toPendingPushLine(line: { lineNo?: number | string; productId?: string; productCode?: string; productName?: string; spec?: string; warehouseCode?: string; qty?: number | string; unitPrice?: number | string; shippedQty?: number | string; receivedQty?: number | string; remainingQty?: number | string; availableNoticeQty?: number | string; customerMaterialCode?: string; customerOrderNo?: string; lineRemark?: string; planDeliveryDate?: string }, executedField: "shippedQty" | "receivedQty"): PendingPushLine {
  const sourceQty = normalizedQty(line.qty);
  const executedQty = normalizedQty(line[executedField]);
  const remainingQty = remainingLineQty(line);
  return {
    productId: String(line.productId ?? ""),
    productCode: String(line.productCode ?? ""),
    productName: String(line.productName ?? ""),
    spec: String(line.spec ?? ""),
    warehouseCode: String(line.warehouseCode ?? "CK-001"),
    sourceLineNo: normalizedOptionalInt(line.lineNo),
    sourceQty,
    executedQty,
    remainingQty,
    selected: false,
    qty: remainingQty,
    unitPrice: Number(line.unitPrice ?? 0),
    customerMaterialCode: String(line.customerMaterialCode ?? ""),
    customerOrderNo: String(line.customerOrderNo ?? ""),
    lineRemark: String(line.lineRemark ?? ""),
    planDeliveryDate: String(line.planDeliveryDate ?? "")
  };
}
function masterTitle(listKey: string) {
  return masterDataDefinitions[listKey]?.title ?? "基础资料";
}
function masterModule(_listKey: string) {
  return "基础资料";
}
function canMaintainMasterList(listKey: string) {
  const definition = masterDataDefinitions[listKey];
  return Boolean(definition && session.hasPermission(definition.maintainPermission));
}
function canMaintainMasterRecord(record: MasterRecordState) {
  return session.hasPermission(record.maintainPermission);
}
function newMasterForm(listKey: string, row: Record<string, unknown> | null, options: { copy?: boolean } = {}) {
  const definition = masterDataDefinitions[listKey];
  const form: Record<string, string> = {};
  definition.fields.forEach((field) => {
    if (row) {
      let value = String(row[field.name] ?? "");
      if (field.type === "checkbox") {
        value = value === "是" || value === "true" ? "true" : "false";
      }
      form[field.name] = value;
      return;
    }
    form[field.name] = field.defaultValue ?? fieldOptionValue(field.options?.[0]);
  });
  form.status = normalizeMasterStatus(row?.status ?? form.status ?? "启用");
  form.auditStatus = normalizeMasterAuditStatus(row?.auditStatus ?? form.auditStatus ?? "草稿");
  if (options.copy) {
    form.systemNo = "";
    form.code = "";
    form.auditStatus = "草稿";
  }
  return form;
}

function openMasterRecord(
  payload: { listKey: string; row: Record<string, unknown> | null },
  options: { mode: "create" | "view" | "edit" | "copy"; tabId?: string } = { mode: "create" }
) {
  const definition = masterDataDefinitions[payload.listKey];
  if (!definition) {
    return;
  }
  if (options.mode !== "view" && !canMaintainMasterList(payload.listKey)) {
    return;
  }
  const title = masterTitle(payload.listKey);
  const code = String(payload.row?.code ?? "");
  if ((options.mode === "view" || options.mode === "edit") && !code) {
    return;
  }
  const persisted = options.mode === "view" || options.mode === "edit";
  const tabId = options.tabId ?? (
    persisted
      ? masterRecordTabId(payload.listKey, code)
      : options.mode === "copy"
        ? `${payload.listKey}:copy:${Date.now()}`
        : `${payload.listKey}:create`
  );
  const existingRecord = masterRecords[tabId];
  if (existingRecord) {
    tabs.activeTabId.value = tabId;
    if (options.mode === "edit") {
      existingRecord.editing = true;
      existingRecord.readOnly = false;
      updateMasterTabTitle(tabId, `编辑${existingRecord.title}`);
    }
    return;
  }
  const editing = options.mode === "edit";
  const readOnly = options.mode === "view";
  const form = newMasterForm(payload.listKey, payload.row, { copy: options.mode === "copy" });
  const requiresVersion = Boolean(definition.sparsePatch);
  const version = requiresVersion ? (persisted ? parseMasterVersion(payload.row?.version) : 0) : null;
  masterRecords[tabId] = {
    id: tabId,
    listKey: payload.listKey,
    type: definition.type,
    title,
    editing,
    readOnly,
    originalCode: persisted ? code : "",
    version,
    sparsePatch: requiresVersion,
    maintainPermission: definition.maintainPermission,
    allowDelete: definition.allowDelete !== false,
    fields: definition.fields,
    form,
    originalForm: { ...form },
    error: persisted && requiresVersion && version === null ? "资料版本缺失，请返回列表刷新后重试。" : ""
  };
  const actionTitle = options.mode === "view" ? title : options.mode === "edit" ? `编辑${title}` : `新增${title}`;
  tabs.openTab({
    id: tabId,
    title: actionTitle,
    module: masterModule(payload.listKey),
    kind: "form",
    dirty: options.mode === "create" || options.mode === "copy"
  });
}

function masterRecordTabId(listKey: string, code: string) {
  return `${listKey}:record:${code}`;
}

function updateMasterTabTitle(tabId: string, title: string) {
  const targetTab = tabs.tabs.value.find((tab) => tab.id === tabId);
  if (targetTab) {
    targetTab.title = title;
  }
}

function openCreateMasterData(payload: { listKey: string }) {
  openMasterRecord({ listKey: payload.listKey, row: null }, { mode: "create" });
}

function openViewMasterData(payload: { listKey: string; row: Record<string, unknown> }) {
  openMasterRecord(payload, { mode: "view" });
}

function openEditMasterData(payload: { listKey: string; row: Record<string, unknown> }) {
  openMasterRecord(payload, { mode: "edit" });
}

function openCopyMasterData(payload: { listKey: string; row: Record<string, unknown> }) {
  openMasterRecord(payload, { mode: "copy" });
}

function editActiveMasterRecord() {
  const record = activeMasterRecord.value;
  if (!record || !canMaintainMasterRecord(record)) {
    return;
  }
  if (record.sparsePatch && normalizeMasterAuditStatus(record.form.auditStatus) === "已审核") {
    record.error = "已审核资料不能直接编辑，请先执行反审核。";
    return;
  }
  record.editing = true;
  record.readOnly = false;
  record.error = "";
  updateMasterTabTitle(record.id, `编辑${record.title}`);
}
function updateActiveMasterField(name: string, value: string) {
  const record = activeMasterRecord.value;
  if (!record || record.readOnly || !canMaintainMasterRecord(record)) {
    return;
  }
  record.form[name] = value;
  clearInactiveMasterFields(record);
  record.error = "";
  markActiveDirty();
}

function masterFieldConditionMatches(
  condition: MasterDataField["visibleWhen"] | MasterDataField["requiredWhen"],
  form: Record<string, string>
) {
  return !condition || condition.values.includes(String(form[condition.field] ?? ""));
}

function isMasterFieldVisible(field: MasterDataField, form: Record<string, string>) {
  return masterFieldConditionMatches(field.visibleWhen, form);
}

function isMasterFieldRequired(field: MasterDataField, form: Record<string, string>) {
  return Boolean(field.required || (field.requiredWhen && masterFieldConditionMatches(field.requiredWhen, form)));
}

function clearInactiveMasterFields(record: MasterRecordState) {
  record.fields.forEach((field) => {
    if (field.clearWhenHidden && !isMasterFieldVisible(field, record.form)) {
      record.form[field.name] = "";
    }
  });
}

function openNewActiveMasterRecord() {
  const record = activeMasterRecord.value;
  if (!record || !canMaintainMasterRecord(record)) {
    return;
  }
  if (tabs.activeTab.value?.dirty && !window.confirm("当前资料有未保存改动，确认新建空白资料？")) {
    return;
  }
  openCreateMasterData({ listKey: record.listKey });
}
function cancelActiveMasterRecord() {
  const record = activeMasterRecord.value;
  if (!record) {
    return;
  }
  const tabId = record.id;
  clearActiveDirty();
  tabs.closeNow(tabId);
  tabs.activeTabId.value = record.listKey;
}
async function saveActiveMasterRecord() {
  const record = activeMasterRecord.value;
  if (!record || record.readOnly || !canMaintainMasterRecord(record)) {
    return;
  }
  clearInactiveMasterFields(record);
  const missingField = record.fields.find((field) => isMasterFieldVisible(field, record.form)
    && isMasterFieldRequired(field, record.form)
    && !record.form[field.name]?.trim());
  if (missingField) {
    record.error = `${missingField.label}不能为空。`;
    return;
  }
  let result: Awaited<ReturnType<typeof createMasterData>>;
  if (record.editing) {
    if (record.sparsePatch) {
      if (record.version === null) {
        record.error = "资料版本缺失，请返回列表刷新后重试。";
        return;
      }
      const patch = buildMasterDataPatch(record);
      if (patch.error) {
        record.error = patch.error;
        return;
      }
      if (Object.keys(patch.changes).length === 0) {
        record.error = "没有需要保存的修改。";
        clearActiveDirty();
        return;
      }
      result = await patchMasterData(record.type, record.originalCode, {
        version: record.version,
        changes: patch.changes
      });
    } else {
      result = await updateMasterData(record.type, record.originalCode, { ...record.form });
    }
  } else {
    result = await createMasterData(record.type, buildMasterDataCreatePayload(record));
  }
  if (!result.ok) {
    record.error = result.message;
    return;
  }
  const savedRow = result.data?.rows[0] ?? {};
  const savedCode = String(savedRow.code ?? record.form.code ?? record.originalCode).trim();
  if (!savedCode) {
    record.error = "保存成功但未返回资料编码，请刷新列表确认。";
    return;
  }
  mergeMasterDataResponse(record, savedRow);
  record.originalCode = savedCode;
  record.editing = true;
  record.readOnly = false;
  record.originalForm = { ...record.form };
  record.error = "";
  const nextTabId = masterRecordTabId(record.listKey, savedCode);
  if (record.id !== nextTabId) {
    const currentTab = tabs.tabs.value.find((tab) => tab.id === record.id);
    if (currentTab) {
      currentTab.id = nextTabId;
      currentTab.title = `编辑${record.title}`;
      tabs.activeTabId.value = nextTabId;
    }
    delete masterRecords[record.id];
    record.id = nextTabId;
    masterRecords[nextTabId] = record;
  } else {
    updateMasterTabTitle(record.id, `编辑${record.title}`);
  }
  clearActiveDirty();
}

function buildMasterDataCreatePayload(record: MasterRecordState) {
  const writableFields = new Set<string>();
  record.fields.forEach((field) => {
    if (!field.readonly) {
      writableFields.add(field.name);
    }
    if (field.fileDataName) {
      writableFields.add(field.fileDataName);
    }
  });
  return Object.fromEntries(
    Object.entries(record.form).filter(([field]) => writableFields.has(field))
  );
}

async function auditActiveMasterRecord() {
  const record = activeMasterRecord.value;
  if (!record?.editing || record.readOnly || !record.originalCode || !canMaintainMasterRecord(record)) {
    return;
  }
  if (isMasterRecordDirty(record)) {
    record.error = "存在未保存修改，请先保存或放弃修改后再审核。";
    return;
  }
  const result = await auditMasterData(record.type, record.originalCode);
  if (!result.ok) {
    record.error = result.message || "审核失败。";
    return;
  }
  mergeMasterLifecycleResponse(record, result.data?.rows[0], { auditStatus: "已审核" });
  record.originalForm = { ...record.form };
  record.error = "";
  clearActiveDirty();
}
async function reverseAuditActiveMasterRecord() {
  const record = activeMasterRecord.value;
  if (!record || !record.originalCode || !canMaintainMasterRecord(record)) {
    return;
  }
  if (isMasterRecordDirty(record)) {
    record.error = "存在未保存修改，请先保存或放弃修改后再反审核。";
    return;
  }
  const result = await reverseAuditMasterData(record.type, record.originalCode);
  if (!result.ok) {
    record.error = result.message || "反审核失败。";
    return;
  }
  mergeMasterLifecycleResponse(record, result.data?.rows[0], { auditStatus: "草稿" });
  record.editing = true;
  record.readOnly = false;
  record.originalForm = { ...record.form };
  record.error = "";
  updateMasterTabTitle(record.id, `编辑${record.title}`);
  clearActiveDirty();
}
async function toggleActiveMasterStatus() {
  const record = activeMasterRecord.value;
  if (!record?.editing || record.readOnly || !record.originalCode || !canMaintainMasterRecord(record)) {
    return;
  }
  if (isMasterRecordDirty(record)) {
    record.error = "存在未保存修改，请先保存或放弃修改后再启用或禁用。";
    return;
  }
  const nextEnabled = (record.form.status || "启用") === "禁用";
  const result = await setMasterDataStatus(record.type, record.originalCode, nextEnabled);
  if (!result.ok) {
    record.error = result.message || "状态更新失败。";
    return;
  }
  mergeMasterLifecycleResponse(record, result.data?.rows[0], { status: nextEnabled ? "启用" : "禁用" });
  record.originalForm = { ...record.form };
  record.error = "";
}
async function deleteActiveMasterRecord() {
  const record = activeMasterRecord.value;
  if (!record?.editing || record.readOnly || !record.originalCode || !record.allowDelete || !canMaintainMasterRecord(record)) {
    return;
  }
  if (isMasterRecordDirty(record)) {
    record.error = "存在未保存修改，请先保存或放弃修改后再删除。";
    return;
  }
  if (!window.confirm(`确定删除当前${record.title}吗？`)) {
    return;
  }
  const result = await deleteMasterData(record.type, record.originalCode);
  if (!result.ok) {
    record.error = result.message || "删除资料失败。";
    return;
  }
  clearActiveDirty();
  delete masterRecords[record.id];
  tabs.closeNow(record.id);
  tabs.activeTabId.value = record.listKey;
}

function buildMasterDataPatch(record: MasterRecordState) {
  const changes: Record<string, MasterDataPatchValue> = {};
  for (const field of record.fields) {
    if (!isMasterDataPatchField(field)) {
      continue;
    }
    const currentValue = String(record.form[field.name] ?? "");
    const originalValue = String(record.originalForm[field.name] ?? "");
    if (currentValue !== originalValue) {
      const serialized = serializeMasterDataPatchValue(field, currentValue);
      if (serialized.error) {
        return { changes: {}, error: serialized.error };
      }
      changes[field.name] = serialized.value;
    }
    const fileDataName = field.fileDataName;
    if (fileDataName) {
      const currentFileData = String(record.form[fileDataName] ?? "");
      const originalFileData = String(record.originalForm[fileDataName] ?? "");
      if (currentFileData !== originalFileData) {
        changes[fileDataName] = currentFileData || null;
      }
    }
  }
  return { changes, error: "" };
}

function isMasterDataPatchField(field: MasterDataField) {
  return !field.readonly
    && !field.readonlyWhenEditing
    && !["code", "systemNo", "version", "auditStatus", "status", "enabled"].includes(field.name);
}

function serializeMasterDataPatchValue(field: MasterDataField, rawValue: string): { value: MasterDataPatchValue; error: string } {
  const value = rawValue.trim();
  if (!value && !field.required) {
    return { value: null, error: "" };
  }
  if (field.type === "checkbox") {
    if (value !== "true" && value !== "false") {
      return { value: false, error: `${field.label}格式不正确。` };
    }
    return { value: value === "true", error: "" };
  }
  if (field.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return { value: null, error: `${field.label}必须是有效数字。` };
    }
    return { value: number, error: "" };
  }
  return { value: rawValue, error: "" };
}

function mergeMasterDataResponse(record: MasterRecordState, row: Record<string, unknown>) {
  const editableFormKeys = new Set([...record.fields.map((field) => field.name), "status", "auditStatus"]);
  editableFormKeys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(row, key)) {
      return;
    }
    const field = record.fields.find((candidate) => candidate.name === key);
    const value = row[key];
    record.form[key] = field?.type === "checkbox"
      ? normalizeMasterCheckboxValue(value)
      : String(value ?? "");
  });
  record.form.status = normalizeMasterStatus(record.form.status || "启用");
  record.form.auditStatus = normalizeMasterAuditStatus(record.form.auditStatus || "草稿");
  if (record.sparsePatch) {
    const responseVersion = parseMasterVersion(row.version);
    if (responseVersion !== null) {
      record.version = responseVersion;
    } else if (record.editing && record.version !== null) {
      record.version += 1;
    } else {
      record.version = 0;
    }
  }
}

function mergeMasterLifecycleResponse(
  record: MasterRecordState,
  row: Record<string, unknown> | undefined,
  fallback: { auditStatus?: string; status?: string }
) {
  if (row?.auditStatus !== undefined || fallback.auditStatus !== undefined) {
    record.form.auditStatus = normalizeMasterAuditStatus(row?.auditStatus ?? fallback.auditStatus);
  }
  if (row?.status !== undefined || fallback.status !== undefined) {
    record.form.status = normalizeMasterStatus(row?.status ?? fallback.status);
  }
  if (record.sparsePatch) {
    const responseVersion = parseMasterVersion(row?.version);
    if (responseVersion !== null) {
      record.version = responseVersion;
    } else if (record.version !== null) {
      record.version += 1;
    }
  }
}

function isMasterRecordDirty(record: MasterRecordState) {
  return Boolean(tabs.tabs.value.find((tab) => tab.id === record.id)?.dirty);
}

function parseMasterVersion(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

function normalizeMasterAuditStatus(value: unknown) {
  const status = String(value ?? "").trim();
  return status === "AUDITED" || status === "已审核" ? "已审核" : "草稿";
}

function normalizeMasterStatus(value: unknown) {
  if (value === false || String(value ?? "").trim() === "禁用") {
    return "禁用";
  }
  return "启用";
}

function normalizeMasterCheckboxValue(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "是" ? "true" : "false";
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
</script>
