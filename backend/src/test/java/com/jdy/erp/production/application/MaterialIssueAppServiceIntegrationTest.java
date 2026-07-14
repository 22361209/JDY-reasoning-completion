package com.jdy.erp.production.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Map;

import com.jdy.erp.production.application.MaterialScrapAppServiceIntegrationTest.Fixture;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
class MaterialIssueAppServiceIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MaterialIssueAppService materialIssueAppService;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    private Map<String, Object> accountSet;
    private Fixture fixture;

    @BeforeEach
    void setUp() {
        accountSet = jdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(database_name, '') AS "databaseName",
                   COALESCE(schema_name, '') AS "schemaName",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """);
        when(currentSessionService.currentAccountSetId()).thenReturn(String.valueOf(accountSet.get("id")));
        when(currentSessionService.currentUsername()).thenReturn("admin");
        when(currentSessionService.currentDisplayName()).thenReturn("A151 管理员");
        when(currentSessionService.currentRoleCode()).thenReturn("ADMIN");
        TenantContext.setTenant(accountSet);
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        fixture = new Fixture(jdbcTemplate, String.valueOf(accountSet.get("id")));
    }

    @AfterEach
    void tearDown() {
        try {
            if (fixture != null) {
                fixture.clean();
            }
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void nonVoidMaterialScrapBlocksIssueReverseAndRedDraftUntilVoidReleasesTheSource() {
        var downstream = fixture.insertScrap(
            "SOURCE-GUARD",
            "DRAFT",
            LocalDate.of(2026, 7, 14),
            BigDecimal.ZERO
        );

        assertConflict(() -> materialIssueAppService.reverse(fixture.sourceIssueNo()));
        assertConflict(() -> materialIssueAppService.redReverse(
            fixture.sourceIssueNo(),
            new MaterialIssueAppService.RedReverseRequest(null)
        ));
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM production_material_issue
            WHERE red_source_bill_id = ?::uuid
              AND status <> 'VOID'
            """, Integer.class, fixture.sourceIssueId())).isZero();
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
            """, Integer.class, fixture.sourceIssueId())).isZero();

        jdbcTemplate.update("""
            UPDATE production_material_scrap
            SET status = 'VOID',
                voided_at = now(),
                void_reason = '测试释放来源',
                void_verified_username = 'admin',
                void_verified_at = now(),
                updated_at = now()
            WHERE id = ?::uuid
            """, downstream.id());

        assertThat(materialIssueAppService.redReverse(
            fixture.sourceIssueNo(),
            new MaterialIssueAppService.RedReverseRequest(null)
        )).containsEntry("status", "DRAFT");
    }

    private void assertConflict(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
    }
}
