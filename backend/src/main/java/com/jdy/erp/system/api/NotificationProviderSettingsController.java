package com.jdy.erp.system.api;

import java.util.Map;

import com.jdy.erp.system.application.NotificationProviderService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/system/notification-provider-settings")
public class NotificationProviderSettingsController {
    private final CurrentSessionService currentSessionService;
    private final NotificationProviderService notificationProviderService;

    public NotificationProviderSettingsController(CurrentSessionService currentSessionService, NotificationProviderService notificationProviderService) {
        this.currentSessionService = currentSessionService;
        this.notificationProviderService = notificationProviderService;
    }

    @GetMapping
    @RequirePermission("system.notification_provider.manage")
    public Map<String, Object> settings() {
        return notificationProviderService.settings();
    }

    @PutMapping
    @RequirePermission("system.notification_provider.manage")
    public Map<String, Object> updateSettings(@RequestBody NotificationProviderSettingsRequest request) {
        verifySecurityPassword(request.currentPassword());
        notificationProviderService.updateSettings(
            request.providerCode(),
            request.senderName(),
            request.endpointUrl(),
            request.webhookSecret(),
            request.dryRun()
        );
        return settings();
    }

    private void verifySecurityPassword(String currentPassword) {
        try {
            currentSessionService.verifyCurrentPassword(currentPassword);
        } catch (ResponseStatusException exception) {
            if (HttpStatus.UNAUTHORIZED.equals(exception.getStatusCode())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "当前密码不正确");
            }
            throw exception;
        }
    }

    public record NotificationProviderSettingsRequest(
        String currentPassword,
        String providerCode,
        String senderName,
        String endpointUrl,
        String webhookSecret,
        Boolean dryRun
    ) {
    }
}
