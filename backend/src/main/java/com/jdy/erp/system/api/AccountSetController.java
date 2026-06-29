package com.jdy.erp.system.api;

import java.util.Map;

import com.jdy.erp.system.application.AccountSetInitializationService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/system/account-sets")
public class AccountSetController {
    private final CurrentSessionService currentSessionService;
    private final AccountSetInitializationService initializationService;

    public AccountSetController(CurrentSessionService currentSessionService, AccountSetInitializationService initializationService) {
        this.currentSessionService = currentSessionService;
        this.initializationService = initializationService;
    }

    @GetMapping("/current")
    public Map<String, Object> current() {
        return Map.of("current", currentSessionService.currentAccountSet());
    }

    @PostMapping("/current")
    public Map<String, Object> switchCurrent(@RequestBody SwitchAccountSetRequest request) {
        currentSessionService.switchAccountSet(request.accountSetCode());
        return Map.of("current", currentSessionService.currentAccountSet());
    }

    @PostMapping("/current/initialize")
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> initializeCurrent(@RequestBody InitializeAccountSetRequest request) {
        return initializationService.initializeCurrentAccountSet(Boolean.TRUE.equals(request.clearBusinessData()));
    }

    public record SwitchAccountSetRequest(String accountSetCode) {
    }

    public record InitializeAccountSetRequest(Boolean clearBusinessData) {
    }
}
