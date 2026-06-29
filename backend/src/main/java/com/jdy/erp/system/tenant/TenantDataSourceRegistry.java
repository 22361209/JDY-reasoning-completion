package com.jdy.erp.system.tenant;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.sql.DataSource;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.stereotype.Component;

@Component
public class TenantDataSourceRegistry implements AutoCloseable {
    private final DataSourceProperties properties;
    private final Map<String, HikariDataSource> tenantDataSources = new ConcurrentHashMap<>();

    public TenantDataSourceRegistry(DataSourceProperties properties) {
        this.properties = properties;
    }

    public DataSource dataSourceFor(TenantContext.Snapshot tenant) {
        var databaseName = tenant.databaseName();
        var schemaName = tenant.schemaName();
        var key = (databaseName == null ? "" : databaseName) + "|" + (schemaName == null ? "" : schemaName);
        return tenantDataSources.computeIfAbsent(key, ignored -> createDataSource(tenant));
    }

    private HikariDataSource createDataSource(TenantContext.Snapshot tenant) {
        var config = new HikariConfig();
        config.setJdbcUrl(jdbcUrlFor(tenant.databaseName()));
        config.setUsername(properties.getUsername());
        config.setPassword(properties.getPassword());
        if (properties.getDriverClassName() != null && !properties.getDriverClassName().isBlank()) {
            config.setDriverClassName(properties.getDriverClassName());
        }
        if (tenant.schemaName() != null && !tenant.schemaName().isBlank()) {
            config.setSchema(tenant.schemaName());
        }
        config.setMaximumPoolSize(8);
        config.setMinimumIdle(0);
        config.setPoolName("tenant-" + sanitize(tenant.accountSetCode()));
        return new HikariDataSource(config);
    }

    private String jdbcUrlFor(String databaseName) {
        var baseUrl = properties.getUrl();
        if (databaseName == null || databaseName.isBlank() || baseUrl == null || baseUrl.isBlank()) {
            return baseUrl;
        }
        var prefix = "jdbc:postgresql://";
        if (!baseUrl.startsWith(prefix)) {
            return baseUrl;
        }
        var queryStart = baseUrl.indexOf('?');
        var mainPart = queryStart >= 0 ? baseUrl.substring(0, queryStart) : baseUrl;
        var queryPart = queryStart >= 0 ? baseUrl.substring(queryStart) : "";
        var slash = mainPart.indexOf('/', prefix.length());
        if (slash < 0) {
            return baseUrl;
        }
        return mainPart.substring(0, slash + 1) + databaseName + queryPart;
    }

    private String sanitize(String value) {
        if (value == null || value.isBlank()) {
            return "unknown";
        }
        return value.replaceAll("[^A-Za-z0-9_-]", "-");
    }

    @Override
    public void close() {
        tenantDataSources.values().forEach(HikariDataSource::close);
        tenantDataSources.clear();
    }
}
