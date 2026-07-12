package com.jdy.erp.system.api;

import java.util.Map;

import com.jdy.erp.system.application.AccountSetMaintenanceService;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.application.AccountSetInitializationService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequirePermission;
import com.jdy.erp.system.security.WriteAccess;
import com.jdy.erp.system.security.WriteAccess.Policy;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system/account-sets")
public class AccountSetController {
    private final CurrentSessionService currentSessionService;
    private final AccountSetInitializationService initializationService;
    private final AccountSetManagementService accountSetManagementService;
    private final AccountSetMaintenanceService accountSetMaintenanceService;

    public AccountSetController(
        CurrentSessionService currentSessionService,
        AccountSetInitializationService initializationService,
        AccountSetManagementService accountSetManagementService,
        AccountSetMaintenanceService accountSetMaintenanceService
    ) {
        this.currentSessionService = currentSessionService;
        this.initializationService = initializationService;
        this.accountSetManagementService = accountSetManagementService;
        this.accountSetMaintenanceService = accountSetMaintenanceService;
    }

    @GetMapping("/current")
    public Map<String, Object> current() {
        return Map.of("current", currentSessionService.currentAccountSet());
    }

    @PostMapping("/current")
    @WriteAccess(Policy.SWITCH_AUTHORIZED_ACCOUNT_SET)
    public Map<String, Object> switchCurrent(@RequestBody SwitchAccountSetRequest request) {
        currentSessionService.switchAccountSet(request.accountSetCode());
        return Map.of("current", currentSessionService.currentAccountSet());
    }

    @PostMapping
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> create(@RequestBody AccountSetManagementService.AccountSetCreateRequest request) {
        return accountSetManagementService.createAccountSet(request);
    }

    @GetMapping("/manage")
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> managedAccountSets() {
        return Map.of(
            "accountSets", accountSetManagementService.managedAccountSets(),
            "current", currentSessionService.currentAccountSet()
        );
    }

    @PatchMapping("/{accountSetCode}/enabled")
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> setEnabled(@PathVariable String accountSetCode, @RequestBody AccountSetEnabledRequest request) {
        return accountSetManagementService.setEnabled(accountSetCode, Boolean.TRUE.equals(request.enabled()), request.reason());
    }

    @PostMapping("/current/initialize")
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> initializeCurrent(@RequestBody InitializeAccountSetRequest request) {
        return initializationService.initializeCurrentAccountSet(Boolean.TRUE.equals(request.clearBusinessData()));
    }

    @GetMapping("/current/backups")
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> currentBackups() {
        return Map.of("backups", accountSetMaintenanceService.currentBackups());
    }

    @PostMapping("/current/backups")
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> backupCurrent() {
        return accountSetMaintenanceService.backupCurrentAccountSet();
    }

    @PostMapping("/current/backups/{backupName}/restore")
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> restoreCurrent(@PathVariable String backupName) {
        return accountSetMaintenanceService.restoreCurrentAccountSet(backupName);
    }

    public record SwitchAccountSetRequest(String accountSetCode) {
    }

    public record AccountSetEnabledRequest(Boolean enabled, String reason) {
    }

    public record InitializeAccountSetRequest(Boolean clearBusinessData) {
    }
}
