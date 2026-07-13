package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class TenantSchemaProvisionerTest {
    private final JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
    private final TenantSchemaProvisioner provisioner = new TenantSchemaProvisioner(jdbcTemplate);

    @Test
    void provisionUsesTheVersionedSchemaPlanAndSeedsOnlyAfterAllManagedTablesExist() {
        when(jdbcTemplate.queryForObject(
            "SELECT public.jdy_sync_tenant_schema(?, ?)",
            Integer.class,
            "tenant_a137",
            true
        )).thenReturn(72);

        provisioner.provisionNewSchema("tenant_a137");

        verify(jdbcTemplate).queryForObject(
            "SELECT public.jdy_sync_tenant_schema(?, ?)",
            Integer.class,
            "tenant_a137",
            true
        );
        verify(jdbcTemplate, never()).execute(anyString());
        verify(jdbcTemplate).update(org.mockito.ArgumentMatchers.contains("\"tenant_a137\".md_product_category"));
        verify(jdbcTemplate).update(org.mockito.ArgumentMatchers.contains("\"tenant_a137\".md_unit"));
        verify(jdbcTemplate).update(org.mockito.ArgumentMatchers.contains("\"tenant_a137\".md_warehouse"));
        verify(jdbcTemplate).update(org.mockito.ArgumentMatchers.contains("\"tenant_a137\".md_production_department"));
    }

    @Test
    void provisionRefusesAnIncompleteManagedTablePlan() {
        when(jdbcTemplate.queryForObject(anyString(), eq(Integer.class), eq("tenant_incomplete"), eq(false)))
            .thenReturn(71);

        assertThatThrownBy(() -> provisioner.provisionSchema("tenant_incomplete"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("72 张受管表");

        verify(jdbcTemplate, never()).update(anyString());
    }

    @Test
    void existingSchemaSynchronizationNeverCreatesMissingStructures() {
        when(jdbcTemplate.queryForObject(anyString(), eq(Integer.class), eq("tenant_existing"), eq(false)))
            .thenThrow(new IllegalStateException("registered tenant table does not exist"));

        assertThatThrownBy(() -> provisioner.provisionSchema("tenant_existing"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("does not exist");

        verify(jdbcTemplate).queryForObject(
            "SELECT public.jdy_sync_tenant_schema(?, ?)",
            Integer.class,
            "tenant_existing",
            false
        );
        verify(jdbcTemplate, never()).update(anyString());
    }

    @Test
    void tenantTableNamesComeFromTheVersionedRestoreOrder() {
        when(jdbcTemplate.queryForList(anyString(), eq(String.class)))
            .thenReturn(List.of("md_product", "sales_order"));

        assertThat(provisioner.tenantTableNames()).containsExactly("md_product", "sales_order");
        verify(jdbcTemplate).queryForList(
            org.mockito.ArgumentMatchers.contains("ORDER BY restore_order"),
            eq(String.class)
        );
    }
}
