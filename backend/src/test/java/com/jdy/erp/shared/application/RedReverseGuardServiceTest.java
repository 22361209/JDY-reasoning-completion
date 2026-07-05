package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

class RedReverseGuardServiceTest {
    private static final String SOURCE_BILL_ID = "00000000-0000-0000-0000-000000000001";

    private final JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
    private final RedReverseGuardService service = new RedReverseGuardService(jdbcTemplate);

    @Test
    void nonVoidRedBillsBlockCreatingAnotherRedBill() {
        when(jdbcTemplate.queryForObject(contains("status <> 'VOID'"), eq(Integer.class), eq(SOURCE_BILL_ID)))
            .thenReturn(1);

        assertThatThrownBy(() -> service.assertNoNonVoidRedBill("sales_out", SOURCE_BILL_ID, "销售出库单"))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT))
            .hasMessageContaining("已存在非作废红字单");
    }

    @Test
    void effectiveRedBillsOnlyCountAuditedOrLegacyRedReversedRows() {
        when(jdbcTemplate.queryForObject(contains("status IN ('AUDITED', 'RED_REVERSED')"), eq(Integer.class), eq(SOURCE_BILL_ID)))
            .thenReturn(2);

        assertThat(service.countEffectiveRedBills("sales_out", SOURCE_BILL_ID)).isEqualTo(2);
        assertThat(service.hasEffectiveRedBill("sales_out", SOURCE_BILL_ID)).isTrue();

        verify(jdbcTemplate, times(2)).queryForObject(contains("status IN ('AUDITED', 'RED_REVERSED')"), eq(Integer.class), eq(SOURCE_BILL_ID));
    }

    @Test
    void nullCountsAreTreatedAsZero() {
        when(jdbcTemplate.queryForObject(contains("status <> 'VOID'"), eq(Integer.class), eq(SOURCE_BILL_ID)))
            .thenReturn(null);

        assertThat(service.countNonVoidRedBills("sales_out", SOURCE_BILL_ID)).isZero();
    }
}
