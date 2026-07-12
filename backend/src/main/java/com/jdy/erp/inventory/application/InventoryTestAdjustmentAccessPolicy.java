package com.jdy.erp.inventory.application;

import java.util.Arrays;
import java.util.Locale;
import java.util.Set;

import com.jdy.erp.inventory.config.InventoryTestAdjustmentProperties;
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class InventoryTestAdjustmentAccessPolicy {
    private static final Set<String> ALLOWED_PROFILES = Set.of("local", "test", "regression");

    private final InventoryTestAdjustmentProperties properties;
    private final Environment environment;
    private final CurrentSessionService currentSessionService;

    public InventoryTestAdjustmentAccessPolicy(
        InventoryTestAdjustmentProperties properties,
        Environment environment,
        CurrentSessionService currentSessionService
    ) {
        this.properties = properties;
        this.environment = environment;
        this.currentSessionService = currentSessionService;
    }

    public void requireAllowed() {
        if (!isEnabledForAccountSet(currentSessionService.currentAccountSetCode())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "库存测试调整接口仅允许受控测试环境和账套");
        }
    }

    public boolean isEnabledForAccountSet(String accountSetCode) {
        var normalizedAccountSetCode = accountSetCode == null
            ? ""
            : accountSetCode.trim().toUpperCase(Locale.ROOT);
        return hasOnlyAllowedActiveProfiles()
            && properties.enabled()
            && properties.allowedAccountSetCodes().contains(normalizedAccountSetCode);
    }

    private boolean hasOnlyAllowedActiveProfiles() {
        var activeProfiles = environment.getActiveProfiles();
        return activeProfiles.length > 0
            && Arrays.stream(activeProfiles).allMatch(ALLOWED_PROFILES::contains);
    }
}
