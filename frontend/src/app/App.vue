<template>
  <section v-if="!isAuthenticated" class="login-page" data-testid="login-page">
    <form class="login-panel" @submit.prevent="loginCurrentUser">
      <div class="login-panel__brand">JDY</div>
      <h1>金蝶云星辰复刻工作台</h1>
      <p>选择员工账号并输入密码后进入当前测试账套。</p>
      <label>
        <span>账号</span>
        <select v-model="loginForm.username" data-testid="login-username">
          <option v-for="user in systemUsers" :key="user.username" :value="user.username">
            {{ user.displayName }} / {{ user.roleName }}
          </option>
        </select>
      </label>
      <label>
        <span>密码</span>
        <input v-model="loginForm.password" data-testid="login-password" type="password" autocomplete="current-password" />
      </label>
      <button class="primary-action" type="submit" data-testid="login-submit">登录</button>
      <p v-if="loginMessage" class="login-message" data-testid="login-message">{{ loginMessage }}</p>
    </form>
  </section>

  <div v-else class="erp-shell" :class="{ compact: preferences.compactDensity.value, 'module-panel-open': modulePanelOpen }">
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
            <strong data-testid="session-user-name">{{ session.userName.value }}</strong>
            <span data-testid="session-user-role">{{ session.userRole.value }}</span>
          </div>
          <button type="button" data-testid="session-password-change" @click="openPasswordDialog">修改密码</button>
          <button type="button" data-testid="session-logout" @click="logoutCurrentUser">退出</button>
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
            <button class="primary-action" type="button" :disabled="!canOpenEntry(demoDirtyEntry)" @click="openEntry(demoDirtyEntry)">打开未保存样例</button>
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

        <div v-else-if="tabs.activeTab.value.kind === 'shell' && !['print-template-settings', 'role-permission-settings', 'user-role-list'].includes(tabs.activeTab.value.id)" class="panel-page">
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <div class="empty-shell">首版范围裁剪：该入口仅保留壳层，不进入深层业务页。</div>
        </div>

        <div v-else-if="tabs.activeTab.value.id === 'user-role-list'" class="role-permission-page">
          <section class="role-permission-head">
            <div>
              <h2>用户角色</h2>
              <p>维护员工账号、启停状态和角色归属，角色权限细项在权限矩阵中维护。</p>
            </div>
            <div class="role-permission-head__actions">
              <button type="button" data-testid="user-management-refresh" @click="loadManagedUsers">刷新</button>
              <button class="primary-action" type="button" :disabled="!canManageRolePermissions" data-testid="user-management-new" @click="startCreateManagedUser">新增</button>
              <button class="primary-action" type="button" :disabled="!canManageRolePermissions" data-testid="user-management-save" @click="saveManagedUser">保存</button>
            </div>
          </section>
          <section class="role-permission-body">
            <aside class="role-permission-list" aria-label="用户">
              <button
                v-for="user in managedUsers"
                :key="user.username"
                type="button"
                :class="{ active: user.username === selectedManagedUsername }"
                :data-testid="`managed-user-${user.username}`"
                @click="selectManagedUser(user.username)"
              >
                <strong>{{ user.displayName }}</strong>
                <span>{{ user.username }} / {{ user.roleName }} / {{ user.enabled ? "启用" : "禁用" }}</span>
              </button>
            </aside>
            <div class="user-management-form">
              <div class="role-permission-summary" data-testid="user-management-summary">
                <strong>{{ userManagementMode === "create" ? "新增用户" : selectedManagedUser?.displayName || "未选择用户" }}</strong>
                <span>{{ userManagementMode === "create" ? "CREATE" : selectedManagedUser?.username || "" }}</span>
                <em>{{ selectedManagedUser?.roleName || "选择角色后保存" }}</em>
              </div>
              <label>
                <span>用户名</span>
                <input v-model="managedUserForm.username" :readonly="userManagementMode === 'edit'" data-testid="managed-user-username" />
              </label>
              <label>
                <span>姓名</span>
                <input v-model="managedUserForm.displayName" data-testid="managed-user-display-name" />
              </label>
              <label>
                <span>角色</span>
                <select v-model="managedUserForm.roleCode" data-testid="managed-user-role">
                  <option v-for="role in managedRoles" :key="role.code" :value="role.code">{{ role.name }} / {{ role.code }}</option>
                </select>
              </label>
              <label class="user-management-check">
                <input v-model="managedUserForm.enabled" type="checkbox" data-testid="managed-user-enabled" />
                <span>启用</span>
              </label>
              <label>
                <span>{{ userManagementMode === "create" ? "初始密码" : "重置密码" }}</span>
                <input v-model="managedUserPassword" type="password" data-testid="managed-user-password" />
              </label>
              <div class="role-permission-head__actions">
                <button type="button" :disabled="userManagementMode === 'create' || !canManageRolePermissions" data-testid="managed-user-reset-password" @click="resetManagedUserPasswordAction">重置密码</button>
              </div>
              <p v-if="userManagementMessage" class="form-message" data-testid="user-management-message">{{ userManagementMessage }}</p>
            </div>
          </section>
        </div>

        <div v-else-if="tabs.activeTab.value.id === 'role-permission-settings'" class="role-permission-page">
          <section class="role-permission-head">
            <div>
              <h2>权限矩阵</h2>
              <p>按角色维护系统权限，保存后写入后端 RBAC 表。</p>
            </div>
            <div class="role-permission-head__actions">
              <button type="button" data-testid="role-permission-refresh" @click="loadRolePermissions">刷新</button>
              <button class="primary-action" type="button" :disabled="!canManageRolePermissions" data-testid="role-permission-save" @click="saveSelectedRolePermissions">保存</button>
            </div>
          </section>
          <section class="role-permission-body">
            <aside class="role-permission-list" aria-label="角色">
              <button
                v-for="role in rolePermissionMatrix?.roles ?? []"
                :key="role.code"
                type="button"
                :class="{ active: role.code === selectedRoleCode }"
                :data-testid="`role-permission-role-${role.code}`"
                @click="selectRolePermissionRole(role.code)"
              >
                <strong>{{ role.name }}</strong>
                <span>{{ role.code }} / {{ role.enabled ? "启用" : "禁用" }}</span>
              </button>
            </aside>
            <div class="role-permission-matrix">
              <div class="role-permission-summary" data-testid="role-permission-summary">
                <strong>{{ selectedRole?.name || "未选择角色" }}</strong>
                <span>{{ selectedRole?.code || "" }}</span>
                <em>已勾选 {{ selectedRolePermissionCount }} 项权限</em>
              </div>
              <div v-for="group in permissionGroups" :key="group.moduleName" class="permission-group">
                <h3>{{ group.moduleName }}</h3>
                <div class="permission-grid">
                  <label v-for="permission in group.permissions" :key="permission.permissionCode" :data-testid="`permission-cell-${permission.permissionCode}`">
                    <input
                      type="checkbox"
                      :checked="rolePermissionChecked(permission.permissionCode)"
                      :data-testid="`permission-check-${permission.permissionCode}`"
                      @change="toggleRolePermission(permission.permissionCode, ($event.target as HTMLInputElement).checked)"
                    />
                    <span>{{ permission.permissionName }}</span>
                    <small>{{ permission.permissionCode }}</small>
                  </label>
                </div>
              </div>
              <p v-if="rolePermissionMessage" class="form-message" data-testid="role-permission-message">{{ rolePermissionMessage }}</p>
            </div>
          </section>
        </div>

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
                <input v-model="printTemplateForm.templateName" data-testid="print-template-name" />
              </label>
              <label>
                公司抬头
                <input v-model="printTemplateForm.companyName" data-testid="print-template-company" />
              </label>
              <label>
                页眉说明
                <input v-model="printTemplateForm.headerNote" data-testid="print-template-header-note" />
              </label>
              <label class="print-template-form__wide">
                页脚说明
                <textarea v-model="printTemplateForm.footerNote" rows="3" data-testid="print-template-footer-note"></textarea>
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
                <small>{{ printTemplateForm.footerNote }}</small>
              </div>
              <p v-if="printTemplateMessage" class="form-message" data-testid="print-template-message">{{ printTemplateMessage }}</p>
            </form>
          </section>
        </div>

        <DataListPage
          v-else-if="tabs.activeTab.value.kind === 'list' || tabs.activeTab.value.kind === 'report'"
          :list-key="tabs.activeTab.value.id"
          :locked="isLockedList"
          @push-down-sales-out="openSalesOutFromSalesOrder"
          @push-down-purchase-in="openPurchaseInFromPurchaseOrder"
          @open-document="openDocumentFromList"
        />

        <div v-else class="business-page">
          <div class="business-head">
            <div>
              <h2>{{ tabs.activeTab.value.title }}</h2>
              <p>{{ pageSubtitle }}</p>
            </div>
            <div class="status-stamp" :class="tabs.activeTab.value.kind" data-testid="document-status">{{ currentOrderStatusLabel }}</div>
          </div>

          <div v-if="isLockedList" class="lock-banner" data-testid="lock-banner">
            单据已在其他页签打开，列表的审核/删除/批量操作已锁定。
            <button type="button" @click="tabs.activeTabId.value = 'sales-order-form'">查看已有单据</button>
          </div>

          <div class="action-bar">
            <button class="primary-action" type="button" :disabled="isLockedList" data-testid="new-document" @click="startNewCurrentDocument">新增</button>
            <button type="button" :disabled="!isDraftDocument" data-testid="save-sales-order" @click="saveCurrentDocument">保存</button>
            <button type="button" :disabled="!canAuditCurrentDocument" data-testid="audit-sales-order" @click="auditCurrentDocument">审核</button>
            <button type="button" :disabled="!canReverseDocument" data-testid="reverse-document" @click="openRiskyDocumentAction('reverse')">反审核</button>
            <button type="button" :disabled="!canReverseDocument" data-testid="red-reverse-document" @click="openRiskyDocumentAction('redReverse')">红冲</button>
            <button type="button" :disabled="!canVoidDocument" data-testid="void-document" @click="voidCurrentDocument">作废</button>
            <button type="button" :disabled="!canDeleteSalesOrder" data-testid="delete-sales-order" @click="deleteCurrentSalesOrder">删除</button>
            <button type="button" :disabled="!isDocumentForm" data-testid="export-sales-order" @click="exportCurrentDocument">引出</button>
            <button type="button" :disabled="!isDocumentForm" data-testid="print-sales-order" @click="printCurrentDocument">打印</button>
            <span v-if="tabs.activeTab.value.dirty" class="dirty-tip">有未保存改动</span>
            <span v-if="formMessage" class="form-message" data-testid="form-message">{{ formMessage }}</span>
          </div>

          <div v-if="isDocumentForm" class="form-layout">
            <section class="form-head-fields">
              <div v-if="isStockDocumentForm" class="source-order-field">
                <label>源订单号<input v-model="currentOrderForm.sourceOrderNo" :data-testid="`${formTestPrefix}-source-order-no`" @input="markActiveDirty" /></label>
                <button type="button" :disabled="!canTraceSourceOrder" data-testid="trace-source-order" @click="traceSourceOrder()">追踪源单</button>
                <button v-if="currentOrderForm.redReverseBillNo" class="red-reverse-link" type="button" data-testid="open-red-reverse-bill" @click="openRedReverseBill">红字单 {{ currentOrderForm.redReverseBillNo }}</button>
                <button v-if="currentOrderForm.redSourceBillNo" class="red-reverse-link" type="button" data-testid="open-red-source-bill" @click="openRedSourceBill">来源原单 {{ currentOrderForm.redSourceBillNo }}</button>
              </div>
              <label>
                {{ partyLabel }}编码
                <span class="master-selector">
                  <input
                    v-model="currentOrderForm.partyCode"
                    :data-testid="`${formTestPrefix}-party-code`"
                    @focus="searchMasterOptions(partyType, currentOrderForm.partyCode, `${formTestPrefix}-party`)"
                    @input="handleMasterInput(partyType, currentOrderForm.partyCode, `${formTestPrefix}-party`)"
                    @keydown="handleSelectorKeydown($event, `${formTestPrefix}-party`)"
                  />
                  <span v-if="activeSelector === `${formTestPrefix}-party`" class="master-selector__menu">
                    <button
                      v-for="(option, optionIndex) in selectorOptions"
                      :key="option.code"
                      type="button"
                      :class="{ selected: selectorCursorIndex === optionIndex }"
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
            <div class="entry-tools">
              <label>
                批量仓库
                <input
                  v-model="batchWarehouseCode"
                  :disabled="!isDraftDocument"
                  data-testid="batch-warehouse-code"
                  @keydown.enter="applyBatchWarehouse"
                />
              </label>
              <button type="button" :disabled="!isDraftDocument" data-testid="apply-batch-warehouse" @click="applyBatchWarehouse">应用</button>
            </div>
            <div class="entry-table">
              <table>
                <thead>
                  <tr>
                    <th>商品编码</th>
                    <th>商品名称</th>
                    <th>规格型号</th>
                    <th>仓库</th>
                    <th v-if="showSourceLineColumn">源行号</th>
                    <th>数量</th>
                    <th v-if="showExecutionColumns">已执行</th>
                    <th v-if="showExecutionColumns">剩余</th>
                    <th>单价</th>
                    <th>金额</th>
                    <th>备注</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(line, lineIndex) in currentOrderForm.lines"
                    :key="lineIndex"
                    :class="{ 'is-dragging': draggingLineIndex === lineIndex, 'is-source-target': isHighlightedSourceLine(line, lineIndex) }"
                    :draggable="isDraftDocument"
                    :data-testid="`${formTestPrefix}-entry-row`"
                    :data-line-no="lineLineNo(line, lineIndex)"
                    @dragstart="handleLineDragStart($event, lineIndex)"
                    @dragover.prevent="handleLineDragOver($event)"
                    @drop.prevent="handleLineDrop(lineIndex)"
                    @dragend="handleLineDragEnd"
                  >
                    <td>
                      <span class="master-selector in-cell">
                        <input
                          v-model="line.productCode"
                          :disabled="!isDraftDocument"
                          :data-testid="lineProductTestId(lineIndex)"
                          @focus="searchMasterOptions('product', line.productCode, `${formTestPrefix}-line-${lineIndex}-product`)"
                          @input="handleMasterInput('product', line.productCode, `${formTestPrefix}-line-${lineIndex}-product`)"
                          @keydown="handleLineCellKeydown($event, lineIndex, 'product', `${formTestPrefix}-line-${lineIndex}-product`)"
                          @paste="handleEntryPaste($event, lineIndex)"
                        />
                        <span v-if="activeSelector === `${formTestPrefix}-line-${lineIndex}-product`" class="master-selector__menu">
                          <button
                            v-for="(option, optionIndex) in selectorOptions"
                            :key="option.code"
                            type="button"
                            :class="{ selected: selectorCursorIndex === optionIndex }"
                            @mousedown.prevent="selectLineProduct(option, lineIndex)"
                          >
                            <strong>{{ option.code }}</strong>
                            <span>{{ option.name }}</span>
                          </button>
                        </span>
                      </span>
                    </td>
                    <td>{{ productInfo(line).name }}</td>
                    <td>{{ productInfo(line).spec }}</td>
                    <td>
                      <span class="master-selector in-cell">
                        <input
                          v-model="line.warehouseCode"
                          :disabled="!isDraftDocument"
                          :data-testid="lineWarehouseTestId(lineIndex)"
                          @focus="searchMasterOptions('warehouse', line.warehouseCode, `${formTestPrefix}-line-${lineIndex}-warehouse`)"
                          @input="handleMasterInput('warehouse', line.warehouseCode, `${formTestPrefix}-line-${lineIndex}-warehouse`)"
                          @keydown="handleLineCellKeydown($event, lineIndex, 'warehouse', `${formTestPrefix}-line-${lineIndex}-warehouse`)"
                          @paste="handleEntryPaste($event, lineIndex)"
                        />
                        <span v-if="activeSelector === `${formTestPrefix}-line-${lineIndex}-warehouse`" class="master-selector__menu">
                          <button
                            v-for="(option, optionIndex) in selectorOptions"
                            :key="option.code"
                            type="button"
                            :class="{ selected: selectorCursorIndex === optionIndex }"
                            @mousedown.prevent="selectWarehouseOption(option, lineIndex)"
                          >
                            <strong>{{ option.code }}</strong>
                            <span>{{ option.name }}</span>
                          </button>
                        </span>
                      </span>
                    </td>
                    <td v-if="showSourceLineColumn" class="readonly-qty" :data-testid="lineSourceLineNoTestId(lineIndex)">
                      <button
                        v-if="line.sourceLineNo"
                        class="source-line-link"
                        type="button"
                        :data-testid="lineSourceTraceTestId(lineIndex)"
                        @click="traceSourceOrder(line.sourceLineNo)"
                      >
                        {{ lineSourceLineNo(line) }}
                      </button>
                      <span v-else>-</span>
                    </td>
                    <td><input v-model.number="line.qty" :disabled="!isDraftDocument" :data-testid="lineQtyTestId(lineIndex)" @input="markActiveDirty" @keydown="handleLineCellKeydown($event, lineIndex, 'qty')" @paste="handleEntryPaste($event, lineIndex)" /></td>
                    <td v-if="showExecutionColumns" class="readonly-qty" :data-testid="lineExecutedQtyTestId(lineIndex)">
                      <button
                        v-if="line.downstreamDocs?.length"
                        class="source-line-link"
                        type="button"
                        :data-testid="lineDownstreamTraceTestId(lineIndex)"
                        @click="openDownstreamTrace(line, lineIndex)"
                      >
                        {{ lineExecutedQty(line) }}
                      </button>
                      <span v-else>{{ lineExecutedQty(line) }}</span>
                    </td>
                    <td v-if="showExecutionColumns" class="readonly-qty" :data-testid="lineRemainingQtyTestId(lineIndex)">{{ lineRemainingQty(line) }}</td>
                    <td><input v-model.number="line.unitPrice" :disabled="!isDraftDocument" :data-testid="linePriceTestId(lineIndex)" @input="markActiveDirty" @keydown="handleLineCellKeydown($event, lineIndex, 'price')" @paste="handleEntryPaste($event, lineIndex)" /></td>
                    <td class="amount-cell" :data-testid="lineAmountTestId(lineIndex)">{{ lineAmount(line) }}</td>
                    <td class="remark-cell"><input v-model="line.lineRemark" :disabled="!isDraftDocument" :data-testid="lineRemarkTestId(lineIndex)" @input="markActiveDirty" /></td>
                    <td>
                      <button
                        class="line-action drag-handle"
                        type="button"
                        :disabled="!isDraftDocument"
                        :data-testid="lineDragHandleTestId(lineIndex)"
                        title="拖拽调整行顺序"
                      >
                        ↕
                      </button>
                      <button
                        class="line-action"
                        type="button"
                        :disabled="!isDraftDocument"
                        :data-testid="lineInsertTestId(lineIndex)"
                        @click="insertLineAfter(lineIndex)"
                      >
                        插入
                      </button>
                      <button
                        class="line-action"
                        type="button"
                        :disabled="!isDraftDocument || currentOrderForm.lines.length <= 1"
                        :data-testid="lineDeleteTestId(lineIndex)"
                        @click="removeLine(lineIndex)"
                      >
                        删除
                      </button>
                      <button
                        class="line-action"
                        type="button"
                        :disabled="!isDraftDocument"
                        :data-testid="lineCopyTestId(lineIndex)"
                        @click="copyLine(lineIndex)"
                      >
                        复制
                      </button>
                    </td>
                  </tr>
                  <tr>
                    <td :colspan="entryTotalColspan" class="total-cell">合计</td>
                    <td class="amount-cell" data-testid="document-total-amount">{{ currentOrderTotal }}</td>
                  </tr>
                  <tr>
                    <td :colspan="entryTableColspan" class="add-line">
                      <button type="button" :disabled="!isDraftDocument" data-testid="add-document-line" @click="addLine">+ 增加明细行</button>
                    </td>
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

    <div v-if="passwordDialogOpen" class="modal-mask" data-testid="password-change-dialog">
      <form class="dialog password-dialog" @submit.prevent="submitPasswordChange">
        <h3>修改密码</h3>
        <label>
          <span>当前密码</span>
          <input v-model="passwordForm.currentPassword" type="password" data-testid="password-current" autocomplete="current-password" />
        </label>
        <label>
          <span>新密码</span>
          <input v-model="passwordForm.newPassword" type="password" data-testid="password-new" autocomplete="new-password" />
        </label>
        <label>
          <span>确认新密码</span>
          <input v-model="passwordForm.confirmPassword" type="password" data-testid="password-confirm" autocomplete="new-password" />
        </label>
        <div class="password-rules" data-testid="password-rules">
          <span v-for="rule in passwordStrengthRules" :key="rule.label" :class="{ passed: rule.ok }">{{ rule.label }}</span>
        </div>
        <p v-if="passwordMessage" class="form-message" data-testid="password-message">{{ passwordMessage }}</p>
        <div class="dialog-actions">
          <button type="button" data-testid="password-cancel" @click="closePasswordDialog">取消</button>
          <button class="primary-action" type="submit" data-testid="password-submit">保存</button>
        </div>
      </form>
    </div>

    <div v-if="pendingZeroEntrySave" class="modal-mask" data-testid="entry-zero-confirm-dialog">
      <div class="dialog entry-zero-confirm-dialog">
        <h3>零值分录确认</h3>
        <p>以下分录数量或单价为 0。若用于赠品、样品、补录等真实业务，可以确认后继续保存。</p>
        <table class="entry-zero-warning-table">
          <thead>
            <tr>
              <th>行号</th>
              <th>商品</th>
              <th>仓库</th>
              <th>数量</th>
              <th>单价</th>
              <th>原因</th>
              <th>业务说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="warning in pendingZeroEntrySave.warnings" :key="warning.lineNo">
              <td>第 {{ warning.lineNo }} 行</td>
              <td>{{ warning.productCode }}</td>
              <td>{{ warning.warehouseCode }}</td>
              <td>{{ formatQty(warning.qty) }}</td>
              <td>{{ formatAmount(warning.unitPrice) }}</td>
              <td>{{ warning.reasons.join("、") }}</td>
              <td>
                <select v-model="warning.reason" :data-testid="zeroReasonTestId(warning.lineNo)">
                  <option v-for="option in zeroReasonOptions" :key="option" :value="option">{{ option }}</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="dialog-actions">
          <button type="button" data-testid="entry-zero-cancel" @click="cancelZeroEntrySave">取消</button>
          <button class="primary-action" type="button" data-testid="entry-zero-confirm" @click="confirmZeroEntrySave">确认保存</button>
        </div>
      </div>
    </div>

    <div v-if="downstreamTrace" class="modal-mask" data-testid="downstream-trace-dialog">
      <div class="dialog downstream-trace-dialog">
        <h3>{{ downstreamTrace.title }}</h3>
        <p>源单第 {{ downstreamTrace.lineNo }} 行已执行 {{ downstreamTrace.executedQty }}，以下单据参与了该行执行。</p>
        <div class="downstream-impact-note" data-testid="downstream-impact-note">
          <strong>影响提示</strong>
          <span>反审核或红冲下游执行单据会回退源单行已执行数量，并重新计算源单执行状态；操作前请确认库存与后续单据链。</span>
        </div>
        <table class="downstream-trace-table">
          <thead>
            <tr>
              <th>单据类型</th>
              <th>单据编号</th>
              <th>日期</th>
              <th>状态</th>
              <th>源行</th>
              <th>下游行</th>
              <th>数量</th>
              <th>金额</th>
              <th>反审核影响</th>
              <th>红冲影响</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(doc, docIndex) in downstreamTrace.docs" :key="`${doc.type}-${doc.billNo}-${docIndex}`">
              <td>{{ doc.typeLabel || downstreamTypeLabel(doc.type) }}</td>
              <td>
                <button
                  class="downstream-doc-link"
                  type="button"
                  :data-testid="downstreamDocTestId(docIndex)"
                  @click="openDownstreamDocument(doc)"
                >
                  {{ doc.billNo }}
                </button>
              </td>
              <td>{{ doc.billDate || "-" }}</td>
              <td>{{ backendStatusLabel(doc.status) }}</td>
              <td>#{{ doc.sourceLineNo }}</td>
              <td>#{{ doc.downstreamLineNo }}</td>
              <td>{{ formatQty(doc.qty) }}</td>
              <td>{{ formatAmount(doc.amount) }}</td>
              <td class="impact-cell">{{ doc.reverseImpact || downstreamReverseImpact(doc) }}</td>
              <td class="impact-cell">{{ doc.redReverseImpact || downstreamRedReverseImpact(doc) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="dialog-actions">
          <button type="button" data-testid="downstream-trace-close" @click="downstreamTrace = null">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="pendingRiskyDocumentAction" class="modal-mask" data-testid="risky-action-dialog">
      <div class="dialog risky-action-dialog">
        <h3>{{ riskyActionTitle }}</h3>
        <p>{{ riskyActionSummary }}</p>
        <div class="downstream-impact-note">
          <strong>影响提示</strong>
          <span>{{ riskyActionImpact }}</span>
        </div>
        <dl class="risky-action-fields">
          <div>
            <dt>单据编号</dt>
            <dd>{{ currentOrderForm.billNo }}</dd>
          </div>
          <div>
            <dt>当前状态</dt>
            <dd>{{ currentOrderStatusLabel }}</dd>
          </div>
          <div v-if="pendingRiskyDocumentAction === 'redReverse'">
            <dt>红冲单号</dt>
            <dd>{{ redReverseBillNo }}</dd>
          </div>
        </dl>
        <div class="dialog-actions">
          <button type="button" data-testid="risky-action-cancel" @click="cancelRiskyDocumentAction">取消</button>
          <button class="primary-action" type="button" data-testid="risky-action-confirm" @click="confirmRiskyDocumentAction">确认{{ riskyActionVerb }}</button>
        </div>
      </div>
    </div>

    <div v-if="pendingEntryPaste" class="modal-mask" data-testid="entry-paste-conflict-dialog">
      <div ref="entryPasteDialogRef" class="dialog entry-paste-conflict-dialog" tabindex="-1" @keydown="handleEntryPasteConflictKeydown">
        <h3>选择商品</h3>
        <p>粘贴内容里有商品名称对应多个资料，请选定后再写入分录。</p>
        <div v-for="conflict in pendingEntryPaste.conflicts" :key="conflict.lineIndex" class="entry-paste-conflict">
          <div class="entry-paste-conflict-title">第 {{ conflict.lineIndex + 1 }} 行：{{ conflict.productText }}</div>
          <div class="entry-paste-candidates">
            <button
              v-for="(candidate, candidateIndex) in conflict.candidates"
              :key="candidate.code"
              type="button"
              class="entry-paste-candidate"
              :class="{ selected: conflict.selectedCode === candidate.code, active: isEntryPasteCandidateActive(conflict, candidateIndex) }"
              :data-testid="entryPasteCandidateTestId(conflict.lineIndex, candidate.code)"
              @click="selectEntryPasteCandidate(conflict.lineIndex, candidate.code)"
            >
              <strong>{{ candidate.code }}</strong>
              <span>{{ candidate.name }}</span>
              <span>{{ candidate.spec || "-" }}</span>
              <small>{{ candidate.unit || "" }}</small>
            </button>
          </div>
        </div>
        <div class="dialog-actions">
          <button type="button" data-testid="entry-paste-cancel" @click="cancelPendingEntryPaste">取消</button>
          <button type="button" data-testid="entry-paste-confirm" :disabled="!entryPasteConflictsResolved" @click="confirmPendingEntryPaste">确定</button>
        </div>
      </div>
    </div>

    <div v-if="pendingPushDown" class="modal-mask" data-testid="push-confirm-dialog">
      <div class="dialog push-confirm-dialog">
        <h3>{{ pendingPushDown.title }}</h3>
        <p>{{ pendingPushDown.sourceBillNo }} 可按剩余数量下推，确认本次数量后生成{{ pendingPushDown.targetTitle }}草稿。</p>
        <div class="push-confirm-tools">
          <button type="button" data-testid="push-confirm-clear" @click="clearPushDownQtys">清零</button>
          <button type="button" data-testid="push-confirm-all" @click="fillAllRemainingQtys">全剩余</button>
          <button type="button" data-testid="push-confirm-invert-selection" @click="invertPushDownSelection">反选</button>
          <label>
            比例
            <input v-model.number="pushConfirmRatio" inputmode="decimal" data-testid="push-confirm-ratio" />
            <span>%</span>
          </label>
          <button type="button" data-testid="push-confirm-apply-ratio" @click="applyPushDownRatio">按比例</button>
          <label>
            仓库
            <input v-model="pushConfirmWarehouseCode" data-testid="push-confirm-warehouse-code" />
          </label>
          <button type="button" data-testid="push-confirm-apply-warehouse" @click="applyPushDownWarehouse">应用仓库</button>
          <span class="push-confirm-selection" data-testid="push-confirm-selection-summary">{{ pushConfirmSelectionSummary }}</span>
        </div>
        <div class="push-confirm-table">
          <table>
            <thead>
              <tr>
                <th class="selection-cell">
                  <input
                    type="checkbox"
                    :checked="allPushDownLinesSelected"
                    data-testid="push-confirm-select-all"
                    @change="toggleAllPushDownLinesFromEvent"
                  />
                </th>
                <th>商品</th>
                <th>仓库</th>
                <th>源单</th>
                <th>已执行</th>
                <th>剩余</th>
                <th>本次</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(line, lineIndex) in pendingPushDown.lines" :key="`${line.productCode}-${lineIndex}`">
                <td class="selection-cell">
                  <input
                    v-model="line.selected"
                    type="checkbox"
                    :data-testid="pushConfirmSelectTestId(lineIndex)"
                  />
                </td>
                <td>
                  <strong>{{ line.productCode }}</strong>
                  <span>{{ line.productName || line.spec }}</span>
                </td>
                <td :data-testid="pushConfirmWarehouseTestId(lineIndex)">{{ line.warehouseCode }}</td>
                <td>{{ line.sourceQty }}</td>
                <td>{{ line.executedQty }}</td>
                <td>{{ line.remainingQty }}</td>
                <td>
                  <input
                    v-model.number="line.qty"
                    inputmode="decimal"
                    :data-testid="pushConfirmQtyTestId(lineIndex)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="push-confirm-summary">
          <span>本次数量合计</span>
          <strong data-testid="push-confirm-total">{{ pendingPushDownTotal }}</strong>
        </div>
        <p v-if="pushConfirmError" class="form-error" data-testid="push-confirm-error">{{ pushConfirmError }}</p>
        <div class="dialog-actions">
          <button type="button" data-testid="push-confirm-cancel" @click="cancelPushDown">取消</button>
          <button class="primary-action" type="button" data-testid="push-confirm-ok" @click="confirmPushDown">生成草稿</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { featureScope } from "./featureScope";
import DataListPage from "../components/DataListPage.vue";
import { auditDocument, exportDocument, fetchDocumentDetail, fetchPrintTemplates, printDocument, redReverseDocument, reverseDocument, saveDocumentDraft, savePrintTemplate, voidDocument, type DocumentDetail, type DocumentType, type DownstreamDocumentRef, type OpenableDocumentType, type OutputDocumentType, type PrintTemplateConfig } from "../services/documentApi";
import { fetchListRows } from "../services/listApi";
import { auditSalesOrder, deleteSalesOrder, fetchSalesOrderDetail, saveSalesOrderDraft } from "../services/salesOrderApi";
import { changeSystemPassword, createManagedUser, fetchManagedUsers, fetchRolePermissions, fetchSystemSession, fetchSystemUsers, loginSystemUser, logoutSystemUser, resetManagedUserPassword, saveRolePermissions, updateManagedUser, type ManagedRole, type ManagedUser, type PermissionCatalogItem, type RolePermissionMatrix, type SystemSession, type SystemUser } from "../services/systemApi";
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

interface EntryPasteRefs {
  products: MasterOption[];
  warehouses: MasterOption[];
}

interface EntryPasteConflict {
  lineIndex: number;
  productText: string;
  candidates: MasterOption[];
  selectedCode?: string;
  activeIndex?: number;
}

interface PendingEntryPaste {
  startIndex: number;
  lines: OrderLineForm[];
  conflicts: EntryPasteConflict[];
}

interface PreparedEntryLines {
  formLines: OrderLineForm[];
  documentLines: ReturnType<typeof toDocumentLines>;
  removedBlankCount: number;
}

interface ZeroEntryWarning {
  lineNo: number;
  productCode: string;
  warehouseCode: string;
  qty: number;
  unitPrice: number;
  reasons: string[];
  reason: string;
}

interface PendingZeroEntrySave {
  target: "salesOrder" | "document";
  warnings: ZeroEntryWarning[];
}

type RiskyDocumentAction = "reverse" | "redReverse";

interface OrderLineForm {
  lineNo?: number;
  productCode: string;
  productName?: string;
  spec?: string;
  warehouseCode: string;
  sourceLineNo?: number;
  qty: number;
  executedQty?: number;
  remainingQty?: number;
  unitPrice: number;
  lineRemark?: string;
  downstreamDocs?: DownstreamDocumentRef[];
}

interface DownstreamTraceState {
  title: string;
  lineNo: number;
  executedQty: string;
  docs: DownstreamDocumentRef[];
}

interface OrderForm {
  billNo: string;
  sourceOrderNo?: string;
  redReverseBillNo?: string;
  redSourceBillNo?: string;
  partyCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  status: "DRAFT" | "AUDITED" | "REVERSED" | "VOIDED" | "RED_REVERSED";
  lines: OrderLineForm[];
}

interface PendingPushLine extends OrderLineForm {
  sourceQty: number;
  executedQty: number;
  remainingQty: number;
  selected?: boolean;
}

interface PendingPushDown {
  kind: "salesOut" | "purchaseIn";
  title: string;
  targetTitle: string;
  targetTabId: string;
  targetModule: string;
  targetBillNo: string;
  sourceBillNo: string;
  partyCode: string;
  billDate: string;
  department: string;
  ownerName: string;
  lines: PendingPushLine[];
}

const session = useSessionStore();
const tabs = useTabStore();
const preferences = usePreferenceStore();
const keyword = ref("");
const activeModuleName = ref("销售管理");
const modulePanelOpen = ref(false);
const suppressNavigationUntil = ref(0);
const formMessage = ref("");
const batchWarehouseCode = ref("CK-001");
const draggingLineIndex = ref<number | null>(null);
const pendingPushDown = ref<PendingPushDown | null>(null);
const pushConfirmRatio = ref(50);
const pushConfirmWarehouseCode = ref("CK-001");
const pushConfirmError = ref("");
const entryPasteDialogRef = ref<HTMLElement | null>(null);
const zeroReasonOptions = ["赠品", "样品", "补录", "其他已确认"];
const printTemplateDocumentTypes = [
  { documentType: "sales-order", documentTitle: "销售订单" },
  { documentType: "purchase-order", documentTitle: "采购订单" },
  { documentType: "sales-out", documentTitle: "销售出库单" },
  { documentType: "purchase-in", documentTitle: "采购入库单" },
  { documentType: "material-issue", documentTitle: "生产领料单" },
  { documentType: "product-in", documentTitle: "产品入库单" }
];
const highlightedSourceBillNo = ref("");
const highlightedSourceLineNo = ref<number | null>(null);
const downstreamTrace = ref<DownstreamTraceState | null>(null);
const pendingEntryPaste = ref<PendingEntryPaste | null>(null);
const pendingZeroEntrySave = ref<PendingZeroEntrySave | null>(null);
const pendingRiskyDocumentAction = ref<RiskyDocumentAction | null>(null);
const printTemplates = ref<PrintTemplateConfig[]>([]);
const printTemplateMessage = ref("");
const rolePermissionMatrix = ref<RolePermissionMatrix | null>(null);
const selectedRoleCode = ref("ADMIN");
const rolePermissionDraft = ref<string[]>([]);
const rolePermissionMessage = ref("");
const managedUsers = ref<ManagedUser[]>([]);
const managedRoles = ref<ManagedRole[]>([]);
const selectedManagedUsername = ref("");
const userManagementMode = ref<"edit" | "create">("edit");
const userManagementMessage = ref("");
const managedUserPassword = ref("");
const managedUserForm = reactive({
  username: "",
  displayName: "",
  roleCode: "WAREHOUSE",
  enabled: true
});
const systemUsers = ref<SystemUser[]>([]);
const isAuthenticated = ref(false);
const loginForm = reactive({
  username: "admin",
  password: ""
});
const loginMessage = ref("");
const passwordDialogOpen = ref(false);
const passwordMessage = ref("");
const passwordForm = reactive({
  currentPassword: "",
  newPassword: "",
  confirmPassword: ""
});
const printTemplateForm = reactive<PrintTemplateConfig>({
  documentType: "sales-order",
  documentTitle: "销售订单",
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
});
const salesOrderForm = reactive<OrderForm>({
  billNo: "XSDD-00001",
  partyCode: "KH-001",
  billDate: "2026-06-23",
  department: "销售部",
  ownerName: "本地管理员",
  status: "DRAFT",
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
  status: "DRAFT",
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
  status: "DRAFT",
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
  status: "DRAFT",
  lines: [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 86 }
  ]
});
const materialIssueForm = reactive<OrderForm>({
  billNo: "SCLL-00001",
  sourceOrderNo: "SCRW-00001",
  partyCode: "SCRW-00001",
  billDate: "2026-06-23",
  department: "生产部",
  ownerName: "本地管理员",
  status: "AUDITED",
  lines: [
    { productCode: "WL-001", warehouseCode: "CK-001", qty: 2, unitPrice: 1 }
  ]
});
const productInForm = reactive<OrderForm>({
  billNo: "CPRK-00001",
  sourceOrderNo: "SCRW-00001",
  partyCode: "SCRW-00001",
  billDate: "2026-06-23",
  department: "生产部",
  ownerName: "本地管理员",
  status: "AUDITED",
  lines: [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 1 }
  ]
});
const activeSelector = ref("");
const selectorOptions = ref<MasterOption[]>([]);
const selectorCursorIndex = ref(0);
let selectorRequestSeq = 0;

const knownProductOptions: MasterOption[] = [
  { code: "CP-001", name: "控制臂总成", spec: "左前 / 黑色", unit: "只" },
  { code: "CP-T413874", name: "验收商品总成", spec: "左前 / 蓝色", unit: "只" },
  { code: "PJ-014", name: "衬套", spec: "65mm / 加强", unit: "件" }
];
const knownWarehouseOptions: MasterOption[] = [
  { code: "CK-001", name: "成品仓" },
  { code: "CK-002", name: "原材料仓" },
  { code: "CK-T413874", name: "验收仓" }
];

const moduleCatalog: ShellModule[] = [
  {
    name: "销售管理",
    short: "销",
    groups: [
      { title: "销售业务", entries: [
        { id: "sales-order-form", label: "销售订单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.order.audit" },
        { id: "sales-out-form", label: "销售出库单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.out.audit" },
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
        { id: "purchase-order-form", label: "采购订单", module: "采购管理", mode: "form", queryable: true, dirty: true, permission: "purchase.order.audit" },
        { id: "purchase-in-form", label: "采购入库单", module: "采购管理", mode: "form", queryable: true, dirty: true, permission: "purchase.in.audit" },
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
        { id: "inventory-query-list", label: "库存查询", module: "库存管理", mode: "report", queryable: true, permission: "inventory.stock.view" },
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
        { id: "receivable-list", label: "应收单", module: "应收应付", mode: "list", queryable: true, permission: "finance.report.view" },
        { id: "payable-list", label: "应付单", module: "应收应付", mode: "list", queryable: true, permission: "finance.report.view" }
      ] },
      { title: "往来报表", entries: [
        { id: "ar-summary-report", label: "应收汇总表", module: "应收应付", mode: "report", queryable: true, permission: "finance.report.view" }
      ] }
    ]
  },
  {
    name: "生产管理",
    short: "产",
    groups: [
      { title: "生产执行", entries: [
        { id: "production-task-form", label: "生产任务单", module: "生产管理", mode: "form", queryable: true, permission: "production.task.audit" },
        { id: "material-issue-form", label: "生产领料单", module: "生产管理", mode: "form", queryable: true, permission: "production.document.audit" },
        { id: "product-in-form", label: "产品入库单", module: "生产管理", mode: "form", queryable: true, permission: "production.document.audit" }
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
        { id: "product-master-list", label: "商品资料", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "customer-master-list", label: "客户", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "supplier-master-list", label: "供应商", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "warehouse-master-list", label: "仓库", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" }
      ] }
    ]
  },
  {
    name: "系统设置",
    short: "设",
    groups: [
      { title: "系统基础", entries: [
        { id: "coding-rule-list", label: "编码规则", module: "系统设置", mode: "list", queryable: true },
        { id: "user-role-list", label: "用户角色", module: "系统设置", mode: "shell", permission: "system.role_permission.manage" },
        { id: "role-permission-settings", label: "权限矩阵", module: "系统设置", mode: "shell", permission: "system.role_permission.manage" },
        { id: "operation-log-list", label: "操作日志", module: "系统设置", mode: "list", queryable: true, permission: "system.audit_log.view" },
        { id: "print-template-settings", label: "打印模板", module: "系统设置", mode: "shell", permission: "system.print_template.manage" }
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
const activeEntryGroups = computed(() => activeModule.value.groups
  .map((group) => ({ ...group, entries: group.entries.filter((entry) => canOpenEntry(entry)) }))
  .filter((group) => group.entries.length > 0));
const approvedCount = computed(() => featureScope.filter((feature) => feature.decision === "build" || feature.decision === "simple").length);
const quickEntries = computed(() => moduleCatalog.flatMap((module) => module.groups.flatMap((group) => group.entries)).filter((entry) => canOpenEntry(entry)).slice(0, 8));
const demoDirtyEntry = computed<ShellEntry>(() => ({ id: "sales-order-form", label: "销售订单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.order.audit" })).value;

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
const passwordStrengthRules = computed(() => [
  { label: "至少 8 位", ok: passwordForm.newPassword.length >= 8 },
  { label: "大写字母", ok: /[A-Z]/.test(passwordForm.newPassword) },
  { label: "小写字母", ok: /[a-z]/.test(passwordForm.newPassword) },
  { label: "数字", ok: /\d/.test(passwordForm.newPassword) },
  { label: "符号", ok: /[^A-Za-z0-9]/.test(passwordForm.newPassword) }
]);
const passwordStrengthOk = computed(() => passwordStrengthRules.value.every((rule) => rule.ok));
const selectedManagedUser = computed(() => managedUsers.value.find((user) => user.username === selectedManagedUsername.value) ?? null);
const selectedRole = computed(() => rolePermissionMatrix.value?.roles.find((role) => role.code === selectedRoleCode.value) ?? null);
const selectedRolePermissionCount = computed(() => rolePermissionDraft.value.length);
const permissionGroups = computed(() => {
  const grouped = new Map<string, PermissionCatalogItem[]>();
  for (const permission of rolePermissionMatrix.value?.permissions ?? []) {
    const group = grouped.get(permission.moduleName) ?? [];
    group.push(permission);
    grouped.set(permission.moduleName, group);
  }
  return Array.from(grouped.entries()).map(([moduleName, permissions]) => ({ moduleName, permissions }));
});

const isLockedList = computed(() => {
  return tabs.activeTab.value.id === "sales-order-form-list" && tabs.tabs.value.some((tab) => tab.id === "sales-order-form");
});
const isSalesOrderForm = computed(() => tabs.activeTab.value.id === "sales-order-form");
const isPurchaseOrderForm = computed(() => tabs.activeTab.value.id === "purchase-order-form");
const isPurchaseInForm = computed(() => tabs.activeTab.value.id === "purchase-in-form");
const isSalesOutForm = computed(() => tabs.activeTab.value.id === "sales-out-form");
const isMaterialIssueForm = computed(() => tabs.activeTab.value.id === "material-issue-form");
const isProductInForm = computed(() => tabs.activeTab.value.id === "product-in-form");
const isStockDocumentForm = computed(() => isPurchaseInForm.value || isSalesOutForm.value);
const isReversibleDocumentForm = computed(() => isPurchaseInForm.value || isSalesOutForm.value);
const isProductionDocumentForm = computed(() => isMaterialIssueForm.value || isProductInForm.value);
const isDocumentForm = computed(() => isSalesOrderForm.value || isPurchaseOrderForm.value || isPurchaseInForm.value || isSalesOutForm.value || isProductionDocumentForm.value);
const currentAuditPermission = computed(() => {
  if (isSalesOrderForm.value) return "sales.order.audit";
  if (isSalesOutForm.value) return "sales.out.audit";
  if (isPurchaseOrderForm.value) return "purchase.order.audit";
  if (isPurchaseInForm.value) return "purchase.in.audit";
  if (isProductionDocumentForm.value) return "production.document.audit";
  return "";
});
const showExecutionColumns = computed(() => (isSalesOrderForm.value || isPurchaseOrderForm.value) && currentOrderForm.value.lines.some((line) => line.executedQty !== undefined || line.remainingQty !== undefined));
const showSourceLineColumn = computed(() => isStockDocumentForm.value && Boolean(currentOrderForm.value.sourceOrderNo));
const entryTableColspan = computed(() => 9 + (showSourceLineColumn.value ? 1 : 0) + (showExecutionColumns.value ? 2 : 0));
const entryTotalColspan = computed(() => entryTableColspan.value - 1);
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
  if (isMaterialIssueForm.value) {
    return materialIssueForm;
  }
  if (isProductInForm.value) {
    return productInForm;
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
  if (isMaterialIssueForm.value) {
    return "material-issue";
  }
  if (isProductInForm.value) {
    return "product-in";
  }
  return "sales";
});
const partyLabel = computed(() => {
  if (isProductionDocumentForm.value) {
    return "来源";
  }
  return (isPurchaseOrderForm.value || isPurchaseInForm.value) ? "供应商" : "客户";
});
const partyType = computed(() => (isPurchaseOrderForm.value || isPurchaseInForm.value) ? "supplier" : "customer");
const isDraftDocument = computed(() => isDocumentForm.value && currentOrderForm.value.status === "DRAFT");
const canAuditCurrentDocument = computed(() => isDraftDocument.value && session.hasPermission(currentAuditPermission.value));
const entryPasteConflictsResolved = computed(() => Boolean(pendingEntryPaste.value?.conflicts.every((conflict) => conflict.selectedCode)));
const canReverseDocument = computed(() => isReversibleDocumentForm.value && currentOrderForm.value.status === "AUDITED");
const canVoidDocument = computed(() => isReversibleDocumentForm.value && currentOrderForm.value.status === "DRAFT");
const canDeleteSalesOrder = computed(() => isSalesOrderForm.value && currentOrderForm.value.status === "DRAFT");
const redReverseBillNo = computed(() => `HC-${currentOrderForm.value.billNo}`);
const riskyActionVerb = computed(() => pendingRiskyDocumentAction.value === "redReverse" ? "红冲" : "反审核");
const riskyActionTitle = computed(() => `${riskyActionVerb.value}确认`);
const riskyActionSummary = computed(() => {
  const typeLabel = isPurchaseInForm.value ? "采购入库单" : "销售出库单";
  return `即将${riskyActionVerb.value}${typeLabel} ${currentOrderForm.value.billNo}。`;
});
const riskyActionImpact = computed(() => {
  if (pendingRiskyDocumentAction.value === "redReverse") {
    return isPurchaseInForm.value
      ? "红冲将生成负数采购入库单，原单标记已红冲，并回退采购订单已入库数量、重算入库状态。"
      : "红冲将生成负数销售出库单，原单标记已红冲，并回退销售订单已出库数量、重算出库状态。";
  }
  return isPurchaseInForm.value
    ? "反审核将冲销采购入库库存流水，回退采购订单已入库数量，并重算入库状态。"
    : "反审核将冲销销售出库库存流水，回退销售订单已出库数量，并重算出库状态。";
});
const currentOrderStatusLabel = computed(() => {
  if (!isDocumentForm.value) {
    return "";
  }
  const labels: Record<OrderForm["status"], string> = {
    DRAFT: "草稿",
    AUDITED: "已审核",
    REVERSED: "已反审核",
    VOIDED: "已作废",
    RED_REVERSED: "已红冲"
  };
  return labels[currentOrderForm.value.status];
});
const formStatusByBackendStatus: Record<string, OrderForm["status"]> = {
  DRAFT: "DRAFT",
  AUDITED: "AUDITED",
  REVERSED: "REVERSED",
  VOID: "VOIDED",
  RED_REVERSED: "RED_REVERSED"
};
const currentOrderTotal = computed(() => currentOrderForm.value.lines
  .reduce((sum, line) => sum + Number(line.qty || 0) * Number(line.unitPrice || 0), 0)
  .toFixed(2));
const pendingPushDownTotal = computed(() => (pendingPushDown.value?.lines ?? [])
  .reduce((sum, line) => sum + normalizedQty(line.qty), 0)
  .toFixed(2));
const selectedPushDownLines = computed(() => (pendingPushDown.value?.lines ?? []).filter((line) => line.selected));
const effectivePushDownLines = computed(() => selectedPushDownLines.value.length > 0 ? selectedPushDownLines.value : pendingPushDown.value?.lines ?? []);
const allPushDownLinesSelected = computed(() => {
  const lines = pendingPushDown.value?.lines ?? [];
  return lines.length > 0 && lines.every((line) => line.selected);
});
const pushConfirmSelectionSummary = computed(() => {
  const selectedCount = selectedPushDownLines.value.length;
  return selectedCount > 0 ? `已选 ${selectedCount} 行，本次工具只调整选中行` : "未选行时工具调整全部行";
});
const sourceOrderTraceType = computed<OpenableDocumentType | null>(() => {
  if (isSalesOutForm.value) {
    return "salesOrder";
  }
  if (isPurchaseInForm.value) {
    return "purchaseOrder";
  }
  return null;
});
const canTraceSourceOrder = computed(() => Boolean(sourceOrderTraceType.value && currentOrderForm.value.sourceOrderNo?.trim()));

function lineAmount(line: OrderLineForm) {
  return (Number(line.qty || 0) * Number(line.unitPrice || 0)).toFixed(2);
}

function lineExecutedQty(line: OrderLineForm) {
  return formatQty(line.executedQty ?? 0);
}

function lineRemainingQty(line: OrderLineForm) {
  return formatQty(line.remainingQty ?? Math.max(0, Number(line.qty || 0) - Number(line.executedQty || 0)));
}

function lineSourceLineNo(line: OrderLineForm) {
  return line.sourceLineNo ? `#${line.sourceLineNo}` : "-";
}

function downstreamReverseImpact(doc: DownstreamDocumentRef) {
  const qty = formatQty(doc.qty);
  if (doc.type === "purchaseIn") {
    return `反审核将冲销采购入库库存流水，并回退源采购订单已入库数量 ${qty}。`;
  }
  return `反审核将冲销销售出库库存流水，并回退源销售订单已出库数量 ${qty}。`;
}

function downstreamRedReverseImpact(doc: DownstreamDocumentRef) {
  const qty = formatQty(doc.qty);
  if (doc.type === "purchaseIn") {
    return `红冲将生成负数采购入库单，并回退源采购订单已入库数量 ${qty}。`;
  }
  return `红冲将生成负数销售出库单，并回退源销售订单已出库数量 ${qty}。`;
}

function lineLineNo(line: OrderLineForm, index: number) {
  return line.lineNo ?? index + 1;
}

function isHighlightedSourceLine(line: OrderLineForm, index: number) {
  return Boolean(
    highlightedSourceLineNo.value
    && currentOrderForm.value.billNo === highlightedSourceBillNo.value
    && lineLineNo(line, index) === highlightedSourceLineNo.value
  );
}

function scrollHighlightedSourceLineIntoView() {
  if (!highlightedSourceLineNo.value) {
    return;
  }
  const target = document.querySelector<HTMLElement>(`.entry-table tr[data-line-no="${highlightedSourceLineNo.value}"]`);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function formatQty(value: number | string | undefined) {
  const qty = Number(value ?? 0);
  if (!Number.isFinite(qty)) {
    return "0";
  }
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}

function formatAmount(value: number | string | undefined) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function backendStatusLabel(status: string | undefined) {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    AUDITED: "已审核",
    REVERSED: "已反审核",
    VOID: "已作废",
    VOIDED: "已作废",
    RED_REVERSED: "已红冲"
  };
  return labels[status ?? ""] ?? status ?? "-";
}

function downstreamTypeLabel(type: OpenableDocumentType) {
  return openableDocumentTarget(type).title;
}

function productInfo(line: OrderLineForm) {
  if (line.productName || line.spec) {
    return { name: line.productName ?? "", spec: line.spec ?? "", unit: "" };
  }
  const product = selectorOptions.value.find((option) => option.code === line.productCode);
  if (product) {
    return { name: product.name, spec: product.spec ?? "", unit: product.unit ?? "" };
  }
  const knownProduct = knownProductOptions.find((option) => option.code === line.productCode);
  if (knownProduct) {
    return { name: knownProduct.name, spec: knownProduct.spec ?? "", unit: knownProduct.unit ?? "" };
  }
  return { name: "", spec: "", unit: "" };
}

function lineProductTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-product` : `${formTestPrefix.value}-line-product-${index + 1}`;
}

function lineWarehouseTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-warehouse` : `${formTestPrefix.value}-line-warehouse-${index + 1}`;
}

function lineQtyTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-qty` : `${formTestPrefix.value}-line-qty-${index + 1}`;
}

function lineSourceLineNoTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-source-line-no` : `${formTestPrefix.value}-line-source-line-no-${index + 1}`;
}

function lineSourceTraceTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-source-trace` : `${formTestPrefix.value}-line-source-trace-${index + 1}`;
}

function lineDownstreamTraceTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-downstream-trace` : `${formTestPrefix.value}-line-downstream-trace-${index + 1}`;
}

function downstreamDocTestId(index: number) {
  return index === 0 ? "downstream-doc-open" : `downstream-doc-open-${index + 1}`;
}

function entryPasteCandidateTestId(lineIndex: number, code: string) {
  return `entry-paste-candidate-${lineIndex + 1}-${code}`;
}

function lineExecutedQtyTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-executed-qty` : `${formTestPrefix.value}-line-executed-qty-${index + 1}`;
}

function lineRemainingQtyTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-remaining-qty` : `${formTestPrefix.value}-line-remaining-qty-${index + 1}`;
}

function linePriceTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-price` : `${formTestPrefix.value}-line-price-${index + 1}`;
}

function lineAmountTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-amount` : `${formTestPrefix.value}-line-amount-${index + 1}`;
}

function lineRemarkTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-remark` : `${formTestPrefix.value}-line-remark-${index + 1}`;
}

function zeroReasonTestId(lineNo: number) {
  return lineNo === 1 ? "entry-zero-reason" : `entry-zero-reason-${lineNo}`;
}

function lineDeleteTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-delete` : `${formTestPrefix.value}-line-delete-${index + 1}`;
}

function lineInsertTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-insert` : `${formTestPrefix.value}-line-insert-${index + 1}`;
}

function lineCopyTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-copy` : `${formTestPrefix.value}-line-copy-${index + 1}`;
}

function lineDragHandleTestId(index: number) {
  return index === 0 ? `${formTestPrefix.value}-line-drag` : `${formTestPrefix.value}-line-drag-${index + 1}`;
}

onMounted(async () => {
  installSessionExpiryInterceptor();
  window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  systemUsers.value = await fetchSystemUsers();
  const remoteSession = await fetchSystemSession();
  if (remoteSession?.authenticated && remoteSession.user) {
    applySystemSession(remoteSession);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
});

function applySystemSession(remoteSession: SystemSession) {
  if (!remoteSession.user) {
    return;
  }
  session.userName.value = remoteSession.user.name;
  session.userRole.value = remoteSession.user.role;
  session.userRoleCode.value = remoteSession.user.roleCode || "";
  session.permissionCodes.value = remoteSession.user.permissionCodes ?? [];
  session.tenantName.value = remoteSession.tenant.name;
  session.accountingPeriod.value = remoteSession.period.accounting;
  session.businessPeriod.value = remoteSession.period.business;
  loginForm.username = remoteSession.user.username || loginForm.username;
  isAuthenticated.value = true;
  loginMessage.value = "";
}

async function loginCurrentUser() {
  loginMessage.value = "";
  const remoteSession = await loginSystemUser(loginForm.username, loginForm.password);
  if (!remoteSession?.authenticated || !remoteSession.user) {
    loginMessage.value = "账号或密码不正确";
    return;
  }
  applySystemSession(remoteSession);
  loginForm.password = "";
  if (tabs.activeTab.value.id === "role-permission-settings") {
    await loadRolePermissions();
  }
}

async function logoutCurrentUser() {
  await logoutSystemUser();
  clearLocalSession("");
}

function clearLocalSession(message: string) {
  isAuthenticated.value = false;
  session.userName.value = "";
  session.userRole.value = "";
  session.userRoleCode.value = "";
  session.permissionCodes.value = [];
  loginForm.password = "";
  loginMessage.value = message;
  passwordDialogOpen.value = false;
  resetPasswordForm();
  tabs.activeTabId.value = "home";
}

function openPasswordDialog() {
  resetPasswordForm();
  passwordDialogOpen.value = true;
}

function closePasswordDialog() {
  passwordDialogOpen.value = false;
  resetPasswordForm();
}

function resetPasswordForm() {
  passwordForm.currentPassword = "";
  passwordForm.newPassword = "";
  passwordForm.confirmPassword = "";
  passwordMessage.value = "";
}

async function submitPasswordChange() {
  passwordMessage.value = "";
  if (!passwordStrengthOk.value) {
    passwordMessage.value = "新密码需满足全部强度要求。";
    return;
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    passwordMessage.value = "两次输入的新密码不一致。";
    return;
  }
  const result = await changeSystemPassword({
    currentPassword: passwordForm.currentPassword,
    newPassword: passwordForm.newPassword
  });
  if (!result.ok) {
    passwordMessage.value = result.message || "密码修改失败。";
    return;
  }
  closePasswordDialog();
  await logoutSystemUser();
  clearLocalSession("密码已修改，请使用新密码重新登录。");
}

function handleSessionExpired() {
  clearLocalSession("登录已过期，请重新登录。");
}

const SESSION_EXPIRED_EVENT = "jdy:session-expired";
const publicSessionPaths = new Set(["/api/system/health", "/api/system/session", "/api/system/users", "/api/system/login", "/api/system/logout"]);

function installSessionExpiryInterceptor() {
  const runtimeWindow = window as Window & { __jdyFetchWrapped?: boolean; __jdyOriginalFetch?: typeof window.fetch };
  if (runtimeWindow.__jdyFetchWrapped) {
    return;
  }
  runtimeWindow.__jdyFetchWrapped = true;
  runtimeWindow.__jdyOriginalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await runtimeWindow.__jdyOriginalFetch!(input, init);
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (response.status === 401 && url.pathname.startsWith("/api/") && !publicSessionPaths.has(url.pathname)) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    return response;
  };
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
  activeModuleName.value = entry.module;
  const isQuery = entry.mode === "list" || entry.mode === "report";
  const id = entry.mode === "list" && !entry.id.endsWith("-list") ? `${entry.id}-list` : entry.id;
  const opened = tabs.openTab({
    id,
    title: isQuery && !entry.label.includes("表") && !entry.label.includes("查询") ? `${entry.label}列表` : entry.label,
    module: entry.module,
    kind: entry.mode,
    dirty: entry.mode === "form" ? entry.dirty : false
  });
  if (opened && entry.mode === "form") {
    startNewCurrentDocument();
  }
  if (opened && entry.id === "print-template-settings") {
    void loadPrintTemplates();
  }
  if (opened && entry.id === "role-permission-settings") {
    void loadRolePermissions();
  }
  if (opened && entry.id === "user-role-list") {
    void loadManagedUsers();
  }
  modulePanelOpen.value = false;
  suppressNavigationUntil.value = Date.now() + 250;
}

function canOpenEntry(entry: ShellEntry) {
  return session.hasPermission(entry.permission);
}

async function loadManagedUsers() {
  const result = await fetchManagedUsers();
  if (!result.ok || !result.data) {
    userManagementMessage.value = result.message;
    return;
  }
  managedUsers.value = result.data.users;
  managedRoles.value = result.data.roles;
  if (userManagementMode.value !== "create" && !managedUsers.value.some((user) => user.username === selectedManagedUsername.value)) {
    selectedManagedUsername.value = managedUsers.value[0]?.username ?? "";
  }
  if (selectedManagedUsername.value) {
    applySelectedManagedUser();
  }
  userManagementMessage.value = "";
}

function selectManagedUser(username: string) {
  selectedManagedUsername.value = username;
  userManagementMode.value = "edit";
  applySelectedManagedUser();
  userManagementMessage.value = "";
}

function applySelectedManagedUser() {
  const user = selectedManagedUser.value;
  if (!user) {
    return;
  }
  managedUserForm.username = user.username;
  managedUserForm.displayName = user.displayName;
  managedUserForm.roleCode = user.roleCode;
  managedUserForm.enabled = user.enabled;
  managedUserPassword.value = "";
}

function startCreateManagedUser() {
  userManagementMode.value = "create";
  selectedManagedUsername.value = "";
  managedUserForm.username = "";
  managedUserForm.displayName = "";
  managedUserForm.roleCode = managedRoles.value.find((role) => role.code === "WAREHOUSE")?.code ?? managedRoles.value[0]?.code ?? "";
  managedUserForm.enabled = true;
  managedUserPassword.value = "";
  userManagementMessage.value = "";
}

async function saveManagedUser() {
  if (!canManageRolePermissions.value) {
    userManagementMessage.value = "当前角色无权维护用户。";
    return;
  }
  const result = userManagementMode.value === "create"
    ? await createManagedUser({ ...managedUserForm, password: managedUserPassword.value })
    : await updateManagedUser(managedUserForm.username, {
      displayName: managedUserForm.displayName,
      roleCode: managedUserForm.roleCode,
      enabled: managedUserForm.enabled
    });
  if (!result.ok || !result.data) {
    userManagementMessage.value = result.message || "用户保存失败。";
    return;
  }
  managedUsers.value = result.data.users;
  managedRoles.value = result.data.roles;
  selectedManagedUsername.value = managedUserForm.username;
  userManagementMode.value = "edit";
  applySelectedManagedUser();
  systemUsers.value = await fetchSystemUsers();
  userManagementMessage.value = "用户已保存";
}

async function resetManagedUserPasswordAction() {
  if (!canManageRolePermissions.value || userManagementMode.value === "create") {
    return;
  }
  const result = await resetManagedUserPassword(managedUserForm.username, managedUserPassword.value);
  if (!result.ok) {
    userManagementMessage.value = result.message || "密码重置失败。";
    return;
  }
  managedUserPassword.value = "";
  userManagementMessage.value = "密码已重置";
}

async function loadRolePermissions() {
  const result = await fetchRolePermissions();
  if (!result.ok || !result.data) {
    rolePermissionMessage.value = result.message;
    return;
  }
  rolePermissionMatrix.value = result.data;
  if (!result.data.roles.some((role) => role.code === selectedRoleCode.value)) {
    selectedRoleCode.value = result.data.roles[0]?.code ?? "";
  }
  applySelectedRolePermissions();
  rolePermissionMessage.value = "";
}

function selectRolePermissionRole(roleCode: string) {
  selectedRoleCode.value = roleCode;
  applySelectedRolePermissions();
  rolePermissionMessage.value = "";
}

function applySelectedRolePermissions() {
  rolePermissionDraft.value = [...(selectedRole.value?.permissionCodes ?? [])];
}

function rolePermissionChecked(permissionCode: string) {
  return rolePermissionDraft.value.includes(permissionCode);
}

function toggleRolePermission(permissionCode: string, checked: boolean) {
  const current = new Set(rolePermissionDraft.value);
  if (checked) {
    current.add(permissionCode);
  } else {
    current.delete(permissionCode);
  }
  rolePermissionDraft.value = Array.from(current);
}

async function saveSelectedRolePermissions() {
  if (!canManageRolePermissions.value) {
    rolePermissionMessage.value = "当前角色无权维护权限矩阵。";
    return;
  }
  if (!selectedRoleCode.value) {
    rolePermissionMessage.value = "请先选择角色。";
    return;
  }
  const result = await saveRolePermissions(selectedRoleCode.value, rolePermissionDraft.value);
  if (!result.ok || !result.data) {
    rolePermissionMessage.value = result.message || "权限保存失败。";
    return;
  }
  rolePermissionMatrix.value = result.data;
  applySelectedRolePermissions();
  rolePermissionMessage.value = "权限矩阵已保存";
}

async function loadPrintTemplates() {
  const result = await fetchPrintTemplates();
  if (!result.ok) {
    printTemplateMessage.value = result.message;
    return;
  }
  printTemplates.value = result.data;
  const current = preferredPrintTemplate(result.data.filter((template) => template.documentType === printTemplateForm.documentType)) ?? result.data[0];
  if (current) {
    applyPrintTemplateToForm(current);
  }
  printTemplateMessage.value = "";
}

function selectPrintTemplate(documentType: string, templateCode?: string) {
  const template = printTemplates.value.find((item) => item.documentType === documentType && item.templateCode === templateCode)
    ?? preferredPrintTemplate(printTemplates.value.filter((item) => item.documentType === documentType))
    ?? printTemplates.value.find((item) => item.documentType === documentType);
  if (template) {
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
  printTemplateForm.enabled = template.enabled;
}

async function saveActivePrintTemplate() {
  if (!canManagePrintTemplates.value) {
    printTemplateMessage.value = "当前角色无权维护打印模板。";
    return;
  }
  const result = await savePrintTemplate(printTemplateForm.documentType, {
    templateCode: printTemplateForm.templateCode,
    templateName: printTemplateForm.templateName,
    roleCode: printTemplateForm.roleCode,
    companyName: printTemplateForm.companyName,
    headerNote: printTemplateForm.headerNote,
    footerNote: printTemplateForm.footerNote,
    showSignature: printTemplateForm.showSignature,
    showSeal: printTemplateForm.showSeal,
    isDefault: printTemplateForm.isDefault
  });
  if (!result.ok || !result.data) {
    printTemplateMessage.value = result.message || "打印模板保存失败。";
    return;
  }
  applyPrintTemplateToForm(result.data);
  upsertPrintTemplate(result.data);
  printTemplateMessage.value = "打印模板已保存";
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
    isDefault: false
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

async function saveCurrentSalesOrder() {
  await saveCurrentSalesOrderDraft(false);
}

async function saveCurrentSalesOrderDraft(allowZeroValues: boolean) {
  if (!allowZeroValues) {
    pendingZeroEntrySave.value = null;
  }
  formMessage.value = "";
  const preparedLines = prepareEntryLinesForSave(salesOrderForm.lines);
  if (!preparedLines.ok) {
    formMessage.value = preparedLines.message;
    return;
  }
  const zeroWarnings = zeroEntryWarnings(preparedLines.formLines);
  if (!allowZeroValues && zeroWarnings.length > 0) {
    pendingZeroEntrySave.value = { target: "salesOrder", warnings: zeroWarnings };
    return;
  }
  salesOrderForm.lines = preparedLines.formLines;
  const result = await saveSalesOrderDraft({
    billNo: salesOrderForm.billNo,
    customerCode: salesOrderForm.partyCode,
    billDate: salesOrderForm.billDate,
    department: salesOrderForm.department,
    ownerName: salesOrderForm.ownerName,
    lines: preparedLines.documentLines
  });
  formMessage.value = result.ok ? saveSuccessMessage(preparedLines.removedBlankCount, allowZeroValues ? zeroWarnings.length : 0) : result.message;
  if (result.ok) {
    salesOrderForm.status = "DRAFT";
    const activeTab = tabs.tabs.value.find((tab) => tab.id === tabs.activeTabId.value);
    if (activeTab) {
      activeTab.dirty = false;
    }
  }
}

async function openDocumentFromList(payload: { type: OpenableDocumentType; row: Record<string, unknown> }) {
  const billNo = String(payload.row.billNo ?? "");
  if (!billNo) {
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
  activeModuleName.value = target.module;
  fillDocumentForm(target.form, result.data, target.partyType);
  formMessage.value = `已打开${target.title} ${billNo}`;
  clearActiveDirty();
}

async function traceSourceOrder(sourceLineNo?: number) {
  const billNo = currentOrderForm.value.sourceOrderNo?.trim();
  const type = sourceOrderTraceType.value;
  if (!billNo || !type) {
    return;
  }
  const targetLineNo = sourceLineNo ?? currentOrderForm.value.lines.find((line) => line.sourceLineNo)?.sourceLineNo ?? null;
  const result = await fetchDocumentDetail(type, billNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "源单详情加载失败。";
    return;
  }
  const target = openableDocumentTarget(type);
  tabs.openTab({
    id: target.tabId,
    title: target.title,
    module: target.module,
    kind: "form",
    dirty: false,
    lockedObjectId: billNo
  });
  activeModuleName.value = target.module;
  fillDocumentForm(target.form, result.data, target.partyType);
  highlightedSourceBillNo.value = billNo;
  highlightedSourceLineNo.value = targetLineNo;
  await nextTick();
  scrollHighlightedSourceLineIntoView();
  formMessage.value = targetLineNo ? `已追踪打开${target.title} ${billNo}，定位到第 ${targetLineNo} 行` : `已追踪打开${target.title} ${billNo}`;
  clearActiveDirty();
}

function openDownstreamTrace(line: OrderLineForm, index: number) {
  if (!line.downstreamDocs?.length) {
    return;
  }
  downstreamTrace.value = {
    title: `${currentOrderForm.value.billNo} 第 ${lineLineNo(line, index)} 行执行单据`,
    lineNo: lineLineNo(line, index),
    executedQty: lineExecutedQty(line),
    docs: line.downstreamDocs
  };
}

async function openDownstreamDocument(doc: DownstreamDocumentRef) {
  if (!doc.billNo || !doc.type) {
    return;
  }
  const result = await fetchDocumentDetail(doc.type, doc.billNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "下游单据详情加载失败。";
    return;
  }
  const target = openableDocumentTarget(doc.type);
  tabs.openTab({
    id: target.tabId,
    title: target.title,
    module: target.module,
    kind: "form",
    dirty: false,
    lockedObjectId: doc.billNo
  });
  activeModuleName.value = target.module;
  fillDocumentForm(target.form, result.data, target.partyType);
  downstreamTrace.value = null;
  formMessage.value = `已打开${target.title} ${doc.billNo}`;
  clearActiveDirty();
}

async function openRedReverseBill() {
  const type = currentDocumentType();
  const billNo = currentOrderForm.value.redReverseBillNo?.trim();
  if (!type || !billNo) {
    return;
  }
  const result = await fetchDocumentDetail(type, billNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "红字单详情加载失败。";
    return;
  }
  fillDocumentForm(currentOrderForm.value, result.data, partyType.value);
  formMessage.value = `已打开红字单 ${billNo}`;
  clearActiveDirty();
}

async function openRedSourceBill() {
  const type = currentDocumentType();
  const billNo = currentOrderForm.value.redSourceBillNo?.trim();
  if (!type || !billNo) {
    return;
  }
  const result = await fetchDocumentDetail(type, billNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "来源原单详情加载失败。";
    return;
  }
  fillDocumentForm(currentOrderForm.value, result.data, partyType.value);
  formMessage.value = `已打开来源原单 ${billNo}`;
  clearActiveDirty();
}

function openableDocumentTarget(type: OpenableDocumentType): { tabId: string; title: string; module: string; form: OrderForm; partyType: "customer" | "supplier" } {
  switch (type) {
    case "salesOut":
      return { tabId: "sales-out-form", title: "销售出库单", module: "销售管理", form: salesOutForm, partyType: "customer" };
    case "purchaseOrder":
      return { tabId: "purchase-order-form", title: "采购订单", module: "采购管理", form: purchaseOrderForm, partyType: "supplier" };
    case "purchaseIn":
      return { tabId: "purchase-in-form", title: "采购入库单", module: "采购管理", form: purchaseInForm, partyType: "supplier" };
    case "materialIssue":
      return { tabId: "material-issue-form", title: "生产领料单", module: "生产管理", form: materialIssueForm, partyType: "customer" };
    case "productIn":
      return { tabId: "product-in-form", title: "产品入库单", module: "生产管理", form: productInForm, partyType: "customer" };
    case "salesOrder":
    default:
      return { tabId: "sales-order-form", title: "销售订单", module: "销售管理", form: salesOrderForm, partyType: "customer" };
  }
}

function fillDocumentForm(form: OrderForm, detail: DocumentDetail, partyKind: "customer" | "supplier") {
  const document = detail.document;
  form.billNo = document.billNo;
  form.sourceOrderNo = document.sourceOrderNo || undefined;
  form.redReverseBillNo = document.redReverseBillNo || undefined;
  form.redSourceBillNo = document.redSourceBillNo || undefined;
  form.partyCode = document.sourceOrderNo && (document.customerCode === "SC" || document.supplierCode === "SC")
    ? document.sourceOrderNo
    : partyKind === "supplier"
    ? document.supplierCode || "GYS-001"
    : document.customerCode || "KH-001";
  form.billDate = document.billDate;
  form.department = document.department || (partyKind === "supplier" ? "采购部" : "销售部");
  form.ownerName = document.ownerName || "本地管理员";
  form.status = formStatusByBackendStatus[document.status] ?? "DRAFT";
  form.lines = detail.lines.length
    ? detail.lines.map((line) => ({
      productCode: String(line.productCode ?? ""),
      productName: String(line.productName ?? ""),
      spec: String(line.spec ?? ""),
      warehouseCode: String(line.warehouseCode ?? "CK-001"),
      lineNo: normalizedOptionalInt(line.lineNo),
      sourceLineNo: normalizedOptionalInt(line.sourceLineNo),
      qty: Number(line.qty ?? 0),
      executedQty: documentLineExecutedQty(line),
      remainingQty: line.remainingQty === undefined ? undefined : normalizedQty(line.remainingQty),
      unitPrice: Number(line.unitPrice ?? 0),
      lineRemark: String(line.lineRemark ?? ""),
      downstreamDocs: normalizeDownstreamDocs(line.downstreamDocs)
    }))
    : [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 0, lineRemark: "" }];
}

function normalizeDownstreamDocs(docs: DownstreamDocumentRef[] | undefined) {
  if (!Array.isArray(docs)) {
    return [];
  }
  return docs
    .map((doc) => ({
      billNo: String(doc.billNo ?? ""),
      type: doc.type,
      typeLabel: doc.typeLabel ? String(doc.typeLabel) : undefined,
      status: doc.status ? String(doc.status) : undefined,
      billDate: doc.billDate ? String(doc.billDate) : undefined,
      sourceLineNo: doc.sourceLineNo,
      downstreamLineNo: doc.downstreamLineNo,
      qty: doc.qty,
      amount: doc.amount,
      riskLevel: doc.riskLevel ? String(doc.riskLevel) : undefined,
      reverseImpact: doc.reverseImpact ? String(doc.reverseImpact) : undefined,
      redReverseImpact: doc.redReverseImpact ? String(doc.redReverseImpact) : undefined
    }))
    .filter((doc) => doc.billNo && doc.type);
}

function documentLineExecutedQty(line: { shippedQty?: number | string; receivedQty?: number | string }) {
  if (line.shippedQty !== undefined) {
    return normalizedQty(line.shippedQty);
  }
  if (line.receivedQty !== undefined) {
    return normalizedQty(line.receivedQty);
  }
  return undefined;
}

async function openSalesOutFromSalesOrder(row: Record<string, unknown>) {
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
  const lines = result.data.lines.map((line) => toPendingPushLine(line, "shippedQty")).filter((line) => line.remainingQty > 0);
  if (lines.length === 0) {
    formMessage.value = `销售订单 ${sourceBillNo} 已无剩余可出数量`;
    return;
  }
  pendingPushDown.value = {
    kind: "salesOut",
    title: "销售出库下推确认",
    targetTitle: "销售出库单",
    targetTabId: "sales-out-form",
    targetModule: "销售管理",
    targetBillNo: nextBillNoFor("XSCK"),
    sourceBillNo,
    partyCode: result.data.order.customerCode || "KH-001",
    billDate: dateText,
    department: result.data.order.department || "销售部",
    ownerName: session.userName.value || result.data.order.ownerName || "本地管理员",
    lines
  };
  pushConfirmError.value = "";
  pushConfirmRatio.value = 50;
  pushConfirmWarehouseCode.value = lines[0]?.warehouseCode ?? "CK-001";
  formMessage.value = `请确认销售订单 ${sourceBillNo} 本次下推数量`;
}

function confirmPushDown() {
  const pending = pendingPushDown.value;
  if (!pending) {
    return;
  }
  const selectedLines = pending.lines
    .map((line) => ({ ...line, qty: normalizedQty(line.qty) }))
    .filter((line) => line.qty > 0);
  const invalidLine = pending.lines.find((line) => normalizedQty(line.qty) < 0 || normalizedQty(line.qty) > line.remainingQty);
  if (invalidLine) {
    pushConfirmError.value = "本次下推数量不能小于 0，也不能超过剩余数量。";
    return;
  }
  if (selectedLines.length === 0) {
    pushConfirmError.value = "至少保留一行本次数量大于 0 的明细。";
    return;
  }
  const targetForm = pending.kind === "salesOut" ? salesOutForm : purchaseInForm;
  tabs.openTab({
    id: pending.targetTabId,
    title: pending.targetTitle,
    module: pending.targetModule,
    kind: "form",
    dirty: true
  });
  activeModuleName.value = pending.targetModule;
  targetForm.billNo = pending.targetBillNo;
  targetForm.sourceOrderNo = pending.sourceBillNo;
  targetForm.redReverseBillNo = undefined;
  targetForm.redSourceBillNo = undefined;
  targetForm.partyCode = pending.partyCode;
  targetForm.billDate = pending.billDate;
  targetForm.department = pending.department;
  targetForm.ownerName = pending.ownerName;
  targetForm.status = "DRAFT";
  targetForm.lines = selectedLines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    productName: String(line.productName ?? ""),
    spec: String(line.spec ?? ""),
    warehouseCode: String(line.warehouseCode ?? "CK-001"),
    sourceLineNo: line.sourceLineNo,
    qty: line.qty,
    unitPrice: Number(line.unitPrice ?? 0),
    lineRemark: String(line.lineRemark ?? "")
  }));
  pendingPushDown.value = null;
  pushConfirmError.value = "";
  formMessage.value = `已由${pending.sourceBillNo}按确认数量生成${pending.targetTitle}草稿`;
}

function cancelPushDown() {
  pendingPushDown.value = null;
  pushConfirmError.value = "";
  formMessage.value = "已取消下推。";
}

function clearPushDownQtys() {
  if (!pendingPushDown.value) {
    return;
  }
  effectivePushDownLines.value.forEach((line) => {
    line.qty = 0;
  });
  pushConfirmError.value = "";
}

function fillAllRemainingQtys() {
  if (!pendingPushDown.value) {
    return;
  }
  effectivePushDownLines.value.forEach((line) => {
    line.qty = line.remainingQty;
  });
  pushConfirmError.value = "";
}

function toggleAllPushDownLinesFromEvent(event: Event) {
  toggleAllPushDownLines((event.target as HTMLInputElement).checked);
}

function toggleAllPushDownLines(selected: boolean) {
  if (!pendingPushDown.value) {
    return;
  }
  pendingPushDown.value.lines.forEach((line) => {
    line.selected = selected;
  });
}

function invertPushDownSelection() {
  if (!pendingPushDown.value) {
    return;
  }
  pendingPushDown.value.lines.forEach((line) => {
    line.selected = !line.selected;
  });
}

function applyPushDownRatio() {
  if (!pendingPushDown.value) {
    return;
  }
  const ratio = normalizedQty(pushConfirmRatio.value);
  if (ratio < 0 || ratio > 100) {
    pushConfirmError.value = "下推比例必须在 0 到 100 之间。";
    return;
  }
  effectivePushDownLines.value.forEach((line) => {
    line.qty = roundQty(line.remainingQty * ratio / 100);
  });
  pushConfirmError.value = "";
}

function applyPushDownWarehouse() {
  if (!pendingPushDown.value) {
    return;
  }
  const warehouseCode = pushConfirmWarehouseCode.value.trim();
  if (!warehouseCode) {
    pushConfirmError.value = "仓库编码不能为空。";
    return;
  }
  effectivePushDownLines.value.forEach((line) => {
    line.warehouseCode = warehouseCode;
  });
  pushConfirmError.value = "";
}

async function openPurchaseInFromPurchaseOrder(row: Record<string, unknown>) {
  const sourceBillNo = String(row.billNo ?? "");
  if (!sourceBillNo) {
    return;
  }
  const result = await fetchDocumentDetail("purchaseOrder", sourceBillNo);
  if (!result.ok || !result.data) {
    formMessage.value = result.message || "采购订单详情加载失败。";
    return;
  }
  const today = new Date();
  const dateText = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  const lines = result.data.lines.map((line) => toPendingPushLine(line, "receivedQty")).filter((line) => line.remainingQty > 0);
  if (lines.length === 0) {
    formMessage.value = `采购订单 ${sourceBillNo} 已无剩余可入数量`;
    return;
  }
  pendingPushDown.value = {
    kind: "purchaseIn",
    title: "采购入库下推确认",
    targetTitle: "采购入库单",
    targetTabId: "purchase-in-form",
    targetModule: "采购管理",
    targetBillNo: nextBillNoFor("CGRK"),
    sourceBillNo,
    partyCode: result.data.document.supplierCode || "GYS-001",
    billDate: dateText,
    department: result.data.document.department || "采购部",
    ownerName: session.userName.value || result.data.document.ownerName || "本地管理员",
    lines
  };
  pushConfirmError.value = "";
  pushConfirmRatio.value = 50;
  pushConfirmWarehouseCode.value = lines[0]?.warehouseCode ?? "CK-001";
  formMessage.value = `请确认采购订单 ${sourceBillNo} 本次下推数量`;
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

function roundQty(value: number) {
  return Math.round(value * 100) / 100;
}

function toPendingPushLine(line: { lineNo?: number | string; productCode?: string; productName?: string; spec?: string; warehouseCode?: string; qty?: number | string; unitPrice?: number | string; shippedQty?: number | string; receivedQty?: number | string; remainingQty?: number | string }, executedField: "shippedQty" | "receivedQty"): PendingPushLine {
  const sourceQty = normalizedQty(line.qty);
  const executedQty = normalizedQty(line[executedField]);
  const remainingQty = remainingLineQty(line);
  return {
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
    unitPrice: Number(line.unitPrice ?? 0)
  };
}

function pushConfirmQtyTestId(index: number) {
  return index === 0 ? "push-confirm-qty" : `push-confirm-qty-${index + 1}`;
}

function pushConfirmWarehouseTestId(index: number) {
  return index === 0 ? "push-confirm-warehouse" : `push-confirm-warehouse-${index + 1}`;
}

function pushConfirmSelectTestId(index: number) {
  return index === 0 ? "push-confirm-select" : `push-confirm-select-${index + 1}`;
}

function startNewCurrentDocument() {
  if (!isDocumentForm.value) {
    return;
  }
  const form = currentOrderForm.value;
  const today = new Date();
  const dateText = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  form.billDate = dateText;
  form.billNo = nextBillNo();
  form.sourceOrderNo = isStockDocumentForm.value ? "" : undefined;
  form.redReverseBillNo = undefined;
  form.redSourceBillNo = undefined;
  form.partyCode = partyType.value === "supplier" ? "GYS-001" : "KH-001";
  form.department = partyType.value === "supplier" ? "采购部" : "销售部";
  form.ownerName = session.userName.value || "本地管理员";
  form.status = "DRAFT";
  form.lines = [
    {
      productCode: "CP-001",
      warehouseCode: "CK-001",
      qty: 1,
      unitPrice: isPurchaseOrderForm.value || isPurchaseInForm.value ? 72 : 86,
      lineRemark: ""
    }
  ];
  formMessage.value = "已生成新单据草稿号";
  markActiveDirty();
}

function defaultLine(warehouseCode = "CK-001"): OrderLineForm {
  return {
    productCode: "CP-001",
    warehouseCode,
    qty: 1,
    unitPrice: isPurchaseOrderForm.value || isPurchaseInForm.value ? 72 : 86,
    lineRemark: ""
  };
}

function addLine() {
  if (!isDraftDocument.value) {
    return;
  }
  const previousLine = currentOrderForm.value.lines[currentOrderForm.value.lines.length - 1];
  currentOrderForm.value.lines.push(defaultLine(previousLine?.warehouseCode || "CK-001"));
  markActiveDirty();
}

function insertLineAfter(index: number) {
  if (!isDraftDocument.value) {
    return;
  }
  const previousLine = currentOrderForm.value.lines[index];
  currentOrderForm.value.lines.splice(index + 1, 0, defaultLine(previousLine?.warehouseCode || "CK-001"));
  markActiveDirty();
  void focusLineCell(index + 1, "product");
}

function copyLine(index: number) {
  if (!isDraftDocument.value) {
    return;
  }
  const source = currentOrderForm.value.lines[index];
  if (!source) {
    return;
  }
  currentOrderForm.value.lines.splice(index + 1, 0, { ...source });
  markActiveDirty();
  void focusLineCell(index + 1, "product");
}

function removeLine(index: number) {
  if (!isDraftDocument.value || currentOrderForm.value.lines.length <= 1) {
    return;
  }
  currentOrderForm.value.lines.splice(index, 1);
  markActiveDirty();
}

function handleLineDragStart(event: DragEvent, index: number) {
  if (!isDraftDocument.value) {
    event.preventDefault();
    return;
  }
  draggingLineIndex.value = index;
  event.dataTransfer?.setData("text/plain", String(index));
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function handleLineDragOver(event: DragEvent) {
  if (!isDraftDocument.value || !event.dataTransfer) {
    return;
  }
  event.dataTransfer.dropEffect = "move";
}

function handleLineDrop(targetIndex: number) {
  if (!isDraftDocument.value || draggingLineIndex.value === null || draggingLineIndex.value === targetIndex) {
    draggingLineIndex.value = null;
    return;
  }
  moveLine(draggingLineIndex.value, targetIndex);
  draggingLineIndex.value = null;
}

function handleLineDragEnd() {
  draggingLineIndex.value = null;
}

function moveLine(fromIndex: number, toIndex: number) {
  const lines = currentOrderForm.value.lines;
  const [line] = lines.splice(fromIndex, 1);
  if (!line) {
    return;
  }
  lines.splice(toIndex, 0, line);
  activeSelector.value = "";
  markActiveDirty();
}

function applyBatchWarehouse() {
  if (!isDraftDocument.value) {
    return;
  }
  const warehouseCode = batchWarehouseCode.value.trim();
  if (!warehouseCode) {
    return;
  }
  currentOrderForm.value.lines.forEach((line) => {
    line.warehouseCode = warehouseCode;
  });
  activeSelector.value = "";
  markActiveDirty();
}

async function handleEntryPaste(event: ClipboardEvent, startIndex: number) {
  if (!isDraftDocument.value) {
    return;
  }
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text.trim()) {
    return;
  }
  event.preventDefault();
  const refs = await loadEntryPasteRefs();
  const pasteResult = parseEntryClipboard(text, refs);
  if (pasteResult.lines.length === 0) {
    formMessage.value = "未识别到可粘贴的分录。";
    return;
  }
  if (pasteResult.conflicts.length > 0) {
    activeSelector.value = "";
    pendingEntryPaste.value = {
      startIndex,
      lines: pasteResult.lines,
      conflicts: pasteResult.conflicts
    };
    formMessage.value = `有 ${pasteResult.conflicts.length} 行商品需要选择。`;
    void focusEntryPasteDialog();
    return;
  }
  applyPastedEntryLines(startIndex, pasteResult.lines);
}

async function focusEntryPasteDialog() {
  await nextTick();
  entryPasteDialogRef.value?.focus();
}

async function loadEntryPasteRefs(): Promise<EntryPasteRefs> {
  const [productResult, warehouseResult] = await Promise.all([
    fetchListRows("product-master-list", { keyword: "", status: "", page: 1, pageSize: 1000 }),
    fetchListRows("warehouse-master-list", { keyword: "", status: "", page: 1, pageSize: 1000 })
  ]);
  return {
    products: mergeMasterOptions(
      productResult.ok && productResult.data ? productResult.data.rows.map(masterRowToOption) : [],
      knownProductOptions
    ),
    warehouses: mergeMasterOptions(
      warehouseResult.ok && warehouseResult.data ? warehouseResult.data.rows.map(masterRowToOption) : [],
      knownWarehouseOptions
    )
  };
}

function masterRowToOption(row: Record<string, unknown>): MasterOption {
  return {
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    spec: row.spec ? String(row.spec) : "",
    unit: row.unit ? String(row.unit) : ""
  };
}

function mergeMasterOptions(primary: MasterOption[], fallback: MasterOption[]) {
  const byCode = new Map<string, MasterOption>();
  [...fallback, ...primary].forEach((option) => {
    if (option.code) {
      byCode.set(option.code, option);
    }
  });
  return Array.from(byCode.values());
}

function parseEntryClipboard(text: string, refs: EntryPasteRefs): { lines: OrderLineForm[]; conflicts: EntryPasteConflict[] } {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => row.split(/\t|,|;/).map((cell) => cell.trim()))
    .filter((cells) => cells.some(Boolean));
  if (rows.length === 0) {
    return { lines: [], conflicts: [] };
  }
  const header = detectEntryPasteHeader(rows[0]);
  const dataRows = header ? rows.slice(1) : rows;
  const lines: OrderLineForm[] = [];
  const conflicts: EntryPasteConflict[] = [];
  dataRows.forEach((cells) => {
    const parsed = parseEntryPasteRow(cells, refs, header, lines.length);
    if (!parsed) {
      return;
    }
    lines.push(parsed.line);
    if (parsed.conflict) {
      conflicts.push(parsed.conflict);
    }
  });
  return { lines, conflicts };
}

function parseEntryPasteRow(cells: string[], refs: EntryPasteRefs, header: Record<string, number> | null, lineIndex: number): { line: OrderLineForm; conflict?: EntryPasteConflict } | null {
  const productToken = cellByHeader(cells, header, "productCode", header ? -1 : 0);
  const productName = cellByHeader(cells, header, "productName", header ? -1 : 0);
  const productSpec = cellByHeader(cells, header, "spec", -1);
  const warehouseToken = cellByHeader(cells, header, "warehouseCode", header ? -1 : 1);
  const warehouseName = cellByHeader(cells, header, "warehouseName", -1);
  const qtyText = cellByHeader(cells, header, "qty", header ? -1 : 2);
  const priceText = cellByHeader(cells, header, "unitPrice", header ? -1 : 3);
  const productMatch = matchProduct(productToken, productName, productSpec, refs.products);
  if (!productMatch.product && !productToken && productMatch.candidates.length === 0) {
    return null;
  }
  const matchedWarehouse = matchMasterOption(warehouseToken || warehouseName, refs.warehouses);
  const fallbackWarehouseCode = warehouseToken || batchWarehouseCode.value.trim() || "CK-001";
  const qty = normalizedPositiveNumber(qtyText, 1);
  const unitPrice = normalizedPositiveNumber(priceText, isPurchaseOrderForm.value || isPurchaseInForm.value ? 72 : 86);
  const line: OrderLineForm = {
    productCode: productMatch.product?.code ?? productToken,
    productName: productMatch.product?.name,
    spec: productMatch.product?.spec ?? productSpec,
    warehouseCode: matchedWarehouse?.code ?? fallbackWarehouseCode,
    qty,
    unitPrice,
    lineRemark: ""
  };
  if (productMatch.candidates.length > 0) {
    return {
      line,
      conflict: {
        lineIndex,
        productText: [productName || productToken, productSpec].filter(Boolean).join(" / "),
        candidates: productMatch.candidates,
        activeIndex: 0
      }
    };
  }
  return { line };
}

function detectEntryPasteHeader(cells: string[]) {
  const header: Record<string, number> = {};
  cells.forEach((cell, index) => {
    const field = headerFieldName(cell);
    if (field && header[field] === undefined) {
      header[field] = index;
    }
  });
  return Object.keys(header).length >= 2 && (header.productCode !== undefined || header.productName !== undefined) ? header : null;
}

function headerFieldName(cell: string) {
  const key = normalizePasteText(cell);
  const aliases: Record<string, string> = {
    productcode: "productCode",
    productno: "productCode",
    product: "productCode",
    code: "productCode",
    商品编码: "productCode",
    商品代码: "productCode",
    商品编号: "productCode",
    物料编码: "productCode",
    编码: "productCode",
    商品名称: "productName",
    商品名: "productName",
    名称: "productName",
    物料名称: "productName",
    规格型号: "spec",
    规格: "spec",
    型号: "spec",
    spec: "spec",
    仓库编码: "warehouseCode",
    仓库代码: "warehouseCode",
    仓库编号: "warehouseCode",
    warehousecode: "warehouseCode",
    仓库: "warehouseName",
    仓库名称: "warehouseName",
    数量: "qty",
    qty: "qty",
    quantity: "qty",
    单价: "unitPrice",
    价格: "unitPrice",
    unitprice: "unitPrice",
    price: "unitPrice"
  };
  return aliases[key] ?? "";
}

function cellByHeader(cells: string[], header: Record<string, number> | null, field: string, fallbackIndex: number) {
  if (header && header[field] !== undefined) {
    return cells[header[field]]?.trim() ?? "";
  }
  return fallbackIndex >= 0 ? cells[fallbackIndex]?.trim() ?? "" : "";
}

function matchProduct(productToken: string, productName: string, productSpec: string, products: MasterOption[]): { product?: MasterOption; candidates: MasterOption[] } {
  const exactByCode = matchMasterOptionCode(productToken, products);
  if (exactByCode) {
    return { product: exactByCode, candidates: [] };
  }
  const normalizedName = normalizePasteText(productName || productToken);
  const normalizedSpec = normalizePasteText(productSpec);
  if (!normalizedName) {
    return { candidates: [] };
  }
  const sameName = products.filter((option) => normalizePasteText(option.name) === normalizedName);
  const exactNameAndSpec = sameName.filter((option) => normalizePasteText(option.spec ?? "") === normalizedSpec);
  if (normalizedSpec && exactNameAndSpec.length === 1) {
    return { product: exactNameAndSpec[0], candidates: [] };
  }
  if (sameName.length === 1 && (!normalizedSpec || exactNameAndSpec.length === 1)) {
    return { product: sameName[0], candidates: [] };
  }
  if (sameName.length > 1) {
    return { candidates: exactNameAndSpec.length > 1 ? exactNameAndSpec : sameName };
  }
  const joinedText = normalizePasteText(`${productName || productToken}${productSpec}`);
  const joinedMatches = products.filter((option) => normalizePasteText(`${option.name}${option.spec ?? ""}`) === joinedText);
  if (joinedMatches.length === 1) {
    return { product: joinedMatches[0], candidates: [] };
  }
  if (joinedMatches.length > 1) {
    return { candidates: joinedMatches };
  }
  return { candidates: [] };
}

function matchMasterOption(token: string, options: MasterOption[]) {
  const normalized = normalizePasteText(token);
  if (!normalized) {
    return undefined;
  }
  return matchMasterOptionCode(token, options)
    ?? options.find((option) => normalizePasteText(option.name) === normalized);
}

function matchMasterOptionCode(token: string, options: MasterOption[]) {
  const normalized = normalizePasteText(token);
  if (!normalized) {
    return undefined;
  }
  return options.find((option) => normalizePasteText(option.code) === normalized);
}

function normalizePasteText(value: string | undefined) {
  return String(value ?? "")
    .replace(/原材料/g, "原料")
    .replace(/\s+/g, "")
    .replace(/[（）()【】\[\]]/g, "")
    .replace(/[\/_.-]/g, "")
    .toLowerCase();
}

function normalizedPositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function applyPastedEntryLines(startIndex: number, pastedLines: OrderLineForm[]) {
  const lines = currentOrderForm.value.lines;
  pastedLines.forEach((line, offset) => {
    const targetIndex = startIndex + offset;
    if (targetIndex < lines.length) {
      lines.splice(targetIndex, 1, line);
    } else {
      lines.push(line);
    }
  });
  activeSelector.value = "";
  formMessage.value = `已粘贴 ${pastedLines.length} 行分录`;
  markActiveDirty();
  void focusLineCell(startIndex + pastedLines.length - 1, "qty");
}

function selectEntryPasteCandidate(lineIndex: number, code: string) {
  const pending = pendingEntryPaste.value;
  if (!pending) {
    return;
  }
  const conflict = pending.conflicts.find((item) => item.lineIndex === lineIndex);
  const candidate = conflict?.candidates.find((item) => item.code === code);
  const line = pending.lines[lineIndex];
  if (!conflict || !candidate || !line) {
    return;
  }
  conflict.selectedCode = code;
  conflict.activeIndex = Math.max(0, conflict.candidates.findIndex((item) => item.code === code));
  line.productCode = candidate.code;
  line.productName = candidate.name;
  line.spec = candidate.spec ?? "";
}

function isEntryPasteCandidateActive(conflict: EntryPasteConflict, candidateIndex: number) {
  return (conflict.activeIndex ?? 0) === candidateIndex;
}

function activeEntryPasteConflict() {
  const pending = pendingEntryPaste.value;
  if (!pending) {
    return undefined;
  }
  return pending.conflicts.find((conflict) => !conflict.selectedCode) ?? pending.conflicts[0];
}

function moveEntryPasteCandidate(delta: number) {
  const conflict = activeEntryPasteConflict();
  if (!conflict || conflict.candidates.length === 0) {
    return;
  }
  const maxIndex = conflict.candidates.length - 1;
  const currentIndex = Math.min(Math.max(conflict.activeIndex ?? 0, 0), maxIndex);
  conflict.activeIndex = Math.min(Math.max(currentIndex + delta, 0), maxIndex);
}

function chooseActiveEntryPasteCandidate() {
  const conflict = activeEntryPasteConflict();
  if (!conflict || conflict.candidates.length === 0) {
    return;
  }
  const candidate = conflict.candidates[Math.min(Math.max(conflict.activeIndex ?? 0, 0), conflict.candidates.length - 1)];
  if (!candidate) {
    return;
  }
  selectEntryPasteCandidate(conflict.lineIndex, candidate.code);
  if (entryPasteConflictsResolved.value) {
    confirmPendingEntryPaste();
  }
}

function handleEntryPasteConflictKeydown(event: KeyboardEvent) {
  if (!pendingEntryPaste.value) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancelPendingEntryPaste();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveEntryPasteCandidate(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveEntryPasteCandidate(-1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    chooseActiveEntryPasteCandidate();
  }
}

function cancelPendingEntryPaste() {
  pendingEntryPaste.value = null;
  formMessage.value = "已取消本次粘贴。";
}

function confirmPendingEntryPaste() {
  const pending = pendingEntryPaste.value;
  if (!pending || !entryPasteConflictsResolved.value) {
    return;
  }
  applyPastedEntryLines(pending.startIndex, pending.lines);
  pendingEntryPaste.value = null;
}

function handleLineCellKeydown(event: KeyboardEvent, lineIndex: number, cell: "product" | "warehouse" | "qty" | "price", selectorId = "") {
  const selectorWasOpen = Boolean(selectorId && activeSelector.value === selectorId && selectorOptions.value.length > 0);
  if (selectorId) {
    handleSelectorKeydown(event, selectorId);
  }
  if (!isDraftDocument.value || selectorWasOpen || event.defaultPrevented) {
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    insertLineAfter(lineIndex);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    advanceLineCellOnEnter(lineIndex, cell);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    void focusLineCell(Math.min(lineIndex + 1, currentOrderForm.value.lines.length - 1), cell);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    void focusLineCell(Math.max(lineIndex - 1, 0), cell);
  }
}

function advanceLineCellOnEnter(lineIndex: number, cell: "product" | "warehouse" | "qty" | "price") {
  if (cell === "qty") {
    void focusLineCell(lineIndex, "price");
    return;
  }
  if (cell === "price") {
    insertLineAfter(lineIndex);
    return;
  }
  void focusLineCell(Math.min(lineIndex + 1, currentOrderForm.value.lines.length - 1), cell);
}

async function focusLineCell(lineIndex: number, cell: "product" | "warehouse" | "qty" | "price") {
  await nextTick();
  const testId = lineCellTestId(lineIndex, cell);
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  input?.focus();
  input?.select();
}

function lineCellTestId(lineIndex: number, cell: "product" | "warehouse" | "qty" | "price") {
  switch (cell) {
    case "warehouse":
      return lineWarehouseTestId(lineIndex);
    case "qty":
      return lineQtyTestId(lineIndex);
    case "price":
      return linePriceTestId(lineIndex);
    case "product":
    default:
      return lineProductTestId(lineIndex);
  }
}

function nextBillNo() {
  const prefix = isPurchaseOrderForm.value ? "CGDD" : isPurchaseInForm.value ? "CGRK" : isSalesOutForm.value ? "XSCK" : "XSDD";
  return nextBillNoFor(prefix);
}

function nextBillNoFor(prefix: string) {
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
  const timePart = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    String(now.getMilliseconds()).padStart(3, "0")
  ].join("");
  const seq = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${prefix}-${datePart}-${timePart}-${seq}`;
}

async function saveCurrentDocument() {
  if (isSalesOrderForm.value) {
    await saveCurrentSalesOrder();
    return;
  }
  await saveCurrentDocumentDraft(false);
}

async function saveCurrentDocumentDraft(allowZeroValues: boolean) {
  if (isSalesOrderForm.value) {
    await saveCurrentSalesOrderDraft(allowZeroValues);
    return;
  }
  const type = currentDocumentType();
  if (!type) {
    return;
  }
  if (!allowZeroValues) {
    pendingZeroEntrySave.value = null;
  }
  formMessage.value = "";
  const preparedLines = prepareEntryLinesForSave(currentOrderForm.value.lines);
  if (!preparedLines.ok) {
    formMessage.value = preparedLines.message;
    return;
  }
  const zeroWarnings = zeroEntryWarnings(preparedLines.formLines);
  if (!allowZeroValues && zeroWarnings.length > 0) {
    pendingZeroEntrySave.value = { target: "document", warnings: zeroWarnings };
    return;
  }
  currentOrderForm.value.lines = preparedLines.formLines;
  const result = await saveDocumentDraft(type, {
    billNo: currentOrderForm.value.billNo,
    sourceOrderNo: currentOrderForm.value.sourceOrderNo,
    partyCode: currentOrderForm.value.partyCode,
    billDate: currentOrderForm.value.billDate,
    department: currentOrderForm.value.department,
    ownerName: currentOrderForm.value.ownerName,
    lines: preparedLines.documentLines
  });
  formMessage.value = result.ok ? saveSuccessMessage(preparedLines.removedBlankCount, allowZeroValues ? zeroWarnings.length : 0) : result.message;
  if (result.ok) {
    currentOrderForm.value.status = "DRAFT";
    clearActiveDirty();
  }
}

function cancelZeroEntrySave() {
  pendingZeroEntrySave.value = null;
  formMessage.value = "已取消保存，请检查零数量/零单价分录。";
}

async function confirmZeroEntrySave() {
  const pending = pendingZeroEntrySave.value;
  if (!pending) {
    return;
  }
  applyZeroEntryReasons(pending);
  pendingZeroEntrySave.value = null;
  if (pending.target === "salesOrder") {
    await saveCurrentSalesOrderDraft(true);
    return;
  }
  await saveCurrentDocumentDraft(true);
}

function applyZeroEntryReasons(pending: PendingZeroEntrySave) {
  const form = currentOrderForm.value;
  pending.warnings.forEach((warning) => {
    const line = form.lines[warning.lineNo - 1];
    if (!line) {
      return;
    }
    const reasonText = `零值原因：${warning.reason}（${warning.reasons.join("、")}）`;
    line.lineRemark = mergeLineRemark(line.lineRemark, reasonText);
  });
}

function mergeLineRemark(current: string | undefined, addition: string) {
  const trimmed = String(current ?? "").trim();
  if (!trimmed) {
    return addition;
  }
  if (trimmed.includes(addition)) {
    return trimmed;
  }
  return `${trimmed}；${addition}`;
}

async function auditCurrentSalesOrder() {
  const result = await auditSalesOrder(salesOrderForm.billNo);
  formMessage.value = result.ok ? "审核成功" : result.message;
  if (result.ok) {
    salesOrderForm.status = "AUDITED";
    clearActiveDirty();
  }
}

async function auditCurrentDocument() {
  if (!session.hasPermission(currentAuditPermission.value)) {
    formMessage.value = "当前角色无权审核该单据。";
    return;
  }
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
  if (result.ok) {
    currentOrderForm.value.status = "AUDITED";
    clearActiveDirty();
  }
}

function openRiskyDocumentAction(action: RiskyDocumentAction) {
  if (!canReverseDocument.value) {
    return;
  }
  pendingRiskyDocumentAction.value = action;
}

function cancelRiskyDocumentAction() {
  const verb = riskyActionVerb.value;
  pendingRiskyDocumentAction.value = null;
  formMessage.value = `已取消${verb}。`;
}

async function confirmRiskyDocumentAction() {
  const action = pendingRiskyDocumentAction.value;
  if (!action) {
    return;
  }
  pendingRiskyDocumentAction.value = null;
  if (action === "redReverse") {
    await redReverseCurrentDocument();
    return;
  }
  await reverseCurrentDocument();
}

async function reverseCurrentDocument() {
  const type = currentDocumentType();
  if (!type || !isReversibleDocumentForm.value) {
    return;
  }
  const result = await reverseDocument(type, currentOrderForm.value.billNo);
  formMessage.value = result.ok ? "反审核成功，库存流水已冲销" : result.message;
  if (result.ok) {
    currentOrderForm.value.status = "REVERSED";
  }
}

async function voidCurrentDocument() {
  const type = currentDocumentType();
  if (!type || !isReversibleDocumentForm.value) {
    return;
  }
  const result = await voidDocument(type, currentOrderForm.value.billNo);
  formMessage.value = result.ok ? "作废成功" : result.message;
  if (result.ok) {
    currentOrderForm.value.status = "VOIDED";
    clearActiveDirty();
  }
}

async function redReverseCurrentDocument() {
  const type = currentDocumentType();
  if (!type || !isReversibleDocumentForm.value) {
    return;
  }
  const redBillNo = redReverseBillNo.value;
  const result = await redReverseDocument(type, currentOrderForm.value.billNo, {
    redBillNo,
    billDate: currentOrderForm.value.billDate,
    ownerName: currentOrderForm.value.ownerName
  });
  formMessage.value = result.ok ? `红冲成功：${redBillNo}` : result.message;
  if (result.ok) {
    const detail = await fetchDocumentDetail(type, redBillNo);
    if (detail.ok && detail.data) {
      fillDocumentForm(currentOrderForm.value, detail.data, partyType.value);
    } else {
      currentOrderForm.value.billNo = redBillNo;
      currentOrderForm.value.status = "RED_REVERSED";
    }
    clearActiveDirty();
  }
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

async function exportCurrentDocument() {
  const type = currentOutputDocumentType();
  if (!type) {
    return;
  }
  const result = await exportDocument(type, currentOrderForm.value.billNo);
  formMessage.value = result.ok ? "引出文件已生成" : result.message;
}

async function printCurrentDocument() {
  const type = currentOutputDocumentType();
  if (!type) {
    return;
  }
  const result = await printDocument(type, currentOrderForm.value.billNo);
  if (result.ok && result.data) {
    window.open(result.data, "_blank", "noopener");
  }
  formMessage.value = result.ok ? "PDF 打印文件已生成" : result.message;
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

function toDocumentLines(lines: OrderLineForm[]) {
  return lines.map((line) => ({
    productCode: line.productCode,
    warehouseCode: line.warehouseCode,
    sourceLineNo: line.sourceLineNo,
    qty: Number(line.qty || 0),
    unitPrice: Number(line.unitPrice || 0),
    lineRemark: String(line.lineRemark ?? "").trim()
  }));
}

function prepareEntryLinesForSave(lines: OrderLineForm[]): { ok: true } & PreparedEntryLines | { ok: false; message: string } {
  const nonBlankLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !isBlankEntryLine(line));
  if (nonBlankLines.length === 0) {
    return { ok: false, message: "至少保留一行有效分录。" };
  }
  const missingProduct = nonBlankLines.find(({ line }) => !entryLineProductCode(line));
  if (missingProduct) {
    return { ok: false, message: `第 ${missingProduct.index + 1} 行商品编码不能为空。` };
  }
  const seen = new Map<string, number>();
  for (const { line, index } of nonBlankLines) {
    const key = `${entryLineProductCode(line)}@@${entryLineWarehouseCode(line)}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      return { ok: false, message: `第 ${index + 1} 行与第 ${firstIndex + 1} 行商品和仓库重复，请合并后再保存。` };
    }
    seen.set(key, index);
  }
  const formLines = nonBlankLines.map(({ line }) => line);
  return {
    ok: true,
    formLines,
    documentLines: toDocumentLines(formLines),
    removedBlankCount: lines.length - formLines.length
  };
}

function isBlankEntryLine(line: OrderLineForm) {
  return !entryLineProductCode(line)
    && !String(line.productName ?? "").trim()
    && !String(line.spec ?? "").trim()
    && !String(line.lineRemark ?? "").trim()
    && normalizedQty(line.qty) === 0
    && normalizedQty(line.unitPrice) === 0;
}

function entryLineProductCode(line: OrderLineForm) {
  return String(line.productCode ?? "").trim();
}

function entryLineWarehouseCode(line: OrderLineForm) {
  return String(line.warehouseCode ?? "").trim() || "CK-001";
}

function zeroEntryWarnings(lines: OrderLineForm[]): ZeroEntryWarning[] {
  return lines
    .map((line, index) => {
      const qty = normalizedQty(line.qty);
      const unitPrice = normalizedQty(line.unitPrice);
      const reasons = [
        qty === 0 ? "数量为 0" : "",
        unitPrice === 0 ? "单价为 0" : ""
      ].filter(Boolean);
      return {
        lineNo: index + 1,
        productCode: entryLineProductCode(line),
        warehouseCode: entryLineWarehouseCode(line),
        qty,
        unitPrice,
        reasons,
        reason: zeroReasonOptions[0]
      };
    })
    .filter((warning) => warning.reasons.length > 0);
}

function saveSuccessMessage(removedBlankCount: number, confirmedZeroCount = 0) {
  const notes: string[] = [];
  if (removedBlankCount > 0) {
    notes.push(`已移除 ${removedBlankCount} 行空白分录`);
  }
  if (confirmedZeroCount > 0) {
    notes.push(`已确认 ${confirmedZeroCount} 行零值分录`);
  }
  return notes.length > 0 ? `草稿已保存，${notes.join("，")}` : "草稿已保存";
}

function currentOutputDocumentType(): OutputDocumentType | null {
  if (isSalesOrderForm.value) {
    return "salesOrder";
  }
  if (isPurchaseOrderForm.value) {
    return "purchaseOrder";
  }
  if (isPurchaseInForm.value) {
    return "purchaseIn";
  }
  if (isSalesOutForm.value) {
    return "salesOut";
  }
  if (isMaterialIssueForm.value) {
    return "materialIssue";
  }
  if (isProductInForm.value) {
    return "productIn";
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
  selectorCursorIndex.value = 0;
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
  selectorCursorIndex.value = selectorOptions.value.length > 0 ? 0 : -1;
}

function handleSelectorKeydown(event: KeyboardEvent, selectorId: string) {
  if (event.key === "Escape") {
    activeSelector.value = "";
    return;
  }
  if (activeSelector.value !== selectorId || selectorOptions.value.length === 0) {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectorCursorIndex.value = Math.min(selectorCursorIndex.value + 1, selectorOptions.value.length - 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectorCursorIndex.value = Math.max(selectorCursorIndex.value - 1, 0);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    chooseSelectorOption(selectorId);
    return;
  }
  if (event.key === "Tab" && !event.shiftKey) {
    event.preventDefault();
    chooseSelectorOption(selectorId);
  }
}

function chooseSelectorOption(selectorId: string) {
  const option = selectorOptions.value[selectorCursorIndex.value] ?? selectorOptions.value[0];
  if (!option) {
    return;
  }
  if (selectorId.endsWith("-party")) {
    selectPartyOption(option);
  } else if (selectorId.endsWith("-product")) {
    selectLineProduct(option, lineIndexFromSelector(selectorId));
  } else if (selectorId.endsWith("-warehouse")) {
    selectWarehouseOption(option, lineIndexFromSelector(selectorId));
  }
}

async function focusFormField(testId: string) {
  await nextTick();
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  input?.focus();
  input?.select();
}

function focusNextAfterSelector(selectorId: string) {
  if (selectorId.endsWith("-party")) {
    void focusFormField(`${formTestPrefix.value}-bill-date`);
    return;
  }
  const lineIndex = lineIndexFromSelector(selectorId);
  if (selectorId.endsWith("-product")) {
    void focusLineCell(lineIndex, "warehouse");
    return;
  }
  if (selectorId.endsWith("-warehouse")) {
    void focusLineCell(lineIndex, "qty");
  }
}

function selectorIdForLine(lineIndex: number, field: "product" | "warehouse") {
  return `${formTestPrefix.value}-line-${lineIndex}-${field}`;
}

function selectorIdForParty() {
  return `${formTestPrefix.value}-party`;
}

function selectPartyOption(option: MasterOption, selectorId = selectorIdForParty()) {
  currentOrderForm.value.partyCode = option.code;
  activeSelector.value = "";
  markActiveDirty();
  focusNextAfterSelector(selectorId);
}

function selectWarehouseOption(option: MasterOption, lineIndex = 0, selectorId = selectorIdForLine(lineIndex, "warehouse")) {
  const line = currentOrderForm.value.lines[lineIndex];
  if (!line) {
    return;
  }
  line.warehouseCode = option.code;
  activeSelector.value = "";
  markActiveDirty();
  focusNextAfterSelector(selectorId);
}

function selectLineProduct(option: MasterOption, lineIndex = 0, selectorId = selectorIdForLine(lineIndex, "product")) {
  const line = currentOrderForm.value.lines[lineIndex];
  if (!line) {
    return;
  }
  line.productCode = option.code;
  line.productName = option.name;
  line.spec = option.spec ?? "";
  activeSelector.value = "";
  markActiveDirty();
  focusNextAfterSelector(selectorId);
}

function lineIndexFromSelector(selectorId: string) {
  const match = selectorId.match(/-line-(\d+)-/);
  return match ? Number(match[1]) : 0;
}
</script>
