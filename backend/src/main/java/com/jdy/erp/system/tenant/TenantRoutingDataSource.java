package com.jdy.erp.system.tenant;

import java.sql.Connection;
import java.sql.SQLException;

import javax.sql.DataSource;

import org.springframework.jdbc.datasource.AbstractDataSource;

public class TenantRoutingDataSource extends AbstractDataSource {
    private final DataSource platformDataSource;
    private final TenantDataSourceRegistry tenantDataSourceRegistry;

    public TenantRoutingDataSource(DataSource platformDataSource, TenantDataSourceRegistry tenantDataSourceRegistry) {
        this.platformDataSource = platformDataSource;
        this.tenantDataSourceRegistry = tenantDataSourceRegistry;
    }

    @Override
    public Connection getConnection() throws SQLException {
        return currentDataSource().getConnection();
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return currentDataSource().getConnection(username, password);
    }

    private DataSource currentDataSource() {
        var context = TenantContext.current().orElse(null);
        if (context == null || !context.isTenant()) {
            return platformDataSource;
        }
        return tenantDataSourceRegistry.dataSourceFor(context);
    }
}
