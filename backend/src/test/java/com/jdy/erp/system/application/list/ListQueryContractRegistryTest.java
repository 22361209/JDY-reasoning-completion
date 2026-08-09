package com.jdy.erp.system.application.list;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class ListQueryContractRegistryTest {
    private final ListQueryContractRegistry registry = new ListQueryContractRegistry();

    @Test
    void resolvesOnlyExplicitlyRegisteredPublicAndInternalKeys() {
        var knownKeys = List.of(
            "product-master-list",
            "product-category-list",
            "unit-master-list",
            "customer-master-list",
            "supplier-master-list",
            "warehouse-master-list",
            "warehouse-master-selector",
            "production-department-list",
            "sales-quote-form-list",
            "sales-order-form-list",
            "delivery-notice-form-list",
            "sales-out-list",
            "sales-out-form-list",
            "sales-return-form-list",
            "purchase-requisition-list",
            "purchase-order-form-list",
            "purchase-in-list",
            "purchase-in-form-list",
            "purchase-return-list",
            "purchase-return-form-list",
            "purchase-summary-report",
            "other-in-list",
            "other-in-form-list",
            "other-out-list",
            "other-out-form-list",
            "stock-transfer-list",
            "stock-transfer-form-list",
            "stock-count-list",
            "stock-count-form-list",
            "stock-count-gain-list",
            "stock-count-gain-form-list",
            "stock-count-loss-list",
            "stock-count-loss-form-list",
            "inventory-query-list",
            "stock-alert-list",
            "receivable-list",
            "ar-receivable-list",
            "payable-list",
            "ap-payable-list",
            "bom-list",
            "production-plan-list",
            "kit-analysis-list",
            "production-task-list",
            "production-task-form-list",
            "task-track-report",
            "material-issue-list",
            "material-issue-form-list",
            "material-scrap-form-list",
            "product-in-list",
            "product-in-form-list",
            "outsourcing-surface-list",
            "outsourcing-work-order-list",
            "outsourcing-issue-list",
            "outsourcing-receipt-list",
            "outsourcing-return-list",
            "outsourcing-scrap-list",
            "role-list",
            "user-role-list",
            "operation-log-list",
            "sales-quote-source-selector",
            "sales-order-source-selector",
            "delivery-notice-source-selector",
            "sales-out-return-source-selector",
            "purchase-requisition-source-selector",
            "purchase-order-source-selector",
            "purchase-in-source-selector",
            "production-task-source-selector",
            "material-scrap-source-selector",
            "outsourcing-work-order-issue-source-selector",
            "outsourcing-work-order-receipt-source-selector",
            "outsourcing-receipt-return-source-selector",
            "outsourcing-receipt-scrap-source-selector"
        );

        knownKeys.forEach(listKey -> assertThatCode(() -> registry.contractFor(listKey, "header"))
            .as(listKey)
            .doesNotThrowAnyException());

        assertThat(registry.contractFor("sales-order-form-list", "detail").adapterKey()).isEqualTo("salesOrder");
        assertThat(registry.contractFor("material-scrap-form-list", "detail").adapterKey()).isEqualTo("materialScrap");
        assertThat(registry.contractFor("material-scrap-source-selector", "header").adapterKey()).isEqualTo("materialScrap");
        assertThat(registry.contractFor("purchase-order-source-selector", "header").adapterKey()).isEqualTo("sourceSelector");
        assertThat(registry.contractFor("purchase-order-source-selector", "header").view()).isEqualTo("detail");
    }

    @Test
    void rejectsSuffixLookalikesRetiredBackdoorsAndUndefinedEntries() {
        var unknownKeys = List.of(
            "random-list",
            "random-master-list",
            "random-source-selector",
            "standard-list",
            "error-list",
            "permission-denied-list",
            "sales-detail-report",
            "sales-profit-report",
            "stock-flow-report",
            "scrap-report",
            "ar-summary-report",
            "coding-rule-list"
        );

        unknownKeys.forEach(this::assertNotFound);
        assertNotFound("");
        assertNotFound(null);
    }

    private void assertNotFound(String listKey) {
        assertThatThrownBy(() -> registry.contractFor(listKey, "header"))
            .as(String.valueOf(listKey))
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }
}
