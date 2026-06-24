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
      <button class="text-action" type="button" data-testid="forgot-password-open" @click="openPasswordResetRequestDialog">忘记密码</button>
      <p v-if="loginMessage" class="login-message" data-testid="login-message">{{ loginMessage }}</p>
    </form>
    <div v-if="passwordResetRequestDialogOpen" class="modal-mask" data-testid="password-reset-request-dialog">
      <form class="dialog password-dialog" @submit.prevent="submitPasswordResetRequest">
        <h3>找回密码</h3>
        <label>
          <span>账号</span>
          <input v-model="passwordResetRequestForm.username" data-testid="password-reset-username" autocomplete="username" />
        </label>
        <label>
          <span>联系方式/说明</span>
          <input v-model="passwordResetRequestForm.contactNote" data-testid="password-reset-contact" placeholder="手机号、班组或交接说明" />
        </label>
        <p v-if="passwordResetRequestMessage" class="form-message" data-testid="password-reset-message">{{ passwordResetRequestMessage }}</p>
        <div class="dialog-actions">
          <button type="button" data-testid="password-reset-cancel" @click="closePasswordResetRequestDialog">取消</button>
          <button class="primary-action" type="submit" data-testid="password-reset-submit">提交申请</button>
        </div>
      </form>
    </div>
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

        <div v-else-if="tabs.activeTab.value.kind === 'shell' && !['print-template-settings', 'role-permission-settings', 'user-role-list', 'security-settings', 'notification-provider-settings'].includes(tabs.activeTab.value.id)" class="panel-page">
          <h2>{{ tabs.activeTab.value.title }}</h2>
          <div class="empty-shell">首版范围裁剪：该入口仅保留壳层，不进入深层业务页。</div>
        </div>

        <div v-else-if="tabs.activeTab.value.id === 'security-settings'" class="role-permission-page">
          <section class="role-permission-head">
            <div>
              <h2>安全设置</h2>
              <p>维护登录安全策略，影响同账号在多个浏览器或设备上的在线方式。</p>
            </div>
            <div class="role-permission-head__actions">
              <button type="button" data-testid="security-settings-refresh" @click="loadSecuritySettings">刷新</button>
              <button class="primary-action" type="button" :disabled="!canManageSecuritySettings" data-testid="security-settings-save" @click="saveSecuritySettingsAction">保存</button>
            </div>
          </section>
          <section class="role-permission-body">
            <aside class="role-permission-list" aria-label="安全策略">
              <button
                type="button"
                :class="{ active: securitySettingsForm.repeatedLoginPolicy === 'SINGLE_ACTIVE' }"
                data-testid="security-policy-single-active"
                @click="securitySettingsForm.repeatedLoginPolicy = 'SINGLE_ACTIVE'"
              >
                <strong>后登录踢下线</strong>
                <span>同账号只保留一个活动会话</span>
              </button>
              <button
                type="button"
                :class="{ active: securitySettingsForm.repeatedLoginPolicy === 'ALLOW_CONCURRENT' }"
                data-testid="security-policy-allow-concurrent"
                @click="securitySettingsForm.repeatedLoginPolicy = 'ALLOW_CONCURRENT'"
              >
                <strong>允许多端同时在线</strong>
                <span>重复登录不踢旧会话，改密仍全部失效</span>
              </button>
            </aside>
            <form class="user-management-form" @submit.prevent="saveSecuritySettingsAction">
              <div class="role-permission-summary" data-testid="security-settings-summary">
                <strong>{{ securityPolicyLabel(securitySettingsForm.repeatedLoginPolicy) }}</strong>
                <span>{{ securitySettingsForm.repeatedLoginPolicy }}</span>
                <em>{{ securitySettings?.repeatedLoginPolicyLabel || "等待加载" }}</em>
              </div>
              <label>
                <span>重复登录策略</span>
                <select v-model="securitySettingsForm.repeatedLoginPolicy" data-testid="security-repeated-login-policy">
                  <option value="SINGLE_ACTIVE">后登录踢下线旧会话</option>
                  <option value="ALLOW_CONCURRENT">允许同账号多端同时在线</option>
                </select>
              </label>
              <label>
                <span>会话超时（分钟）</span>
                <input
                  ref="securitySessionTimeoutInput"
                  v-model.number="securitySettingsForm.sessionTimeoutMinutes"
                  data-testid="security-session-timeout-minutes"
                  type="number"
                  min="5"
                  max="480"
                  step="1"
                  @change="updateSecuritySessionTimeout"
                />
              </label>
              <label>
                <span>密码最小长度</span>
                <input
                  ref="securityPasswordMinLengthInput"
                  v-model.number="securitySettingsForm.passwordMinLength"
                  data-testid="security-password-min-length"
                  type="number"
                  min="6"
                  max="64"
                  step="1"
                  @change="updateSecurityPasswordMinLength"
                />
              </label>
              <div class="security-toggle-grid" data-testid="security-password-policy-toggles">
                <label>
                  <input v-model="securitySettingsForm.passwordRequireUppercase" type="checkbox" data-testid="security-password-require-uppercase" />
                  <span>大写字母</span>
                </label>
                <label>
                  <input v-model="securitySettingsForm.passwordRequireLowercase" type="checkbox" data-testid="security-password-require-lowercase" />
                  <span>小写字母</span>
                </label>
                <label>
                  <input v-model="securitySettingsForm.passwordRequireDigit" type="checkbox" data-testid="security-password-require-digit" />
                  <span>数字</span>
                </label>
                <label>
                  <input v-model="securitySettingsForm.passwordRequireSymbol" type="checkbox" data-testid="security-password-require-symbol" />
                  <span>符号</span>
                </label>
              </div>
              <label>
                <span>当前管理员密码</span>
                <input
                  v-model="securitySettingsForm.currentPassword"
                  data-testid="security-current-password"
                  type="password"
                  autocomplete="current-password"
                />
              </label>
              <dl class="user-security-summary">
                <div>
                  <dt>当前生效</dt>
                  <dd data-testid="security-current-policy">{{ securitySettings?.repeatedLoginPolicy || "-" }}</dd>
                </div>
                <div>
                  <dt>会话超时</dt>
                  <dd data-testid="security-current-timeout">{{ securitySettings ? `${securitySettings.sessionTimeoutMinutes} 分钟` : "-" }}</dd>
                </div>
                <div>
                  <dt>密码策略</dt>
                  <dd data-testid="security-current-password-policy">{{ securitySettings ? passwordPolicySummary(securitySettings.passwordPolicy) : "-" }}</dd>
                </div>
                <div>
                  <dt>改密处理</dt>
                  <dd>无论策略如何，改密后旧会话全部失效</dd>
                </div>
              </dl>
              <p v-if="securitySettingsMessage" class="form-message" data-testid="security-settings-message">{{ securitySettingsMessage }}</p>
            </form>
          </section>
        </div>

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
                <input v-model="printTemplateForm.templateName" data-testid="print-template-name" />
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
                <input v-model="printTemplateForm.companyName" data-testid="print-template-company" />
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
          @push-down-sales-out="openSalesOutFromSalesOrder"
          @push-down-purchase-in="openPurchaseInFromPurchaseOrder"
          @open-document="openDocumentFromList"
        />

        <SalesOrderForm
          v-else-if="isSalesOrderForm"
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-label="currentOrderStatusLabel"
          :status-class="tabs.activeTab.value.kind"
          :locked="isLockedList"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :message="formMessage"
          :form="salesOrderDocument.form"
          :is-draft="isDraftDocument"
          :can-audit="canAuditCurrentDocument"
          :can-reverse="canReverseDocument"
          :can-void="canVoidDocument"
          :can-delete="canDeleteSalesOrder"
          :show-execution-columns="showExecutionColumns"
          :entry-table-colspan="entryTableColspan"
          :entry-total-colspan="entryTotalColspan"
          :total-amount="currentOrderTotal"
          :batch-warehouse-code="batchWarehouseCode"
          :active-selector="activeSelector"
          :selector-options="selectorOptions"
          :selector-cursor-index="selectorCursorIndex"
          :known-product-options="knownProductOptions"
          :dragging-line-index="draggingLineIndex"
          :highlighted-source-bill-no="highlightedSourceBillNo"
          :highlighted-source-line-no="highlightedSourceLineNo"
          @create="startNewCurrentDocument"
          @save="saveCurrentDocument"
          @audit="auditCurrentDocument"
          @reverse="openRiskyDocumentAction('reverse')"
          @red-reverse="openRiskyDocumentAction('redReverse')"
          @void-document="voidCurrentDocument"
          @delete-document="deleteCurrentSalesOrder"
          @export-document="exportCurrentDocument"
          @print-document="printCurrentDocument"
          @show-existing="tabs.activeTabId.value = 'sales-order-form'"
          @open-red-reverse-bill="openRedReverseBill"
          @open-red-source-bill="openRedSourceBill"
          @update:batch-warehouse-code="batchWarehouseCode = $event"
          @apply-batch-warehouse="applyBatchWarehouse"
          @mark-dirty="markActiveDirty"
          @search-master-options="searchMasterOptions"
          @handle-master-input="handleMasterInput"
          @handle-selector-keydown="handleSelectorKeydown"
          @select-party-option="selectPartyOption"
          @select-line-product="selectLineProduct"
          @select-warehouse-option="selectWarehouseOption"
          @entry-paste="handleEntryPaste"
          @trace-source-order="traceSourceOrder"
          @open-downstream-trace="openDownstreamTrace"
          @line-drag-start="handleLineDragStart"
          @line-drag-over="handleLineDragOver"
          @line-drop="handleLineDrop"
          @line-drag-end="handleLineDragEnd"
          @insert-line-after="insertLineAfter"
          @remove-line="removeLine"
          @copy-line="copyLine"
          @add-line="addLine"
        />

        <DocumentForm
          v-else
          :title="tabs.activeTab.value.title"
          :subtitle="pageSubtitle"
          :status-label="currentOrderStatusLabel"
          :status-class="tabs.activeTab.value.kind"
          :locked="isLockedList"
          :dirty="Boolean(tabs.activeTab.value.dirty)"
          :message="formMessage"
          :form="currentOrderForm"
          :test-prefix="formTestPrefix"
          :party-label="partyLabel"
          :party-type="partyType"
          :is-document-form="isDocumentForm"
          :is-stock-document-form="isStockDocumentForm"
          :is-draft="isDraftDocument"
          :can-audit="canAuditCurrentDocument"
          :can-reverse="canReverseDocument"
          :can-void="canVoidDocument"
          :can-delete="canDeleteSalesOrder"
          :can-trace-source-order="canTraceSourceOrder"
          :show-source-line-column="showSourceLineColumn"
          :show-execution-columns="showExecutionColumns"
          :entry-table-colspan="entryTableColspan"
          :entry-total-colspan="entryTotalColspan"
          :total-amount="currentOrderTotal"
          :batch-warehouse-code="batchWarehouseCode"
          :active-selector="activeSelector"
          :selector-options="selectorOptions"
          :selector-cursor-index="selectorCursorIndex"
          :known-product-options="knownProductOptions"
          :dragging-line-index="draggingLineIndex"
          :highlighted-source-bill-no="highlightedSourceBillNo"
          :highlighted-source-line-no="highlightedSourceLineNo"
          @create="startNewCurrentDocument"
          @save="saveCurrentDocument"
          @audit="auditCurrentDocument"
          @reverse="openRiskyDocumentAction('reverse')"
          @red-reverse="openRiskyDocumentAction('redReverse')"
          @void-document="voidCurrentDocument"
          @delete-document="deleteCurrentSalesOrder"
          @export-document="exportCurrentDocument"
          @print-document="printCurrentDocument"
          @show-existing="tabs.activeTabId.value = 'sales-order-form'"
          @open-red-reverse-bill="openRedReverseBill"
          @open-red-source-bill="openRedSourceBill"
          @update:batch-warehouse-code="batchWarehouseCode = $event"
          @apply-batch-warehouse="applyBatchWarehouse"
          @mark-dirty="markActiveDirty"
          @search-master-options="searchMasterOptions"
          @handle-master-input="handleMasterInput"
          @handle-selector-keydown="handleSelectorKeydown"
          @select-party-option="selectPartyOption"
          @select-line-product="selectLineProduct"
          @select-warehouse-option="selectWarehouseOption"
          @entry-paste="handleEntryPaste"
          @trace-source-order="traceSourceOrder"
          @open-downstream-trace="openDownstreamTrace"
          @line-drag-start="handleLineDragStart"
          @line-drag-over="handleLineDragOver"
          @line-drop="handleLineDrop"
          @line-drag-end="handleLineDragEnd"
          @insert-line-after="insertLineAfter"
          @remove-line="removeLine"
          @copy-line="copyLine"
          @add-line="addLine"
        />

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

    <DocumentDialogs
      :pending-zero-entry-save="pendingZeroEntrySave"
      :zero-reason-options="zeroReasonOptions"
      :downstream-trace="downstreamTrace"
      :pending-risky-document-action="pendingRiskyDocumentAction"
      :pending-entry-paste="pendingEntryPaste"
      :pending-push-down="pendingPushDown"
      :current-bill-no="currentOrderForm.billNo"
      :current-order-status-label="currentOrderStatusLabel"
      :red-reverse-bill-no="redReverseBillNo"
      :risky-action-title="riskyActionTitle"
      :risky-action-summary="riskyActionSummary"
      :risky-action-impact="riskyActionImpact"
      :risky-action-verb="riskyActionVerb"
      :entry-paste-conflicts-resolved="entryPasteConflictsResolved"
      :push-confirm-ratio="pushConfirmRatio"
      :push-confirm-warehouse-code="pushConfirmWarehouseCode"
      :push-confirm-selection-summary="pushConfirmSelectionSummary"
      :all-push-down-lines-selected="allPushDownLinesSelected"
      :pending-push-down-total="pendingPushDownTotal"
      :push-confirm-error="pushConfirmError"
      :format-qty="formatQty"
      :format-amount="formatAmount"
      :zero-reason-test-id="zeroReasonTestId"
      :downstream-type-label="downstreamTypeLabel"
      :backend-status-label="backendStatusLabel"
      :downstream-reverse-impact="downstreamReverseImpact"
      :downstream-red-reverse-impact="downstreamRedReverseImpact"
      :downstream-doc-test-id="downstreamDocTestId"
      :entry-paste-candidate-test-id="entryPasteCandidateTestId"
      :is-entry-paste-candidate-active="isEntryPasteCandidateActive"
      :push-confirm-select-test-id="pushConfirmSelectTestId"
      :push-confirm-warehouse-test-id="pushConfirmWarehouseTestId"
      :push-confirm-qty-test-id="pushConfirmQtyTestId"
      @cancel-zero-entry-save="cancelZeroEntrySave"
      @confirm-zero-entry-save="confirmZeroEntrySave"
      @close-downstream-trace="downstreamTrace = null"
      @open-downstream-document="openDownstreamDocument"
      @cancel-risky-document-action="cancelRiskyDocumentAction"
      @confirm-risky-document-action="confirmRiskyDocumentAction"
      @handle-entry-paste-conflict-keydown="handleEntryPasteConflictKeydown"
      @select-entry-paste-candidate="selectEntryPasteCandidate"
      @cancel-pending-entry-paste="cancelPendingEntryPaste"
      @confirm-pending-entry-paste="confirmPendingEntryPaste"
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
  initialMaterialIssueForm,
  initialProductInForm,
  initialPurchaseInForm,
  initialPurchaseOrderForm,
  initialSalesOutForm,
  knownProductOptions,
  knownWarehouseOptions,
  printTemplateDocumentTypes,
  zeroReasonOptions,
  type DownstreamTraceState,
  type EntryPasteConflict,
  type EntryPasteRefs,
  type MasterOption,
  type OrderForm,
  type OrderLineForm,
  type PendingEntryPaste,
  type PendingPushDown,
  type PendingPushLine,
  type PendingZeroEntrySave,
  type RiskyDocumentAction,
  type ZeroEntryWarning
} from "./documentModel";
import { excludedModules, moduleCatalog } from "../modules/catalog";
import DataListPage from "../components/DataListPage.vue";
import DocumentDialogs from "../components/DocumentDialogs.vue";
import DocumentForm from "../components/DocumentForm.vue";
import SalesOrderForm from "../modules/sales/sales-order/SalesOrderForm.vue";
import { useSalesOrderDocument } from "../modules/sales/sales-order/useSalesOrderDocument";
import { auditDocument, exportDocument, fetchDocumentDetail, fetchPrintTemplates, printDocument, redReverseDocument, reverseDocument, saveDocumentDraft, savePrintTemplate, voidDocument, type DocumentDetail, type DocumentType, type DownstreamDocumentRef, type OpenableDocumentType, type OutputDocumentType, type PrintTemplateConfig } from "../services/documentApi";
import { fetchListRows } from "../services/listApi";
import { fetchSalesOrderDetail } from "../services/salesOrderApi";
import { changeSystemPassword, createManagedUser, fetchManagedUsers, fetchNotificationOutbox, fetchNotificationProviderSettings, fetchRolePermissions, fetchSecuritySettings, fetchSystemSession, fetchSystemUsers, handlePasswordResetRequest, loginSystemUser, logoutSystemUser, requestPasswordReset, resendNotification, resetManagedUserPassword, saveNotificationProviderSettings, saveRolePermissions, saveSecuritySettings, syncNotificationReceipt, unlockManagedUser, updateManagedUser, type ManagedRole, type ManagedUser, type NotificationOutboxItem, type NotificationProviderCode, type NotificationProviderSettings, type PasswordPolicySettings, type PasswordResetRequestItem, type PermissionCatalogItem, type RepeatedLoginPolicy, type RolePermissionMatrix, type SecuritySettings, type SystemSession, type SystemUser } from "../services/systemApi";
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

interface PreparedEntryLines {
  formLines: OrderLineForm[];
  documentLines: ReturnType<typeof toDocumentLines>;
  removedBlankCount: number;
}

const session = useSessionStore();
const tabs = useTabStore();
const preferences = usePreferenceStore();
const salesOrderDocument = useSalesOrderDocument();
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
const securitySettings = ref<SecuritySettings | null>(null);
const securitySettingsMessage = ref("");
const notificationProviderSettings = ref<NotificationProviderSettings | null>(null);
const notificationProviderMessage = ref("");
const securitySessionTimeoutInput = ref<HTMLInputElement | null>(null);
const securityPasswordMinLengthInput = ref<HTMLInputElement | null>(null);
const activePasswordPolicy = ref<PasswordPolicySettings>({
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
  requireSymbol: true
});
const securitySettingsForm = reactive<{
  currentPassword: string;
  repeatedLoginPolicy: RepeatedLoginPolicy;
  sessionTimeoutMinutes: number;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSymbol: boolean;
}>({
  currentPassword: "",
  repeatedLoginPolicy: "SINGLE_ACTIVE",
  sessionTimeoutMinutes: 30,
  passwordMinLength: 8,
  passwordRequireUppercase: true,
  passwordRequireLowercase: true,
  passwordRequireDigit: true,
  passwordRequireSymbol: true
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
const loginForm = reactive({
  username: "admin",
  password: ""
});
const loginMessage = ref("");
const passwordResetRequestDialogOpen = ref(false);
const passwordResetRequestMessage = ref("");
const passwordResetRequestForm = reactive({
  username: "admin",
  contactNote: ""
});
const passwordDialogOpen = ref(false);
const passwordMessage = ref("");
const passwordForm = reactive({
  currentPassword: "",
  newPassword: "",
  confirmPassword: ""
});
const printTemplateForm = reactive<PrintTemplateConfig>({ ...defaultPrintTemplateForm });
const purchaseOrderForm = reactive<OrderForm>({ ...initialPurchaseOrderForm, lines: initialPurchaseOrderForm.lines.map((line) => ({ ...line })) });
const purchaseInForm = reactive<OrderForm>({ ...initialPurchaseInForm, lines: initialPurchaseInForm.lines.map((line) => ({ ...line })) });
const salesOutForm = reactive<OrderForm>({ ...initialSalesOutForm, lines: initialSalesOutForm.lines.map((line) => ({ ...line })) });
const materialIssueForm = reactive<OrderForm>({ ...initialMaterialIssueForm, lines: initialMaterialIssueForm.lines.map((line) => ({ ...line })) });
const productInForm = reactive<OrderForm>({ ...initialProductInForm, lines: initialProductInForm.lines.map((line) => ({ ...line })) });
const activeSelector = ref("");
const selectorOptions = ref<MasterOption[]>([]);
const selectorCursorIndex = ref(0);
let selectorRequestSeq = 0;

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
const passwordStrengthRules = computed(() => passwordPolicyRules(activePasswordPolicy.value, passwordForm.newPassword));
const passwordStrengthOk = computed(() => passwordStrengthRules.value.every((rule) => rule.ok));
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
  return salesOrderDocument.form;
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
  loginForm.username = remoteSession.user.username || loginForm.username;
  isAuthenticated.value = true;
  loginMessage.value = "";
}

async function loginCurrentUser() {
  loginMessage.value = "";
  const loginResult = await loginSystemUser(loginForm.username, loginForm.password);
  const remoteSession = loginResult.session;
  if (!loginResult.ok || !remoteSession?.authenticated || !remoteSession.user) {
    loginMessage.value = loginResult.message || "账号或密码不正确";
    return;
  }
  applySystemSession(remoteSession);
  loginForm.password = "";
  if (tabs.activeTab.value.id === "role-permission-settings") {
    await loadRolePermissions();
  }
}

function openPasswordResetRequestDialog() {
  passwordResetRequestForm.username = loginForm.username;
  passwordResetRequestForm.contactNote = "";
  passwordResetRequestMessage.value = "";
  passwordResetRequestDialogOpen.value = true;
}

function closePasswordResetRequestDialog() {
  passwordResetRequestDialogOpen.value = false;
  passwordResetRequestMessage.value = "";
}

async function submitPasswordResetRequest() {
  passwordResetRequestMessage.value = "";
  const result = await requestPasswordReset({
    username: passwordResetRequestForm.username,
    contactNote: passwordResetRequestForm.contactNote
  });
  passwordResetRequestMessage.value = result.message || (result.ok ? "已提交找回申请。" : "找回申请提交失败。");
  if (result.ok) {
    loginMessage.value = passwordResetRequestMessage.value;
    passwordResetRequestForm.contactNote = "";
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
  loginForm.password = "";
  loginMessage.value = message;
  passwordDialogOpen.value = false;
  resetPasswordForm();
  tabs.activeTabId.value = "home";
  if (broadcast) {
    broadcastSessionInvalidation(reason, message);
  }
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
    startNewCurrentDocument();
  }
  if (opened && entry.id === "print-template-settings") {
    void loadPrintTemplates();
  }
  if (opened && entry.id === "role-permission-settings") {
    void loadRolePermissions();
  }
  if (opened && entry.id === "security-settings") {
    void loadSecuritySettings();
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

async function loadSecuritySettings() {
  const result = await fetchSecuritySettings();
  if (!result.ok || !result.data) {
    securitySettingsMessage.value = result.message || "安全设置加载失败。";
    return;
  }
  securitySettings.value = result.data;
  securitySettingsForm.repeatedLoginPolicy = result.data.repeatedLoginPolicy;
  securitySettingsForm.sessionTimeoutMinutes = result.data.sessionTimeoutMinutes;
  applyPasswordPolicyToSecurityForm(result.data.passwordPolicy);
  activePasswordPolicy.value = result.data.passwordPolicy;
  securitySettingsMessage.value = "";
}

async function saveSecuritySettingsAction() {
  if (!canManageSecuritySettings.value) {
    securitySettingsMessage.value = "当前角色无权维护安全设置。";
    return;
  }
  syncSecuritySessionTimeoutInput();
  syncSecurityPasswordMinLengthInput();
  const result = await saveSecuritySettings({
    currentPassword: securitySettingsForm.currentPassword,
    repeatedLoginPolicy: securitySettingsForm.repeatedLoginPolicy,
    sessionTimeoutMinutes: securitySettingsForm.sessionTimeoutMinutes,
    passwordMinLength: securitySettingsForm.passwordMinLength,
    passwordRequireUppercase: securitySettingsForm.passwordRequireUppercase,
    passwordRequireLowercase: securitySettingsForm.passwordRequireLowercase,
    passwordRequireDigit: securitySettingsForm.passwordRequireDigit,
    passwordRequireSymbol: securitySettingsForm.passwordRequireSymbol
  });
  if (!result.ok || !result.data) {
    securitySettingsMessage.value = result.message || "安全设置保存失败。";
    return;
  }
  securitySettings.value = result.data;
  securitySettingsForm.repeatedLoginPolicy = result.data.repeatedLoginPolicy;
  securitySettingsForm.sessionTimeoutMinutes = result.data.sessionTimeoutMinutes;
  applyPasswordPolicyToSecurityForm(result.data.passwordPolicy);
  activePasswordPolicy.value = result.data.passwordPolicy;
  securitySettingsForm.currentPassword = "";
  securitySettingsMessage.value = "安全设置已保存";
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

function securityPolicyLabel(policy: RepeatedLoginPolicy) {
  return policy === "ALLOW_CONCURRENT" ? "允许多端同时在线" : "后登录踢下线旧会话";
}

function updateSecuritySessionTimeout(event: Event) {
  securitySettingsForm.sessionTimeoutMinutes = normalizeSecuritySessionTimeout((event.target as HTMLInputElement).value);
}

function syncSecuritySessionTimeoutInput() {
  securitySettingsForm.sessionTimeoutMinutes = normalizeSecuritySessionTimeout(
    document.querySelector<HTMLInputElement>("[data-testid='security-session-timeout-minutes']")?.value
      ?? securitySessionTimeoutInput.value?.value
      ?? securitySettingsForm.sessionTimeoutMinutes
  );
}

function normalizeSecuritySessionTimeout(rawValue: string | number) {
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : 30;
}

function updateSecurityPasswordMinLength(event: Event) {
  securitySettingsForm.passwordMinLength = normalizeSecurityPasswordMinLength((event.target as HTMLInputElement).value);
}

function syncSecurityPasswordMinLengthInput() {
  securitySettingsForm.passwordMinLength = normalizeSecurityPasswordMinLength(
    document.querySelector<HTMLInputElement>("[data-testid='security-password-min-length']")?.value
      ?? securityPasswordMinLengthInput.value?.value
      ?? securitySettingsForm.passwordMinLength
  );
}

function normalizeSecurityPasswordMinLength(rawValue: string | number) {
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : 8;
}

function applyPasswordPolicyToSecurityForm(policy: PasswordPolicySettings) {
  securitySettingsForm.passwordMinLength = policy.minLength;
  securitySettingsForm.passwordRequireUppercase = policy.requireUppercase;
  securitySettingsForm.passwordRequireLowercase = policy.requireLowercase;
  securitySettingsForm.passwordRequireDigit = policy.requireDigit;
  securitySettingsForm.passwordRequireSymbol = policy.requireSymbol;
}

function passwordPolicyRules(policy: PasswordPolicySettings, password: string) {
  const rules = [{ label: `至少 ${policy.minLength} 位`, ok: password.length >= policy.minLength }];
  if (policy.requireUppercase) {
    rules.push({ label: "大写字母", ok: /[A-Z]/.test(password) });
  }
  if (policy.requireLowercase) {
    rules.push({ label: "小写字母", ok: /[a-z]/.test(password) });
  }
  if (policy.requireDigit) {
    rules.push({ label: "数字", ok: /\d/.test(password) });
  }
  if (policy.requireSymbol) {
    rules.push({ label: "符号", ok: /[^A-Za-z0-9]/.test(password) });
  }
  return rules;
}

function passwordPolicySummary(policy: PasswordPolicySettings) {
  const parts = [`至少 ${policy.minLength} 位`];
  if (policy.requireUppercase) {
    parts.push("大写");
  }
  if (policy.requireLowercase) {
    parts.push("小写");
  }
  if (policy.requireDigit) {
    parts.push("数字");
  }
  if (policy.requireSymbol) {
    parts.push("符号");
  }
  return parts.join(" / ");
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

async function saveCurrentSalesOrder() {
  await saveCurrentSalesOrderDraft(false);
}

async function saveCurrentSalesOrderDraft(allowZeroValues: boolean) {
  if (!allowZeroValues) {
    pendingZeroEntrySave.value = null;
  }
  formMessage.value = "";
  const preparedLines = prepareEntryLinesForSave(salesOrderDocument.form.lines);
  if (!preparedLines.ok) {
    formMessage.value = preparedLines.message;
    return;
  }
  const zeroWarnings = zeroEntryWarnings(preparedLines.formLines);
  if (!allowZeroValues && zeroWarnings.length > 0) {
    pendingZeroEntrySave.value = { target: "salesOrder", warnings: zeroWarnings };
    return;
  }
  const result = await salesOrderDocument.saveDraft(preparedLines);
  formMessage.value = result.ok ? saveSuccessMessage(preparedLines.removedBlankCount, allowZeroValues ? zeroWarnings.length : 0) : result.message;
  if (result.ok) {
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
  const type = currentOpenableDocumentType();
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
  const type = currentOpenableDocumentType();
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
      return { tabId: "sales-order-form", title: "销售订单", module: "销售管理", form: salesOrderDocument.form, partyType: "customer" };
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
    return;
  }
  applyPastedEntryLines(startIndex, pasteResult.lines);
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
  const result = await salesOrderDocument.audit();
  formMessage.value = result.ok ? "审核成功" : result.message;
  if (result.ok) {
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
  const result = await salesOrderDocument.remove();
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

function currentOpenableDocumentType(): OpenableDocumentType | null {
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
