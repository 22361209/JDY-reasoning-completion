package com.jdy.erp.inventory.config;

import java.util.List;
import java.util.Locale;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@ConfigurationProperties(prefix = "jdy.inventory.test-adjustment-api")
public record InventoryTestAdjustmentProperties(
    boolean enabled,
    List<String> allowedAccountSetCodes
) {
    public InventoryTestAdjustmentProperties {
        allowedAccountSetCodes = allowedAccountSetCodes == null
            ? List.of()
            : allowedAccountSetCodes.stream()
                .map(value -> value == null ? "" : value.trim().toUpperCase(Locale.ROOT))
                .filter(value -> !value.isBlank())
                .distinct()
                .toList();
    }
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(InventoryTestAdjustmentProperties.class)
class InventoryTestAdjustmentConfiguration {
}
