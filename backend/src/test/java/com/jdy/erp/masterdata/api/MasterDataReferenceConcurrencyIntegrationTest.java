package com.jdy.erp.masterdata.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.jdy.erp.inventory.api.StockAlertSettingController;
import com.jdy.erp.inventory.application.StockCountAppService;
import com.jdy.erp.sales.application.SalesPriceMemoryService;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.ProductSnapshotService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
class MasterDataReferenceConcurrencyIntegrationTest {
    @Autowired
    private MasterDataController masterDataController;

    @Autowired
    private ProductSnapshotService productSnapshotService;

    @Autowired
    private LookupService lookupService;

    @Autowired
    private StockAlertSettingController stockAlertSettingController;

    @Autowired
    private StockCountAppService stockCountAppService;

    @Autowired
    private SalesPriceMemoryService salesPriceMemoryService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private final List<String> productCodes = new ArrayList<>();
    private final List<String> productNameCodes = new ArrayList<>();
    private final List<String> supplierCodes = new ArrayList<>();
    private final List<String> purchaseOrderNos = new ArrayList<>();

    @AfterEach
    void cleanup() {
        for (var purchaseOrderNo : purchaseOrderNos) {
            jdbcTemplate.update("DELETE FROM purchase_order WHERE bill_no = ?", purchaseOrderNo);
        }
        for (var productCode : productCodes) {
            jdbcTemplate.update("""
                DELETE FROM inv_safety_stock_setting
                WHERE product_id = (SELECT id FROM md_product WHERE code = ?)
                """, productCode);
            jdbcTemplate.update("DELETE FROM md_product WHERE code = ?", productCode);
        }
        for (var supplierCode : supplierCodes) {
            jdbcTemplate.update("DELETE FROM md_supplier WHERE code = ?", supplierCode);
        }
        for (var productNameCode : productNameCodes) {
            jdbcTemplate.update("DELETE FROM md_product_name WHERE code = ?", productNameCode);
        }
    }

    @Test
    void readOnlyPriceAndStockCountLookupsRemainNonLocking() {
        assertThatCode(() -> stockCountAppService.bookQuantity(null, "CP-001", "CK-001"))
            .doesNotThrowAnyException();
        assertThatCode(() -> salesPriceMemoryService.unitPrice("KH-001", "CP-001"))
            .doesNotThrowAnyException();
        assertThatThrownBy(() -> productSnapshotService.resolveForReference(null, "CP-001", "商品"))
            .isInstanceOf(IllegalTransactionStateException.class);
        assertThatThrownBy(() -> lookupService.lookupEnabledIdForReference("md_supplier", "GYS-001", "供应商"))
            .isInstanceOf(IllegalTransactionStateException.class);
    }

    @Test
    void productReferenceCommitWinsAndConcurrentReverseFailsClosed() throws Exception {
        var product = createAuditedProduct("WRITER");
        var referenceLocked = new CountDownLatch(1);
        var releaseReference = new CountDownLatch(1);
        var reverseStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var writer = executor.submit(() -> {
                new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                    var snapshot = productSnapshotService.resolveForReference(null, product.code(), "商品");
                    referenceLocked.countDown();
                    await(releaseReference);
                    jdbcTemplate.update("""
                        INSERT INTO inv_safety_stock_setting (product_id, warehouse_id, safety_qty, max_qty)
                        SELECT ?::uuid, id, 1, 10
                        FROM md_warehouse
                        WHERE code = 'CK-001'
                        """, snapshot.id());
                });
                return "COMMITTED";
            });
            assertThat(referenceLocked.await(10, TimeUnit.SECONDS)).isTrue();

            var reverse = executor.submit(() -> {
                reverseStarted.countDown();
                return reverseProduct(product.code());
            });
            assertThat(reverseStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatCode(() -> reverse.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);

            releaseReference.countDown();
            assertThat(writer.get(10, TimeUnit.SECONDS)).isEqualTo("COMMITTED");
            assertThat(reverse.get(10, TimeUnit.SECONDS)).isEqualTo("HTTP_409");
        } finally {
            releaseReference.countDown();
        }

        assertThat(jdbcTemplate.queryForObject(
            "SELECT audit_status FROM md_product WHERE code = ?",
            String.class,
            product.code()
        )).isEqualTo("AUDITED");
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM inv_safety_stock_setting setting
            JOIN md_product product ON product.id = setting.product_id
            WHERE product.code = ?
            """, Integer.class, product.code())).isOne();
    }

    @Test
    void reverseCommitWinsAndConcurrentProductReferenceRevalidatesThenFails() throws Exception {
        var product = createAuditedProduct("REVERSE");
        var reverseApplied = new CountDownLatch(1);
        var releaseReverse = new CountDownLatch(1);
        var writerStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var reverse = executor.submit(() -> {
                new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                    masterDataController.reverseAudit("product", product.code());
                    reverseApplied.countDown();
                    await(releaseReverse);
                });
                return "DRAFT";
            });
            assertThat(reverseApplied.await(10, TimeUnit.SECONDS)).isTrue();

            var writer = executor.submit(() -> {
                writerStarted.countDown();
                try {
                    stockAlertSettingController.upsert(new StockAlertSettingController.StockAlertSettingRequest(
                        product.code(), "CK-001", BigDecimal.ONE, BigDecimal.TEN
                    ));
                    return "SAVED";
                } catch (ResponseStatusException exception) {
                    return "HTTP_" + exception.getStatusCode().value();
                }
            });
            assertThat(writerStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatCode(() -> writer.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);

            releaseReverse.countDown();
            assertThat(reverse.get(10, TimeUnit.SECONDS)).isEqualTo("DRAFT");
            assertThat(writer.get(10, TimeUnit.SECONDS)).isEqualTo("HTTP_400");
        } finally {
            releaseReverse.countDown();
        }

        assertThat(jdbcTemplate.queryForObject(
            "SELECT audit_status FROM md_product WHERE code = ?",
            String.class,
            product.code()
        )).isEqualTo("DRAFT");
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM inv_safety_stock_setting setting
            JOIN md_product product ON product.id = setting.product_id
            WHERE product.code = ?
            """, Integer.class, product.code())).isZero();
    }

    @Test
    void supplierReferenceCommitWinsAndConcurrentReverseFailsClosed() throws Exception {
        var suffix = uniqueSuffix();
        var supplierCode = "GYS-A186-LOCK-" + suffix;
        var purchaseOrderNo = "CGDD-A186-LOCK-" + suffix;
        supplierCodes.add(supplierCode);
        purchaseOrderNos.add(purchaseOrderNo);
        masterDataController.create("supplier", Map.of("code", supplierCode, "name", "A186 并发供应商 " + suffix));
        masterDataController.audit("supplier", supplierCode);

        var referenceLocked = new CountDownLatch(1);
        var releaseReference = new CountDownLatch(1);
        var reverseStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var writer = executor.submit(() -> {
                new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                    var supplierId = lookupService.lookupEnabledIdForReference("md_supplier", supplierCode, "供应商");
                    referenceLocked.countDown();
                    await(releaseReference);
                    jdbcTemplate.update("""
                        INSERT INTO purchase_order (bill_no, supplier_id, bill_date, status)
                        VALUES (?, ?::uuid, ?, 'DRAFT')
                        """, purchaseOrderNo, supplierId, LocalDate.of(2026, 8, 16));
                });
                return "COMMITTED";
            });
            assertThat(referenceLocked.await(10, TimeUnit.SECONDS)).isTrue();
            var reverse = executor.submit(() -> {
                reverseStarted.countDown();
                return reverseSupplier(supplierCode);
            });
            assertThat(reverseStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatCode(() -> reverse.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);

            releaseReference.countDown();
            assertThat(writer.get(10, TimeUnit.SECONDS)).isEqualTo("COMMITTED");
            assertThat(reverse.get(10, TimeUnit.SECONDS)).isEqualTo("HTTP_409");
        } finally {
            releaseReference.countDown();
        }

        assertThat(jdbcTemplate.queryForObject(
            "SELECT audit_status FROM md_supplier WHERE code = ?",
            String.class,
            supplierCode
        )).isEqualTo("AUDITED");
    }

    @Test
    void supplierReverseCommitWinsAndConcurrentReferenceRevalidatesThenFails() throws Exception {
        var suffix = uniqueSuffix();
        var supplierCode = "GYS-A186-REVERSE-" + suffix;
        var purchaseOrderNo = "CGDD-A186-REVERSE-" + suffix;
        supplierCodes.add(supplierCode);
        purchaseOrderNos.add(purchaseOrderNo);
        masterDataController.create("supplier", Map.of("code", supplierCode, "name", "A186 反审核供应商 " + suffix));
        masterDataController.audit("supplier", supplierCode);

        var reverseApplied = new CountDownLatch(1);
        var releaseReverse = new CountDownLatch(1);
        var writerStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var reverse = executor.submit(() -> {
                new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                    masterDataController.reverseAudit("supplier", supplierCode);
                    reverseApplied.countDown();
                    await(releaseReverse);
                });
                return "DRAFT";
            });
            assertThat(reverseApplied.await(10, TimeUnit.SECONDS)).isTrue();

            var writer = executor.submit(() -> {
                writerStarted.countDown();
                try {
                    new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        var supplierId = lookupService.lookupEnabledIdForReference(
                            "md_supplier", supplierCode, "供应商"
                        );
                        jdbcTemplate.update("""
                            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, status)
                            VALUES (?, ?::uuid, ?, 'DRAFT')
                            """, purchaseOrderNo, supplierId, LocalDate.of(2026, 8, 16));
                    });
                    return "SAVED";
                } catch (ResponseStatusException exception) {
                    return "HTTP_" + exception.getStatusCode().value();
                }
            });
            assertThat(writerStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatCode(() -> writer.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);

            releaseReverse.countDown();
            assertThat(reverse.get(10, TimeUnit.SECONDS)).isEqualTo("DRAFT");
            assertThat(writer.get(10, TimeUnit.SECONDS)).isEqualTo("HTTP_400");
        } finally {
            releaseReverse.countDown();
        }

        assertThat(jdbcTemplate.queryForObject(
            "SELECT audit_status FROM md_supplier WHERE code = ?",
            String.class,
            supplierCode
        )).isEqualTo("DRAFT");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM purchase_order WHERE bill_no = ?",
            Integer.class,
            purchaseOrderNo
        )).isZero();
    }

    private ProductFixture createAuditedProduct(String label) {
        var suffix = uniqueSuffix();
        var productCode = "CP-A186-LOCK-" + suffix;
        var productNameCode = "PN-A186-LOCK-" + suffix;
        var productName = "A186 " + label + " 物料 " + suffix;
        productCodes.add(productCode);
        productNameCodes.add(productNameCode);
        masterDataController.create("productName", Map.of("code", productNameCode, "name", productName));
        masterDataController.audit("productName", productNameCode);
        masterDataController.create("product", Map.of(
            "code", productCode,
            "name", productName,
            "category", "成品总成",
            "unit", "只",
            "defaultWarehouseCode", "CK-001",
            "isInventory", "true"
        ));
        masterDataController.audit("product", productCode);
        return new ProductFixture(productCode);
    }

    private String reverseProduct(String productCode) {
        try {
            masterDataController.reverseAudit("product", productCode);
            return "DRAFT";
        } catch (ResponseStatusException exception) {
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            return "HTTP_409";
        }
    }

    private String reverseSupplier(String supplierCode) {
        try {
            masterDataController.reverseAudit("supplier", supplierCode);
            return "DRAFT";
        } catch (ResponseStatusException exception) {
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            return "HTTP_409";
        }
    }

    private void await(CountDownLatch latch) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new AssertionError("并发测试闸门等待超时");
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new AssertionError("并发测试被中断", exception);
        }
    }

    private String uniqueSuffix() {
        return Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
    }

    private record ProductFixture(String code) {
    }
}
