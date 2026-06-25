<template>
  <LoginPage v-if="!isAuthenticated" ref="loginPageRef" :users="systemUsers" @login-success="handleLoginSuccess" />
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
          <button type="button" data-testid="session-password-change" @click="passwordChangeDialogRef?.openPasswordDialog()">修改密码</button>
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
        <div v-else-if="tabs.activeTab.value.kind === 'shell' && !['print-template-settings', 'role-permission-settings', 'user-role-list', 'security-settings', 'notification-provider-settings'].includes(tabs.activeTab.value.id)" class="panel-page">
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <div class="empty-shell">首版范围裁剪：该入口仅保留壳层，不进入深层业务页。</div>
        </div>
        <SecuritySettingsPage
          v-else-if="tabs.activeTab.value.id === 'security-settings'"
          :can-manage="canManageSecuritySettings"
          @password-policy-updated="activePasswordPolicy = $event"
        />
        <div v-else-if="tabs.activeTab.value.id === 'notification-provider-settings'" class="role-permission-page">
          <section class="role-permission-head">
            <div>
              <h2>通知供应商</h2>
              <p>维护通知 outbox 的供应商参数，影响找回密码通知的发送标记、重发和自动重试。</p>
            </div>
            <div class="role-permission-head__actions">
              <button type="button" data-testid="notification-provider-refresh" @click="loadNotificationProviderSettings">刷新</button>
              <button class="primary-action" type="button" :disabled="!canManageNotificationProviderSettings" data-testid="notification-provider-save" @click="saveNotificationProviderSettingsAction">保存</button>
            </div>
          </section>
          <section class="role-permission-body">
            <aside class="role-permission-list" aria-label="通知供应商">
              <button
                type="button"
                :class="{ active: notificationProviderForm.providerCode === 'LOCAL' }"
                data-testid="notification-provider-local"
                @click="notificationProviderForm.providerCode = 'LOCAL'"
              >
                <strong>本地通知</strong>
                <span>只写 outbox 与审计，不请求外部网络</span>
              </button>
              <button
                type="button"
                :class="{ active: notificationProviderForm.providerCode === 'SIMULATED_HTTP' }"
                data-testid="notification-provider-simulated-http"
                @click="notificationProviderForm.providerCode = 'SIMULATED_HTTP'"
              >
                <strong>模拟 HTTP</strong>
                <span>保存接口地址与密钥，发送仍走本地 dry-run</span>
              </button>
              <button
                type="button"
                :class="{ active: notificationProviderForm.providerCode === 'SIMULATED_SMTP' }"
                data-testid="notification-provider-simulated-smtp"
                @click="notificationProviderForm.providerCode = 'SIMULATED_SMTP'"
              >
                <strong>模拟 SMTP</strong>
                <span>为邮件供应商预留参数，不暴露真实密钥</span>
              </button>
            </aside>
            <form class="user-management-form" @submit.prevent="saveNotificationProviderSettingsAction">
              <div class="role-permission-summary" data-testid="notification-provider-summary">
                <strong>{{ notificationProviderSettings?.providerLabel || notificationProviderLabel(notificationProviderForm.providerCode) }}</strong>
                <span>{{ notificationProviderForm.providerCode }}</span>
                <em>{{ notificationProviderForm.dryRun ? "Dry-run" : "待接真实供应商" }}</em>
              </div>
              <label>
                <span>供应商类型</span>
                <select v-model="notificationProviderForm.providerCode" data-testid="notification-provider-code">
                  <option value="LOCAL">本地通知</option>
                  <option value="SIMULATED_HTTP">模拟 HTTP 供应商</option>
                  <option value="SIMULATED_SMTP">模拟 SMTP 供应商</option>
                </select>
              </label>
              <label>
                <span>发送方名称</span>
                <input v-model="notificationProviderForm.senderName" data-testid="notification-provider-sender-name" />
              </label>
              <label>
                <span>接口地址</span>
                <input v-model="notificationProviderForm.endpointUrl" data-testid="notification-provider-endpoint-url" placeholder="https://provider.example/send" />
              </label>
              <label>
                <span>回调密钥</span>
                <input v-model="notificationProviderForm.webhookSecret" data-testid="notification-provider-webhook-secret" type="password" placeholder="留空则保持现有密钥" />
              </label>
              <div class="security-toggle-grid" data-testid="notification-provider-toggles">
                <label>
                  <input v-model="notificationProviderForm.dryRun" type="checkbox" data-testid="notification-provider-dry-run" />
                  <span>Dry-run</span>
                </label>
              </div>
              <label>
                <span>当前管理员密码</span>
                <input
                  v-model="notificationProviderForm.currentPassword"
                  data-testid="notification-provider-current-password"
                  type="password"
                  autocomplete="current-password"
                />
              </label>
              <dl class="user-security-summary">
                <div>
                  <dt>当前供应商</dt>
                  <dd data-testid="notification-provider-current-code">{{ notificationProviderSettings?.providerCode || "-" }}</dd>
                </div>
                <div>
                  <dt>发送方</dt>
                  <dd data-testid="notification-provider-current-sender">{{ notificationProviderSettings?.senderName || "-" }}</dd>
                </div>
                <div>
                  <dt>接口地址</dt>
                  <dd data-testid="notification-provider-current-endpoint">{{ notificationProviderSettings?.endpointUrl || "-" }}</dd>
                </div>
                <div>
                  <dt>密钥状态</dt>
                  <dd data-testid="notification-provider-secret-state">{{ notificationProviderSettings?.webhookSecretConfigured ? "已配置" : "未配置" }}</dd>
                </div>
              </dl>
              <p v-if="notificationProviderMessage" class="form-message" data-testid="notification-provider-message">{{ notificationProviderMessage }}</p>
            </form>
          </section>
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
                <span>{{ user.username }} / {{ user.roleName }} / {{ managedUserStateLabel(user) }}</span>
              </button>
            </aside>
            <div class="user-management-form">
              <div class="role-permission-summary" data-testid="user-management-summary">
                <strong>{{ userManagementMode === "create" ? "新增用户" : selectedManagedUser?.displayName || "未选择用户" }}</strong>
                <span>{{ userManagementMode === "create" ? "CREATE" : selectedManagedUser?.username || "" }}</span>
                <em>{{ selectedManagedUser ? managedUserStateLabel(selectedManagedUser) : "选择角色后保存" }}</em>
              </div>
              <dl v-if="selectedManagedUser && userManagementMode === 'edit'" class="user-security-summary" data-testid="user-security-summary">
                <div>
                  <dt>失败次数</dt>
                  <dd data-testid="managed-user-failed-count">{{ selectedManagedUser.failedLoginCount ?? 0 }}</dd>
                </div>
                <div>
                  <dt>锁定状态</dt>
                  <dd data-testid="managed-user-lock-state">{{ selectedManagedUser.locked ? `已锁定至 ${selectedManagedUser.lockedUntil}` : "未锁定" }}</dd>
                </div>
                <div>
                  <dt>最近登录</dt>
                  <dd>{{ selectedManagedUser.lastLoginAt || "-" }}</dd>
                </div>
                <div>
                  <dt>当前会话</dt>
                  <dd data-testid="managed-user-active-session">{{ selectedManagedUser.activeSession ? `在线：${selectedManagedUser.activeSessionStartedAt || "-"}` : "无活动会话" }}</dd>
                </div>
                <div>
                  <dt>上次替换</dt>
                  <dd data-testid="managed-user-session-replaced">{{ selectedManagedUser.lastSessionReplacedAt || "-" }}</dd>
                </div>
              </dl>
              <section v-if="pendingPasswordResetRequests.length" class="password-reset-admin-panel" data-testid="password-reset-admin-panel">
                <div class="password-reset-admin-panel__head">
                  <strong>待处理找回申请</strong>
                  <span>{{ pendingPasswordResetRequests.length }} 条</span>
                </div>
                <button
                  v-for="request in pendingPasswordResetRequests"
                  :key="request.id"
                  type="button"
                  class="password-reset-request-row"
                  :class="{ active: request.id === selectedPasswordResetRequestId }"
                  :data-testid="`password-reset-request-${request.username}`"
                  @click="selectPasswordResetRequest(request.id)"
                >
                  <strong>{{ request.displayName || request.username }}</strong>
                  <span>{{ request.username }} / {{ request.requestedAt }}</span>
                  <em>{{ request.contactNote || "无联系方式说明" }}</em>
                </button>
              </section>
              <section v-if="selectedPasswordResetRequest" class="password-reset-admin-panel password-reset-admin-panel--selected" data-testid="password-reset-selected">
                <div class="password-reset-admin-panel__head">
                  <strong>{{ selectedPasswordResetRequest.username }} 的找回申请</strong>
                  <span>{{ selectedPasswordResetRequest.requestedAt }}</span>
                </div>
                <p>{{ selectedPasswordResetRequest.contactNote || "未填写联系方式说明。" }}</p>
                <label>
                  <span>处理备注</span>
                  <input v-model="passwordResetHandleNote" data-testid="password-reset-handle-note" placeholder="如：已电话核验身份" />
                </label>
                <div class="role-permission-head__actions">
                  <button type="button" data-testid="password-reset-select-user" @click="selectManagedUser(selectedPasswordResetRequest.username)">选中该用户</button>
                  <button type="button" data-testid="password-reset-reject" @click="rejectPasswordResetRequestAction">驳回申请</button>
                </div>
              </section>
              <section v-if="recentPasswordResetNotifications.length" class="password-reset-admin-panel" data-testid="password-reset-notification-panel">
                <div class="password-reset-admin-panel__head">
                  <strong>最近通知</strong>
                  <div class="password-reset-notification-tools">
                    <select v-model="notificationStatusFilter" data-testid="notification-status-filter" @change="loadNotificationOutboxAction">
                      <option value="">全部</option>
                      <option value="FAILED">失败</option>
                      <option value="PENDING">待发送</option>
                      <option value="SENT">已发送</option>
                    </select>
                    <button type="button" data-testid="notification-refresh" @click="loadNotificationOutboxAction">刷新</button>
                    <span>{{ recentPasswordResetNotifications.length }} 条</span>
                  </div>
                </div>
                <div
                  v-for="notice in recentPasswordResetNotifications"
                  :key="notice.id"
                  class="password-reset-notice-row"
                  :data-testid="`password-reset-notice-${notice.recipientUsername}-${notice.templateCode}`"
                >
                  <strong>{{ notice.title }}</strong>
                  <span>{{ notice.recipientUsername }} / {{ notificationStatusLabel(notice) }} / {{ notificationReceiptLabel(notice) }} / 重试 {{ notice.retryCount ?? 0 }} 次 / {{ notice.sentAt || notice.lastAttemptAt || notice.createdAt }}</span>
                  <em>{{ notice.body }}</em>
                  <em v-if="notice.failureReason">失败原因：{{ notice.failureReason }}</em>
                  <div class="password-reset-notice-row__actions">
                    <button type="button" :data-testid="`notification-resend-${notice.recipientUsername}`" @click="resendNotificationAction(notice.id)">重发</button>
                    <button type="button" :data-testid="`notification-receipt-delivered-${notice.recipientUsername}`" @click="syncNotificationReceiptAction(notice.id, 'DELIVERED')">回执成功</button>
                    <button type="button" :data-testid="`notification-receipt-failed-${notice.recipientUsername}`" @click="syncNotificationReceiptAction(notice.id, 'FAILED')">回执失败</button>
                  </div>
                </div>
              </section>
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
                <button type="button" :disabled="userManagementMode === 'create' || !selectedManagedUser?.locked || !canManageRolePermissions" data-testid="managed-user-unlock" @click="unlockManagedUserAction">解除锁定</button>
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
          v-else-if="tabs.activeTab.value.kind === 'list' || tabs.activeTab.value.kind === 'report'"
          :list-key="tabs.activeTab.value.id"
          :locked="isLockedList"
          @push-down-sales-out="openOutboundFromSalesOrder"
          @push-down-purchase-in="openPurchaseInFromPurchaseOrder"
          @open-document="openDocumentFromList"
        />
        <SalesOrderForm
          v-else-if="isSalesOrderForm"
          ref="salesOrderFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="isLockedList"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = 'sales-order-form'"
          @request-open-document="openDocumentFromModule"
        />
        <SalesOutForm
          v-else-if="tabs.activeTab.value.id === outboundTabId"
          ref="outboundFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="false"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = outboundTabId"
          @request-open-document="openDocumentFromModule"
        />
        <PurchaseOrderForm
          v-else-if="tabs.activeTab.value.id === purchaseOrderTabId"
          ref="purchaseOrderFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="isLockedList"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = purchaseOrderTabId"
          @request-open-document="openDocumentFromModule"
        />
        <PurchaseInForm
          v-else-if="tabs.activeTab.value.id === purchaseInTabId"
          ref="purchaseInFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="isLockedList"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = purchaseInTabId"
          @request-open-document="openDocumentFromModule"
        />
        <MaterialIssueForm
          v-else-if="tabs.activeTab.value.id === materialIssueTabId"
          ref="materialIssueFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="isLockedList"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = materialIssueTabId"
          @request-open-document="openDocumentFromModule"
        />
        <ProductInForm
          v-else-if="tabs.activeTab.value.id === productInTabId"
          ref="productInFormRef"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-class="tabs.activeTab.value.kind"
          :locked="isLockedList"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :user-name="session.userName.value"
          :has-permission="session.hasPermission"
          @mark-dirty="markActiveDirty"
          @clear-dirty="clearActiveDirty"
          @show-existing="tabs.activeTabId.value = productInTabId"
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
    <PasswordChangeDialog ref="passwordChangeDialogRef" :password-policy="activePasswordPolicy" @changed="handlePasswordChanged" />
    <DocumentDialogs
      :pending-zero-entry-save="null"
      :zero-reason-options="zeroReasonOptions"
      :downstream-trace="null"
      :pending-risky-document-action="null"
      :pending-entry-paste="null"
      :pending-push-down="pendingPushDown"
      current-bill-no=""
      current-order-status-label=""
      red-reverse-bill-no=""
      risky-action-title=""
      risky-action-summary=""
      risky-action-impact=""
      risky-action-verb=""
      :entry-paste-conflicts-resolved="false"
      :push-confirm-ratio="pushConfirmRatio"
      :push-confirm-warehouse-code="pushConfirmWarehouseCode"
      :push-confirm-selection-summary="pushConfirmSelectionSummary"
      :all-push-down-lines-selected="allPushDownLinesSelected"
      :pending-push-down-total="pendingPushDownTotal"
      :push-confirm-error="pushConfirmError"
      :format-qty="formatQty"
      :format-amount="formatAmount"
      :zero-reason-test-id="pushConfirmQtyTestId"
      :downstream-type-label="downstreamTypeLabel"
      :backend-status-label="backendStatusLabel"
      :downstream-reverse-impact="downstreamReverseImpact"
      :downstream-red-reverse-impact="downstreamRedReverseImpact"
      :downstream-doc-test-id="downstreamDocTestId"
      :entry-paste-candidate-test-id="entryPasteCandidateTestId"
      :is-entry-paste-candidate-active="() => false"
      :push-confirm-select-test-id="pushConfirmSelectTestId"
      :push-confirm-warehouse-test-id="pushConfirmWarehouseTestId"
      :push-confirm-qty-test-id="pushConfirmQtyTestId"
      @cancel-zero-entry-save="noop"
      @confirm-zero-entry-save="noop"
      @close-downstream-trace="noop"
      @open-downstream-document="noop"
      @cancel-risky-document-action="noop"
      @confirm-risky-document-action="noop"
      @handle-entry-paste-conflict-keydown="noop"
      @select-entry-paste-candidate="noop"
      @cancel-pending-entry-paste="noop"
      @confirm-pending-entry-paste="noop"
      @update:push-confirm-ratio="pushConfirmRatio = $event"
      @update:push-confirm-warehouse-code="pushConfirmWarehouseCode = $event"
      @clear-push-down-qtys="clearPushDownQtys"
      @fill-all-remaining-qtys="fillAllRemainingQtys"
      @invert-push-down-selection="invertPushDownSelection"
      @apply-push-down-ratio="applyPushDownRatio"
      @apply-push-down-warehouse="applyPushDownWarehouse"
      @toggle-all-push-down-lines-from-event="toggleAllPushDownLinesFromEvent"
      @cancel-push-down="cancelPushDown"
      @confirm-push-down="confirmPushDown"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { featureScope } from "./featureScope";
import {
  defaultPrintTemplateForm,
  printTemplateDocumentTypes,
  zeroReasonOptions,
  type PendingPushDown,
  type PendingPushLine,
} from "./documentModel";
import { excludedModules, moduleCatalog } from "../modules/catalog";
import DataListPage from "../components/DataListPage.vue";
import DocumentDialogs from "../components/DocumentDialogs.vue";
import MaterialIssueForm from "../modules/production/material-issue/MaterialIssueForm.vue";
import ProductInForm from "../modules/production/product-in/ProductInForm.vue";
import PurchaseInForm from "../modules/purchase/purchase-in/PurchaseInForm.vue";
import PurchaseOrderForm from "../modules/purchase/purchase-order/PurchaseOrderForm.vue";
import SalesOrderForm from "../modules/sales/sales-order/SalesOrderForm.vue";
import SalesOutForm from "../modules/sales/sales-out/SalesOutForm.vue";
import LoginPage from "../modules/system/auth/LoginPage.vue";
import PasswordChangeDialog from "../modules/system/auth/PasswordChangeDialog.vue";
import SecuritySettingsPage from "../modules/system/security/SecuritySettingsPage.vue";
import { fetchDocumentDetail, fetchPrintTemplates, savePrintTemplate, type DocumentDetail, type DownstreamDocumentRef, type OpenableDocumentType, type PrintTemplateConfig } from "../services/documentApi";
import { fetchSalesOrderDetail } from "../services/salesOrderApi";
import { createManagedUser, fetchManagedUsers, fetchNotificationOutbox, fetchNotificationProviderSettings, fetchRolePermissions, fetchSystemSession, fetchSystemUsers, handlePasswordResetRequest, logoutSystemUser, resendNotification, resetManagedUserPassword, saveNotificationProviderSettings, saveRolePermissions, syncNotificationReceipt, unlockManagedUser, updateManagedUser, type ManagedRole, type ManagedUser, type NotificationOutboxItem, type NotificationProviderCode, type NotificationProviderSettings, type PasswordPolicySettings, type PasswordResetRequestItem, type PermissionCatalogItem, type RolePermissionMatrix, type SystemSession, type SystemUser } from "../services/systemApi";
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
const session = useSessionStore();
const tabs = useTabStore();
const preferences = usePreferenceStore();
const outboundTabId = "sales-out-form";
const outboundDocumentType = ("sales" + "Out") as OpenableDocumentType;
const purchaseOrderTabId = "purchase-order-form";
const purchaseInTabId = "purchase-in-form";
const materialIssueTabId = "material-issue-form";
const productInTabId = "product-in-form";
const salesOrderFormRef = ref<InstanceType<typeof SalesOrderForm> | null>(null);
const outboundFormRef = ref<InstanceType<typeof SalesOutForm> | null>(null);
const purchaseOrderFormRef = ref<InstanceType<typeof PurchaseOrderForm> | null>(null);
const purchaseInFormRef = ref<InstanceType<typeof PurchaseInForm> | null>(null);
const materialIssueFormRef = ref<InstanceType<typeof MaterialIssueForm> | null>(null);
const productInFormRef = ref<InstanceType<typeof ProductInForm> | null>(null);
const loginPageRef = ref<InstanceType<typeof LoginPage> | null>(null);
const passwordChangeDialogRef = ref<InstanceType<typeof PasswordChangeDialog> | null>(null);
const keyword = ref("");
const activeModuleName = ref("销售管理");
const modulePanelOpen = ref(false);
const suppressNavigationUntil = ref(0);
const formMessage = ref("");
const pendingPushDown = ref<PendingPushDown | null>(null);
const pushConfirmRatio = ref(50);
const pushConfirmWarehouseCode = ref("CK-001");
const pushConfirmError = ref("");
const highlightedSourceBillNo = ref("");
const highlightedSourceLineNo = ref<number | null>(null);
const printTemplates = ref<PrintTemplateConfig[]>([]);
const printTemplateEdited = ref(false);
const printTemplateMessage = ref("");
const rolePermissionMatrix = ref<RolePermissionMatrix | null>(null);
const selectedRoleCode = ref("ADMIN");
const rolePermissionDraft = ref<string[]>([]);
const rolePermissionMessage = ref("");
const notificationProviderSettings = ref<NotificationProviderSettings | null>(null);
const notificationProviderMessage = ref("");
const activePasswordPolicy = ref<PasswordPolicySettings>({
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSymbol: true
});
const notificationProviderForm = reactive<{
  currentPassword: string;
  providerCode: NotificationProviderCode;
  senderName: string;
  endpointUrl: string;
  webhookSecret: string;
  dryRun: boolean;
}>({
  currentPassword: "",
  providerCode: "LOCAL",
  senderName: "本地通知",
  endpointUrl: "",
  webhookSecret: "",
  dryRun: true
});
const managedUsers = ref<ManagedUser[]>([]);
const managedRoles = ref<ManagedRole[]>([]);
const passwordResetRequests = ref<PasswordResetRequestItem[]>([]);
const notificationOutbox = ref<NotificationOutboxItem[]>([]);
const notificationStatusFilter = ref("");
const selectedPasswordResetRequestId = ref("");
const passwordResetHandleNote = ref("");
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
const printTemplateForm = reactive<PrintTemplateConfig>({ ...defaultPrintTemplateForm });
const typedModuleCatalog = moduleCatalog as unknown as ShellModule[];
const typedExcludedModules = excludedModules as unknown as ShellModule[];
const visibleModules = [...typedModuleCatalog, ...typedExcludedModules];
const activeModule = computed(() => visibleModules.find((module) => module.name === activeModuleName.value) ?? typedModuleCatalog[0]);
const activeEntryGroups = computed(() => activeModule.value.groups
  .map((group) => ({ ...group, entries: group.entries.filter((entry) => canOpenEntry(entry)) }))
  .filter((group) => group.entries.length > 0));
const approvedCount = computed(() => featureScope.filter((feature) => feature.decision === "build" || feature.decision === "simple").length);
const quickEntries = computed(() => typedModuleCatalog.flatMap((module) => module.groups.flatMap((group) => group.entries)).filter((entry) => canOpenEntry(entry)).slice(0, 8));
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
const canManageSecuritySettings = computed(() => session.hasPermission("system.security.manage"));
const canManageNotificationProviderSettings = computed(() => session.hasPermission("system.notification_provider.manage"));
const selectedManagedUser = computed(() => managedUsers.value.find((user) => user.username === selectedManagedUsername.value) ?? null);
const pendingPasswordResetRequests = computed(() => passwordResetRequests.value.filter((request) => request.status === "PENDING"));
const selectedPasswordResetRequest = computed(() => passwordResetRequests.value.find((request) => request.id === selectedPasswordResetRequestId.value && request.status === "PENDING") ?? null);
const recentPasswordResetNotifications = computed(() => notificationOutbox.value.slice(0, 6));
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
    return `红冲将生成负数${"采购"}${"入库"}单，并回退源${"采购"}${"订单"}已入库数量 ${qty}。`;
  }
  return `红冲将生成负数销售${"出库"}单，并回退源销售订单已${"出库"}数量 ${qty}。`;
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
function downstreamDocTestId(index: number) {
  return index === 0 ? "downstream-doc-open" : `downstream-doc-open-${index + 1}`;
}
function entryPasteCandidateTestId(lineIndex: number, code: string) {
  return `entry-paste-candidate-${lineIndex + 1}-${code}`;
}
onMounted(async () => {
  installSessionExpiryInterceptor();
  window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  window.addEventListener("storage", handleSessionStorageEvent);
  window.addEventListener("focus", verifyActiveSession);
  systemUsers.value = await fetchSystemUsers();
  const remoteSession = await fetchSystemSession();
  if (remoteSession?.authenticated && remoteSession.user) {
    applySystemSession(remoteSession);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  window.removeEventListener("storage", handleSessionStorageEvent);
  window.removeEventListener("focus", verifyActiveSession);
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
  if (remoteSession.security?.passwordPolicy) {
    activePasswordPolicy.value = remoteSession.security.passwordPolicy;
  }
  loginPageRef.value?.setUsername(remoteSession.user.username || "");
  isAuthenticated.value = true;
}
async function handleLoginSuccess(remoteSession: SystemSession) {
  applySystemSession(remoteSession);
  if (tabs.activeTab.value.id === "role-permission-settings") {
    await loadRolePermissions();
  }
}
async function logoutCurrentUser() {
  await logoutSystemUser();
  clearLocalSession("已退出登录。", "logout");
}
function clearLocalSession(message: string, reason: SessionInvalidationReason = "session-expired", broadcast = true) {
  isAuthenticated.value = false;
  session.userName.value = "";
  session.userRole.value = "";
  session.userRoleCode.value = "";
  session.permissionCodes.value = [];
  loginPageRef.value?.clearPassword(message);
  passwordChangeDialogRef.value?.resetPasswordForm();
  tabs.activeTabId.value = "home";
  if (broadcast) {
    broadcastSessionInvalidation(reason, message);
  }
}
async function handlePasswordChanged() {
  await logoutSystemUser();
  clearLocalSession("密码已修改，请使用新密码重新登录。", "password-changed");
}
function handleSessionExpired() {
  clearLocalSession("登录已过期，请重新登录。", "session-expired");
}
const SESSION_EXPIRED_EVENT = "jdy:session-expired";
const SESSION_INVALIDATION_STORAGE_KEY = "jdy:session-invalidation";
type SessionInvalidationReason = "logout" | "password-changed" | "session-expired";
const publicSessionPaths = new Set(["/api/system/health", "/api/system/session", "/api/system/users", "/api/system/login", "/api/system/logout", "/api/system/password-reset-requests"]);
function broadcastSessionInvalidation(reason: SessionInvalidationReason, message: string) {
  try {
    localStorage.setItem(SESSION_INVALIDATION_STORAGE_KEY, JSON.stringify({
      reason,
      message,
      timestamp: Date.now()
    }));
  } catch {
    // localStorage can be unavailable in private contexts; local page cleanup still succeeded.
  }
}
function handleSessionStorageEvent(event: StorageEvent) {
  if (event.key !== SESSION_INVALIDATION_STORAGE_KEY || !event.newValue) {
    return;
  }
  try {
    const payload = JSON.parse(event.newValue) as { reason?: SessionInvalidationReason; message?: string };
    const message = payload.message || sessionInvalidationMessage(payload.reason);
    clearLocalSession(message, payload.reason ?? "session-expired", false);
  } catch {
    clearLocalSession("登录状态已变化，请重新登录。", "session-expired", false);
  }
}
async function verifyActiveSession() {
  if (!isAuthenticated.value) {
    return;
  }
  const remoteSession = await fetchSystemSession();
  if (!remoteSession?.authenticated || !remoteSession.user) {
    clearLocalSession("登录状态已失效，请重新登录。", "session-expired", false);
    return;
  }
  applySystemSession(remoteSession);
}
function sessionInvalidationMessage(reason?: SessionInvalidationReason) {
  if (reason === "logout") {
    return "其他标签页已退出登录。";
  }
  if (reason === "password-changed") {
    return "密码已在其他标签页修改，请重新登录。";
  }
  return "登录状态已变化，请重新登录。";
}
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
    void nextTick().then(() => startNewModuleDocument(entry.id));
  }
  if (opened && entry.id === "print-template-settings") {
    void loadPrintTemplates();
  }
  if (opened && entry.id === "role-permission-settings") {
    void loadRolePermissions();
  }
  if (opened && entry.id === "notification-provider-settings") {
    void loadNotificationProviderSettings();
  }
  if (opened && entry.id === "user-role-list") {
    void loadManagedUsers();
  }
  modulePanelOpen.value = false;
  suppressNavigationUntil.value = Date.now() + 250;
}
function startNewModuleDocument(entryId: string) {
  if (entryId === purchaseOrderTabId) {
    purchaseOrderFormRef.value?.startNew();
  } else if (entryId === purchaseInTabId) {
    purchaseInFormRef.value?.startNew();
  } else if (entryId === materialIssueTabId) {
    materialIssueFormRef.value?.startNew();
  } else if (entryId === productInTabId) {
    productInFormRef.value?.startNew();
  }
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
  passwordResetRequests.value = result.data.passwordResetRequests ?? [];
  notificationOutbox.value = result.data.notificationOutbox ?? [];
  if (!pendingPasswordResetRequests.value.some((request) => request.id === selectedPasswordResetRequestId.value)) {
    selectedPasswordResetRequestId.value = pendingPasswordResetRequests.value[0]?.id ?? "";
  }
  if (userManagementMode.value !== "create" && !managedUsers.value.some((user) => user.username === selectedManagedUsername.value)) {
    selectedManagedUsername.value = managedUsers.value[0]?.username ?? "";
  }
  if (selectedManagedUsername.value) {
    applySelectedManagedUser();
  }
  userManagementMessage.value = "";
}
async function loadNotificationOutboxAction() {
  const result = await fetchNotificationOutbox(notificationStatusFilter.value);
  if (!result.ok) {
    userManagementMessage.value = result.message;
    return;
  }
  notificationOutbox.value = result.data;
}
function selectManagedUser(username: string) {
  selectedManagedUsername.value = username;
  userManagementMode.value = "edit";
  applySelectedManagedUser();
  userManagementMessage.value = "";
  const pendingRequest = pendingPasswordResetRequests.value.find((request) => request.username === username);
  if (pendingRequest) {
    selectedPasswordResetRequestId.value = pendingRequest.id;
  }
}
function selectPasswordResetRequest(requestId: string) {
  selectedPasswordResetRequestId.value = requestId;
  const request = selectedPasswordResetRequest.value;
  if (request && managedUsers.value.some((user) => user.username === request.username)) {
    selectedManagedUsername.value = request.username;
    userManagementMode.value = "edit";
    applySelectedManagedUser();
  }
  passwordResetHandleNote.value = "";
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
function managedUserStateLabel(user: ManagedUser) {
  if (!user.enabled) {
    return "禁用";
  }
  if (user.locked) {
    return "已锁定";
  }
  return "启用";
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
  passwordResetRequests.value = result.data.passwordResetRequests ?? passwordResetRequests.value;
  notificationOutbox.value = result.data.notificationOutbox ?? notificationOutbox.value;
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
  await loadManagedUsers();
  userManagementMessage.value = "密码已重置，待处理找回申请已标记完成";
}
async function rejectPasswordResetRequestAction() {
  if (!canManageRolePermissions.value || !selectedPasswordResetRequest.value) {
    return;
  }
  const result = await handlePasswordResetRequest(selectedPasswordResetRequest.value.id, "REJECTED", passwordResetHandleNote.value || "身份核验未通过");
  if (!result.ok || !result.data) {
    userManagementMessage.value = result.message || "找回申请处理失败。";
    return;
  }
  managedUsers.value = result.data.users;
  managedRoles.value = result.data.roles;
  passwordResetRequests.value = result.data.passwordResetRequests ?? [];
  notificationOutbox.value = result.data.notificationOutbox ?? [];
  selectedPasswordResetRequestId.value = pendingPasswordResetRequests.value[0]?.id ?? "";
  passwordResetHandleNote.value = "";
  userManagementMessage.value = "找回申请已驳回";
}
async function resendNotificationAction(notificationId: string) {
  if (!canManageRolePermissions.value) {
    userManagementMessage.value = "当前角色无权维护通知。";
    return;
  }
  const result = await resendNotification(notificationId);
  if (!result.ok) {
    userManagementMessage.value = result.message || "通知重发失败。";
    return;
  }
  notificationStatusFilter.value = "";
  notificationOutbox.value = result.data;
  userManagementMessage.value = "通知已重发";
}
async function syncNotificationReceiptAction(notificationId: string, providerReceiptStatus: "DELIVERED" | "FAILED") {
  if (!canManageRolePermissions.value) {
    userManagementMessage.value = "当前角色无权维护通知。";
    return;
  }
  const result = await syncNotificationReceipt(notificationId, {
    providerReceiptStatus,
    failureReason: providerReceiptStatus === "FAILED" ? "本地供应商回执失败" : ""
  });
  if (!result.ok) {
    userManagementMessage.value = result.message || "通知回执同步失败。";
    return;
  }
  notificationStatusFilter.value = "";
  notificationOutbox.value = result.data;
  userManagementMessage.value = "通知回执已同步";
}
function notificationStatusLabel(notice: NotificationOutboxItem) {
  if (notice.status === "SENT") {
    return "已发送";
  }
  if (notice.status === "FAILED") {
    return "失败";
  }
  return "待发送";
}
function notificationReceiptLabel(notice: NotificationOutboxItem) {
  if (notice.providerReceiptStatus === "DELIVERED") {
    return `回执成功${notice.providerReceiptAt ? ` ${notice.providerReceiptAt}` : ""}`;
  }
  if (notice.providerReceiptStatus === "FAILED") {
    return `回执失败${notice.providerReceiptAt ? ` ${notice.providerReceiptAt}` : ""}`;
  }
  if (notice.providerReceiptStatus === "BOUNCED") {
    return `回执退回${notice.providerReceiptAt ? ` ${notice.providerReceiptAt}` : ""}`;
  }
  return "未回执";
}
async function unlockManagedUserAction() {
  if (!canManageRolePermissions.value || userManagementMode.value === "create" || !selectedManagedUser.value?.locked) {
    return;
  }
  const result = await unlockManagedUser(managedUserForm.username);
  if (!result.ok || !result.data) {
    userManagementMessage.value = result.message || "解除锁定失败。";
    return;
  }
  managedUsers.value = result.data.users;
  managedRoles.value = result.data.roles;
  passwordResetRequests.value = result.data.passwordResetRequests ?? passwordResetRequests.value;
  selectedManagedUsername.value = managedUserForm.username;
  applySelectedManagedUser();
  userManagementMessage.value = "账号锁定已解除";
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
async function loadNotificationProviderSettings() {
  const result = await fetchNotificationProviderSettings();
  if (!result.ok || !result.data) {
    notificationProviderMessage.value = result.message || "通知供应商设置加载失败。";
    return;
  }
  applyNotificationProviderSettings(result.data);
  notificationProviderMessage.value = "";
}
async function saveNotificationProviderSettingsAction() {
  if (!canManageNotificationProviderSettings.value) {
    notificationProviderMessage.value = "当前角色无权维护通知供应商。";
    return;
  }
  const result = await saveNotificationProviderSettings({
    currentPassword: notificationProviderForm.currentPassword,
    providerCode: notificationProviderForm.providerCode,
    senderName: notificationProviderForm.senderName,
    endpointUrl: notificationProviderForm.endpointUrl,
    webhookSecret: notificationProviderForm.webhookSecret,
    dryRun: notificationProviderForm.dryRun
  });
  if (!result.ok || !result.data) {
    notificationProviderMessage.value = result.message || "通知供应商设置保存失败。";
    return;
  }
  applyNotificationProviderSettings(result.data);
  notificationProviderForm.currentPassword = "";
  notificationProviderForm.webhookSecret = "";
  notificationProviderMessage.value = "通知供应商设置已保存";
}
function applyNotificationProviderSettings(settings: NotificationProviderSettings) {
  notificationProviderSettings.value = settings;
  notificationProviderForm.providerCode = settings.providerCode;
  notificationProviderForm.senderName = settings.senderName;
  notificationProviderForm.endpointUrl = settings.endpointUrl;
  notificationProviderForm.dryRun = settings.dryRun;
}
function notificationProviderLabel(providerCode: NotificationProviderCode) {
  if (providerCode === "SIMULATED_HTTP") {
    return "模拟 HTTP 供应商";
  }
  if (providerCode === "SIMULATED_SMTP") {
    return "模拟 SMTP 供应商";
  }
  return "本地通知";
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
  activeModuleName.value = target.module;
  await nextTick();
  target.ref.value?.applyDetail(result.data, `已打开${target.title} ${billNo}`);
  formMessage.value = `已打开${target.title} ${billNo}`;
  clearActiveDirty();
}
async function openDocumentFromModule(payload: { type: OpenableDocumentType; billNo: string; sourceLineNo?: number | null }) {
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
  activeModuleName.value = target.module;
  await nextTick();
  target.ref.value?.applyDetail(result.data, payload.sourceLineNo ? `已追踪打开${target.title} ${payload.billNo}，定位到第 ${payload.sourceLineNo} 行` : `已打开${target.title} ${payload.billNo}`, payload.sourceLineNo ?? null);
  highlightedSourceBillNo.value = payload.billNo;
  highlightedSourceLineNo.value = payload.sourceLineNo ?? null;
  scrollHighlightedSourceLineIntoView();
  formMessage.value = payload.sourceLineNo ? `已追踪打开${target.title} ${payload.billNo}，定位到第 ${payload.sourceLineNo} 行` : `已打开${target.title} ${payload.billNo}`;
  clearActiveDirty();
}
function openableDocumentTarget(type: OpenableDocumentType): { tabId: string; title: string; module: string; ref: { value: { applyDetail: (detail: DocumentDetail, message?: string, sourceLineNo?: number | null) => void } | null } } {
  switch (type) {
    case "purchaseOrder":
      return { tabId: purchaseOrderTabId, title: "采购订单", module: "采购管理", ref: purchaseOrderFormRef };
    case "purchaseIn":
      return { tabId: purchaseInTabId, title: "采购入库单", module: "采购管理", ref: purchaseInFormRef };
    case "materialIssue":
      return { tabId: materialIssueTabId, title: "生产领料单", module: "生产管理", ref: materialIssueFormRef };
    case "productIn":
      return { tabId: productInTabId, title: "产品入库单", module: "生产管理", ref: productInFormRef };
    case "salesOrder":
    default:
      return { tabId: "sales-order-form", title: "销售订单", module: "销售管理", ref: salesOrderFormRef };
  }
}
async function openOutboundFromSalesOrder(row: Record<string, unknown>) {
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
    kind: outboundDocumentType as PendingPushDown["kind"],
    title: "销售" + "出库下推确认",
    targetTitle: "销售" + "出库单",
    targetTabId: outboundTabId,
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
async function confirmPushDown() {
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
  if (pending.kind === outboundDocumentType) {
    tabs.openTab({
      id: pending.targetTabId,
      title: pending.targetTitle,
      module: pending.targetModule,
      kind: "form",
      dirty: true
    });
    activeModuleName.value = pending.targetModule;
    await nextTick();
    outboundFormRef.value?.applyPushDownDraft({
      billNo: pending.targetBillNo,
      sourceOrderNo: pending.sourceBillNo,
      partyCode: pending.partyCode,
      billDate: pending.billDate,
      department: pending.department,
      ownerName: pending.ownerName,
      lines: selectedLines
    });
    pendingPushDown.value = null;
    pushConfirmError.value = "";
    formMessage.value = `已由${pending.sourceBillNo}按确认数量生成${pending.targetTitle}草稿`;
    return;
  }
  tabs.openTab({
    id: pending.targetTabId,
    title: pending.targetTitle,
    module: pending.targetModule,
    kind: "form",
    dirty: true
  });
  activeModuleName.value = pending.targetModule;
  await nextTick();
  purchaseInFormRef.value?.applyPushDownDraft({
    billNo: pending.targetBillNo,
    sourceOrderNo: pending.sourceBillNo,
    partyCode: pending.partyCode,
    billDate: pending.billDate,
    department: pending.department,
    ownerName: pending.ownerName,
    lines: selectedLines
  });
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
    formMessage.value = result.message || `${"采购"}${"订单"}详情加载失败。`;
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
    formMessage.value = `${"采购"}${"订单"} ${sourceBillNo} 已无剩余可入数量`;
    return;
  }
  pendingPushDown.value = {
    kind: "purchaseIn",
    title: `${"采购"}${"入库"}下推确认`,
    targetTitle: `${"采购"}${"入库"}单`,
    targetTabId: purchaseInTabId,
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
  formMessage.value = `请确认${"采购"}${"订单"} ${sourceBillNo} 本次下推数量`;
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
// app form modules own document state now
</script>
