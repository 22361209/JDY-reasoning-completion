package com.jdy.erp.reports.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import java.util.Map;

import com.jdy.erp.shared.application.DocumentPermissionPolicy;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

class DocumentOutputControllerPermissionTest {
    private static final Map<String, String> OUTPUT_PERMISSIONS = Map.ofEntries(
        Map.entry("sales-quote", "salesQuote"),
        Map.entry("sales-order", "salesOrder"),
        Map.entry("purchase-order", "purchaseOrder"),
        Map.entry("purchase-in", "purchaseIn"),
        Map.entry("purchase-return", "purchaseReturn"),
        Map.entry("sales-out", "salesOut"),
        Map.entry("sales-return", "salesReturn"),
        Map.entry("material-issue", "materialIssue"),
        Map.entry("product-in", "productIn"),
        Map.entry("other-stock-in", "otherStockIn"),
        Map.entry("other-stock-out", "otherStockOut"),
        Map.entry("stock-transfer", "stockTransfer"),
        Map.entry("stock-count-loss", "stockCountLoss")
    );

    @Test
    void everyDocumentOutputRequiresItsDocumentPermissionBeforeReadingJdbc() {
        OUTPUT_PERMISSIONS.forEach((outputType, permissionType) -> {
            var policy = mock(DocumentPermissionPolicy.class);
            var jdbcTemplate = mock(JdbcTemplate.class);
            var controller = new DocumentOutputController(jdbcTemplate, policy);
            doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "denied"))
                .when(policy).requirePermission(permissionType);

            assertThatThrownBy(() -> controller.exportCsv(outputType, "BILL-001"))
                .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                    assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN)
                );

            verify(policy).requirePermission(permissionType);
            verify(jdbcTemplate, org.mockito.Mockito.never()).queryForList(
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.<Object[]>any()
            );
        });
    }

    @Test
    void salesReturnCsvHtmlAndPdfAllShareTheServerSidePermissionGuard() {
        var policy = mock(DocumentPermissionPolicy.class);
        var controller = new DocumentOutputController(mock(JdbcTemplate.class), policy);
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "denied"))
            .when(policy).requirePermission("salesReturn");

        assertForbidden(() -> controller.exportCsv("sales-return", "XSTH000001"));
        assertForbidden(() -> controller.printHtml("sales-return", "XSTH000001"));
        assertForbidden(() -> controller.printPdf("sales-return", "XSTH000001"));

        verify(policy, org.mockito.Mockito.times(3)).requirePermission("salesReturn");
    }

    @Test
    void stockCountLossCsvHtmlAndPdfAllShareTheServerSidePermissionGuard() {
        var policy = mock(DocumentPermissionPolicy.class);
        var controller = new DocumentOutputController(mock(JdbcTemplate.class), policy);
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "denied"))
            .when(policy).requirePermission("stockCountLoss");

        assertForbidden(() -> controller.exportCsv("stock-count-loss", "PKD000001"));
        assertForbidden(() -> controller.printHtml("stock-count-loss", "PKD000001"));
        assertForbidden(() -> controller.printPdf("stock-count-loss", "PKD000001"));

        verify(policy, org.mockito.Mockito.times(3)).requirePermission("stockCountLoss");
    }

    private void assertForbidden(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN)
            );
    }
}
