package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class TenantRoutingDataSourceBoundaryTest {
    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private String schemaName;

    @BeforeEach
    void createSchema() {
        schemaName = "a119_route_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        platformJdbcTemplate.execute("CREATE SCHEMA " + quoteIdentifier(schemaName));
    }

    @AfterEach
    void dropSchema() {
        TenantContext.clear();
        tenantDataSourceRegistry.close();
        if (schemaName != null) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(schemaName) + " CASCADE");
        }
    }

    @Test
    void tenantContextCanRouteDefaultJdbcTemplateToSeparateSchemaBoundary() {
        var databaseName = platformJdbcTemplate.queryForObject("SELECT current_database()", String.class);
        TenantContext.setTenant(Map.of(
            "id", "00000000-0000-0000-0000-000000000001",
            "code", "A119-SCHEMA",
            "databaseName", databaseName,
            "schemaName", schemaName,
            "redisKeyPrefix", "A119-SCHEMA",
            "attachmentPrefix", "account-sets/A119-SCHEMA"
        ));

        assertThat(jdbcTemplate.queryForObject("SELECT current_schema()", String.class)).isEqualTo(schemaName);

        TenantContext.setPlatform();
        assertThat(jdbcTemplate.queryForObject("SELECT current_schema()", String.class)).isEqualTo("public");
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
