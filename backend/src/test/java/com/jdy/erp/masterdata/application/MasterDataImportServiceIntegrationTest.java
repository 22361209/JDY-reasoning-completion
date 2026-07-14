package com.jdy.erp.masterdata.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.apache.poi.ss.usermodel.SheetVisibility;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@AutoConfigureMockMvc
class MasterDataImportServiceIntegrationTest {
    @Autowired
    private MasterDataImportService importService;

    @Autowired
    private MasterDataImportDefinitionRegistry definitions;

    @Autowired
    private MasterDataCreateService createService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    private final List<String> jobIds = new ArrayList<>();
    private MockHttpSession admin;
    private String fixturePrefix;

    @BeforeEach
    void setUp() throws Exception {
        fixturePrefix = "A143-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase() + "-";
        admin = login("admin", "admin123", "BLD-TEST");
        bind(admin);
        dropTestDatabaseGuards();
    }

    @AfterEach
    void cleanUp() {
        try {
            bind(admin);
            dropTestDatabaseGuards();
            for (var jobId : jobIds) {
                jdbcTemplate.update(
                    "DELETE FROM sys_operation_log WHERE target_type = 'MASTER_DATA_IMPORT' AND target_id = ?::uuid",
                    jobId
                );
                jdbcTemplate.update("DELETE FROM md_import_batch WHERE id = ?::uuid", jobId);
            }
            jdbcTemplate.update("DELETE FROM md_product WHERE code LIKE ?", fixturePrefix + "%");
            jdbcTemplate.update("DELETE FROM md_financial_account WHERE code LIKE ?", fixturePrefix + "%");
            jdbcTemplate.update("DELETE FROM md_employee WHERE code LIKE ?", fixturePrefix + "%");
            jdbcTemplate.update("DELETE FROM md_warehouse WHERE code LIKE ?", fixturePrefix + "%");
            jdbcTemplate.update("DELETE FROM md_supplier WHERE code LIKE ?", fixturePrefix + "%");
            jdbcTemplate.update("DELETE FROM md_customer WHERE code LIKE ?", fixturePrefix + "%");
            jdbcTemplate.update("DELETE FROM md_unit WHERE code LIKE ?", fixturePrefix + "%");
            jdbcTemplate.update("DELETE FROM md_product_category WHERE code LIKE ?", fixturePrefix + "%");
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void previewWritesNoBusinessRowsAndDuplicateMakesWholeBatchInvalidWithReceipt() throws Exception {
        var code = fixturePrefix + "DUP";
        var bytes = customerWorkbook(List.of(
            Map.of("code", code, "name", "重复客户一"),
            Map.of("code", code, "name", "重复客户二")
        ));

        var job = preview(bytes);

        assertThat(job.status()).isEqualTo("INVALID");
        assertThat(job.totalRows()).isEqualTo(2);
        assertThat(job.validRows()).isZero();
        assertThat(job.errorRows()).isEqualTo(2);
        assertThat(job.committedRows()).isZero();
        assertThat(job.canConfirm()).isFalse();
        assertThat(job.rows()).hasSize(2).allSatisfy(row -> {
            assertThat(row.valid()).isFalse();
            assertThat(row.errors()).extracting(MasterDataImportWorkbookService.RowError::code)
                .containsAnyOf("DUPLICATE_IN_FILE", "DUPLICATE_FILE_CODE");
        });
        assertThat(customerCount(code)).isZero();

        var receipt = importService.errorReceipt(job.id());
        assertThat(receipt.fileName()).endsWith("-errors.xlsx");
        try (var workbook = new XSSFWorkbook(new ByteArrayInputStream(receipt.bytes()))) {
            var sheet = workbook.getSheet("错误回执");
            assertThat(sheet).isNotNull();
            assertThat(sheet.getLastRowNum()).isGreaterThanOrEqualTo(3);
            assertThat(sheet.getRow(2).getCell(0).getNumericCellValue()).isEqualTo(3);
            assertThat(sheet.getRow(2).getCell(1).getStringCellValue()).isEqualTo(code);
        }
    }

    @Test
    void databaseDuplicateMakesWholeBatchUnconfirmableWithoutWritingOtherwiseValidRows() throws Exception {
        var occupiedCode = fixturePrefix + "DB-DUP";
        var freeCode = fixturePrefix + "DB-FREE";
        createService.create("customer", Map.of("code", occupiedCode, "name", "已存在客户"));

        var job = preview(customerWorkbook(List.of(
            Map.of("code", occupiedCode, "name", "重复数据库客户"),
            Map.of("code", freeCode, "name", "本可新增客户")
        )));

        assertThat(job.status()).isEqualTo("INVALID");
        assertThat(job.validRows()).isEqualTo(1);
        assertThat(job.errorRows()).isEqualTo(1);
        assertThat(job.canConfirm()).isFalse();
        assertThat(job.rows()).filteredOn(row -> row.businessCode().equals(occupiedCode)).singleElement()
            .satisfies(row -> assertThat(row.errors())
                .extracting(MasterDataImportWorkbookService.RowError::code)
                .contains("DUPLICATE_DATABASE_CODE"));
        assertThatThrownBy(() -> importService.confirm(job.id(), 1, 100))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(409));
        assertThat(customerCount(occupiedCode)).isOne();
        assertThat(customerCount(freeCode)).isZero();
        assertThat(confirmLogCount(job.id())).isZero();
    }

    @Test
    void confirmCreatesDraftVersionZeroAndSerialReplayIsIdempotent() throws Exception {
        var firstCode = fixturePrefix + "SER-1";
        var secondCode = fixturePrefix + "SER-2";
        var job = preview(customerWorkbook(List.of(
            Map.of("code", firstCode, "name", "串行客户一"),
            Map.of("code", secondCode, "name", "串行客户二")
        )));
        assertThat(job.status()).isEqualTo("VALIDATED");
        assertThat(customerCount(firstCode, secondCode)).isZero();

        var committed = importService.confirm(job.id(), 1, 100);
        var replayed = importService.confirm(job.id(), 1, 100);

        assertThat(committed.status()).isEqualTo("COMMITTED");
        assertThat(committed.committedRows()).isEqualTo(2);
        assertThat(replayed.status()).isEqualTo("COMMITTED");
        assertThat(replayed.id()).isEqualTo(committed.id());
        assertThat(replayed.committedRows()).isEqualTo(2);
        assertThat(jdbcTemplate.queryForList("""
            SELECT code, audit_status AS "auditStatus", version
            FROM md_customer
            WHERE code IN (?, ?)
            ORDER BY code
            """, firstCode, secondCode))
            .hasSize(2)
            .allSatisfy(row -> {
                assertThat(row.get("auditStatus")).isEqualTo("DRAFT");
                assertThat(Number.class.cast(row.get("version")).longValue()).isZero();
            });
        assertThat(confirmLogCount(job.id())).isOne();
        assertThat(batch(job.id()))
            .containsEntry("status", "COMMITTED")
            .containsEntry("committedRows", 2)
            .containsEntry("rowsPayload", "[]");
    }

    @Test
    void confirmRevalidatesDriftAndLeavesEarlierValidRowsUnwritten() throws Exception {
        var untouchedCode = fixturePrefix + "ATOMIC-1";
        var racedCode = fixturePrefix + "ATOMIC-2";
        var job = preview(customerWorkbook(List.of(
            Map.of("code", untouchedCode, "name", "原子客户一"),
            Map.of("code", racedCode, "name", "原子客户二")
        )));
        createService.create("customer", Map.of("code", racedCode, "name", "人工占用编码"));

        assertThatThrownBy(() -> importService.confirm(job.id(), 1, 100))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(409));

        assertThat(customerCount(untouchedCode)).isZero();
        assertThat(customerCount(racedCode)).isOne();
        assertThat(batch(job.id()))
            .containsEntry("status", "STALE")
            .containsEntry("committedRows", 0);
        assertThat(confirmLogCount(job.id())).isZero();
    }

    @Test
    void failureAfterFirstBusinessInsertRollsBackEveryRowAndKeepsRecoverableBatchFacts() throws Exception {
        var firstCode = fixturePrefix + "ROLLBACK-1";
        var secondCode = fixturePrefix + "ROLLBACK-2";
        var job = preview(customerWorkbook(List.of(
            Map.of("code", firstCode, "name", "事务回滚客户一"),
            Map.of("code", secondCode, "name", "事务回滚客户二")
        )));
        installCustomerInsertFailureTrigger(secondCode);
        try {
            assertThatThrownBy(() -> importService.confirm(job.id(), 1, 100))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(500));
        } finally {
            dropTestDatabaseGuards();
        }

        assertThat(customerCount(firstCode, secondCode)).isZero();
        assertThat(confirmLogCount(job.id())).isZero();
        assertThat(batch(job.id()))
            .containsEntry("status", "FAILED")
            .containsEntry("committedRows", 0)
            .containsEntry("failureReason", "确认事务失败: DataAccessResourceFailureException")
            .satisfies(value -> assertThat(value.get("rowsPayload")).isNotEqualTo("[]"));
    }

    @Test
    void confirmationLogFailureRollsBackBusinessRowsAndCommittedState() throws Exception {
        var firstCode = fixturePrefix + "LOG-ROLLBACK-1";
        var secondCode = fixturePrefix + "LOG-ROLLBACK-2";
        var job = preview(customerWorkbook(List.of(
            Map.of("code", firstCode, "name", "日志回滚客户一"),
            Map.of("code", secondCode, "name", "日志回滚客户二")
        )));
        installConfirmationLogFailureTrigger();
        try {
            assertThatThrownBy(() -> importService.confirm(job.id(), 1, 100))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(500));
        } finally {
            dropTestDatabaseGuards();
        }

        assertThat(customerCount(firstCode, secondCode)).isZero();
        assertThat(confirmLogCount(job.id())).isZero();
        assertThat(batch(job.id()))
            .containsEntry("status", "FAILED")
            .containsEntry("committedRows", 0)
            .containsEntry("failureReason", "确认事务失败: DataAccessResourceFailureException")
            .satisfies(value -> assertThat(value.get("rowsPayload")).isNotEqualTo("[]"));
    }

    @Test
    void concurrentConfirmCommitsExactlyOnce() throws Exception {
        var firstCode = fixturePrefix + "CON-1";
        var secondCode = fixturePrefix + "CON-2";
        var job = preview(customerWorkbook(List.of(
            Map.of("code", firstCode, "name", "并发客户一"),
            Map.of("code", secondCode, "name", "并发客户二")
        )));
        var advisoryLockKey = 143_000_143;
        installCustomerContentionTrigger(firstCode, advisoryLockKey);
        var firstConfirmEntered = new CountDownLatch(1);
        var secondConfirmEntered = new CountDownLatch(1);

        try {
            try (var executor = Executors.newFixedThreadPool(2)) {
                var first = executor.submit(() -> confirmWithEntrySignal(admin, job.id(), firstConfirmEntered));
                assertThat(firstConfirmEntered.await(10, TimeUnit.SECONDS)).isTrue();
                assertThat(waitForAdvisoryLock(advisoryLockKey, 10, TimeUnit.SECONDS)).isTrue();
                var second = executor.submit(() -> confirmWithEntrySignal(admin, job.id(), secondConfirmEntered));
                assertThat(secondConfirmEntered.await(10, TimeUnit.SECONDS)).isTrue();

                assertThatThrownBy(() -> second.get(500, TimeUnit.MILLISECONDS))
                    .isInstanceOf(TimeoutException.class);

                assertThat(first.get(30, TimeUnit.SECONDS).status()).isEqualTo("COMMITTED");
                assertThat(second.get(30, TimeUnit.SECONDS).status()).isEqualTo("COMMITTED");
            }
        } finally {
            bind(admin);
            dropTestDatabaseGuards();
        }
        bind(admin);

        assertThat(customerCount(firstCode, secondCode)).isEqualTo(2);
        assertThat(confirmLogCount(job.id())).isOne();
        assertThat(batch(job.id()))
            .containsEntry("status", "COMMITTED")
            .containsEntry("committedRows", 2);
    }

    @Test
    void allEightImportTypesPreviewAndConfirmAsDraftVersionZeroWithLockedStatusSemantics() throws Exception {
        var referenceCategory = fixturePrefix + "REF-CAT";
        var referenceUnit = fixturePrefix + "REF-UNIT";
        createService.create("productCategory", Map.of(
            "code", referenceCategory,
            "name", fixturePrefix + "已审核引用类别"
        ));
        createService.create("unit", Map.of("code", referenceUnit));
        jdbcTemplate.update(
            "UPDATE md_product_category SET audit_status = 'AUDITED', enabled = TRUE WHERE code = ?",
            referenceCategory
        );
        jdbcTemplate.update(
            "UPDATE md_unit SET audit_status = 'AUDITED', enabled = TRUE WHERE code = ?",
            referenceUnit
        );

        var categoryCode = fixturePrefix + "CAT";
        var unitCode = fixturePrefix + "UNIT";
        var customerCode = fixturePrefix + "CUS";
        var supplierCode = fixturePrefix + "SUP";
        var warehouseCode = fixturePrefix + "WH";
        var employeeCode = fixturePrefix + "EMP";
        var cashCode = fixturePrefix + "CASH";
        var bankCode = fixturePrefix + "BANK";
        var productCode = fixturePrefix + "PROD";

        assertCommitted("productCategory", List.of(Map.of(
            "code", categoryCode,
            "name", fixturePrefix + "导入类别",
            "status", "禁用"
        )), 1);
        assertCommitted("unit", List.of(Map.of("code", unitCode)), 1);
        assertCommitted("customer", List.of(Map.of(
            "code", customerCode,
            "name", "八类导入客户",
            "status", "禁用"
        )), 1);
        assertCommitted("supplier", List.of(Map.of(
            "code", supplierCode,
            "name", "八类导入供应商"
        )), 1);
        assertCommitted("warehouse", List.of(Map.of(
            "code", warehouseCode,
            "name", "八类导入仓库",
            "status", "禁用"
        )), 1);
        assertCommitted("employee", List.of(Map.of(
            "code", employeeCode,
            "name", "八类导入员工"
        )), 1);
        assertCommitted("financialAccount", List.of(
            Map.of(
                "code", cashCode,
                "name", "CNY 现金账户",
                "accountType", "CASH",
                "currency", "CNY"
            ),
            Map.of(
                "code", bankCode,
                "name", "USD 银行账户",
                "accountType", "BANK",
                "currency", "USD",
                "bankName", "Test Bank",
                "accountNo", "0000123400",
                "accountHolder", "JDY Test",
                "status", "禁用"
            )
        ), 2);
        assertCommitted("product", List.of(Map.of(
            "code", productCode,
            "name", "八类导入物料",
            "category", referenceCategory,
            "unit", referenceUnit
        )), 1);

        assertDraft("productCategory", categoryCode, false);
        assertDraft("unit", unitCode, true);
        assertDraft("customer", customerCode, false);
        assertDraft("supplier", supplierCode, true);
        assertDraft("warehouse", warehouseCode, false);
        assertDraft("employee", employeeCode, true);
        assertDraft("financialAccount", cashCode, true);
        assertDraft("financialAccount", bankCode, false);
        assertDraft("product", productCode, true);

        assertThat(jdbcTemplate.queryForMap("""
            SELECT account_type AS "accountType", currency, bank_name AS "bankName",
                   account_no AS "accountNo", account_holder AS "accountHolder"
            FROM md_financial_account
            WHERE code = ?
            """, cashCode))
            .containsEntry("accountType", "CASH")
            .containsEntry("currency", "CNY")
            .containsEntry("bankName", null)
            .containsEntry("accountNo", null)
            .containsEntry("accountHolder", null);
        assertThat(jdbcTemplate.queryForMap("""
            SELECT account_type AS "accountType", currency, bank_name AS "bankName",
                   account_no AS "accountNo", account_holder AS "accountHolder"
            FROM md_financial_account
            WHERE code = ?
            """, bankCode))
            .containsEntry("accountType", "BANK")
            .containsEntry("currency", "USD")
            .containsEntry("bankName", "Test Bank")
            .containsEntry("accountNo", "0000123400")
            .containsEntry("accountHolder", "JDY Test");
        assertThat(jdbcTemplate.queryForMap("""
            SELECT category_ref.code AS "categoryCode",
                   unit_ref.code AS "unitCode",
                   product.is_sale AS "isSale",
                   product.is_purchase AS "isPurchase",
                   product.is_inventory AS "isInventory",
                   product.is_produce AS "isProduce",
                   product.is_subcontract AS "isSubcontract",
                   product.product_type AS "productType",
                   product.issue_method AS "issueMethod"
            FROM md_product product
            JOIN md_product_category category_ref ON category_ref.id = product.product_category_id
            JOIN md_unit unit_ref ON unit_ref.id = product.unit_id
            WHERE product.code = ?
            """, productCode))
            .containsEntry("categoryCode", referenceCategory)
            .containsEntry("unitCode", referenceUnit)
            .containsEntry("isSale", true)
            .containsEntry("isPurchase", false)
            .containsEntry("isInventory", true)
            .containsEntry("isProduce", true)
            .containsEntry("isSubcontract", false)
            .containsEntry("productType", "普通")
            .containsEntry("issueMethod", "按单领料");
    }

    @Test
    void financialAccountErrorsKeepExactExcelRowAndFieldForCurrencyAndBankRules() throws Exception {
        var invalidCurrencyCode = fixturePrefix + "BAD-CURRENCY";
        var invalidCashCode = fixturePrefix + "BAD-CASH";
        var job = preview("financialAccount", workbook("financialAccount", List.of(
            Map.of(
                "code", invalidCurrencyCode,
                "name", "非法币种账户",
                "accountType", "CASH",
                "currency", "EUR"
            ),
            Map.of(
                "code", invalidCashCode,
                "name", "非法现金账户",
                "accountType", "CASH",
                "currency", "CNY",
                "bankName", "现金账户不应有银行"
            )
        )));

        assertThat(job.status()).isEqualTo("INVALID");
        assertThat(job.errorRows()).isEqualTo(2);
        assertThat(job.rows()).filteredOn(row -> row.rowNo() == 3).singleElement().satisfies(row ->
            assertThat(row.errors())
                .extracting(
                    MasterDataImportWorkbookService.RowError::rowNo,
                    MasterDataImportWorkbookService.RowError::field,
                    MasterDataImportWorkbookService.RowError::code
                )
                .contains(org.assertj.core.groups.Tuple.tuple(3, "currency", "INVALID_ENUM"))
        );
        assertThat(job.rows()).filteredOn(row -> row.rowNo() == 4).singleElement().satisfies(row ->
            assertThat(row.errors())
                .extracting(
                    MasterDataImportWorkbookService.RowError::rowNo,
                    MasterDataImportWorkbookService.RowError::field,
                    MasterDataImportWorkbookService.RowError::code
                )
                .contains(org.assertj.core.groups.Tuple.tuple(4, "bankName", "FIELD_NOT_ALLOWED"))
        );
        assertThat(masterCount("financialAccount", invalidCurrencyCode)).isZero();
        assertThat(masterCount("financialAccount", invalidCashCode)).isZero();
    }

    @Test
    void categoryReverseOrderedParentChildCreatesParentFirstAndCycleIsInvalid() throws Exception {
        var parentCode = fixturePrefix + "PARENT";
        var childCode = fixturePrefix + "CHILD";
        installCategoryParentOrderTrigger();
        MasterDataImportService.JobView committed;
        try {
            committed = assertCommitted("productCategory", List.of(
                Map.of(
                    "code", childCode,
                    "name", fixturePrefix + "子类别",
                    "parentCode", parentCode
                ),
                Map.of(
                    "code", parentCode,
                    "name", fixturePrefix + "父类别"
                )
            ), 2);
        } finally {
            dropTestDatabaseGuards();
        }

        assertThat(committed.status()).isEqualTo("COMMITTED");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT parent_code FROM md_product_category WHERE code = ?",
            String.class,
            childCode
        )).isEqualTo(parentCode);

        var cycleA = fixturePrefix + "CYCLE-A";
        var cycleB = fixturePrefix + "CYCLE-B";
        var invalid = preview("productCategory", workbook("productCategory", List.of(
            Map.of(
                "code", cycleA,
                "name", fixturePrefix + "环A",
                "parentCode", cycleB
            ),
            Map.of(
                "code", cycleB,
                "name", fixturePrefix + "环B",
                "parentCode", cycleA
            )
        )));

        assertThat(invalid.status()).isEqualTo("INVALID");
        assertThat(invalid.errorRows()).isEqualTo(2);
        assertThat(invalid.rows()).allSatisfy(row -> assertThat(row.errors())
            .extracting(
                MasterDataImportWorkbookService.RowError::field,
                MasterDataImportWorkbookService.RowError::code
            )
            .contains(org.assertj.core.groups.Tuple.tuple("parentCode", "CATEGORY_PARENT_CYCLE")));
        assertThat(masterCount("productCategory", cycleA)).isZero();
        assertThat(masterCount("productCategory", cycleB)).isZero();
    }

    @Test
    void categoryImportRejectsCycleClosedThroughExistingDanglingParent() throws Exception {
        var existingCode = fixturePrefix + "EXISTING-PARENT";
        var importedCode = fixturePrefix + "IMPORTED-PARENT";
        createService.create("productCategory", Map.of(
            "code", existingCode,
            "name", fixturePrefix + "既有类别",
            "parentCode", importedCode
        ));

        var invalid = preview("productCategory", workbook("productCategory", List.of(Map.of(
            "code", importedCode,
            "name", fixturePrefix + "待导入类别",
            "parentCode", existingCode
        ))));

        assertThat(invalid.status()).isEqualTo("INVALID");
        assertThat(invalid.errorRows()).isOne();
        assertThat(invalid.rows()).singleElement().satisfies(row -> assertThat(row.errors())
            .extracting(
                MasterDataImportWorkbookService.RowError::field,
                MasterDataImportWorkbookService.RowError::code
            )
            .contains(org.assertj.core.groups.Tuple.tuple("parentCode", "CATEGORY_PARENT_CYCLE")));
        assertThat(masterCount("productCategory", importedCode)).isZero();
    }

    @Test
    void expiredJobReturnsGoneAndClearsConfirmablePayload() throws Exception {
        var code = fixturePrefix + "EXP";
        var job = preview(customerWorkbook(List.of(Map.of("code", code, "name", "过期客户"))));
        jdbcTemplate.update("""
            UPDATE md_import_batch
            SET created_at = now() - interval '1 hour',
                expires_at = now() - interval '1 minute',
                updated_at = now()
            WHERE id = ?::uuid
            """, job.id());

        var expired = importService.get(job.id(), 1, 100);

        assertThat(expired.status()).isEqualTo("EXPIRED");
        assertThat(expired.canConfirm()).isFalse();
        assertThat(expired.rows()).isEmpty();
        assertThatThrownBy(() -> importService.errorReceipt(job.id()))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(410));
        assertThatThrownBy(() -> importService.confirm(job.id(), 1, 100))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(410));
        assertThat(customerCount(code)).isZero();
        assertThat(batch(job.id()))
            .containsEntry("status", "EXPIRED")
            .containsEntry("rowsPayload", "[]");
    }

    private void installCustomerInsertFailureTrigger(String failureCode) {
        dropTestDatabaseGuards();
        jdbcTemplate.execute("""
            CREATE FUNCTION a143_test_fail_customer_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $function$
            BEGIN
                IF NEW.code = %s THEN
                    RAISE EXCEPTION 'A143 injected second customer insert failure'
                        USING ERRCODE = '58000';
                END IF;
                RETURN NEW;
            END
            $function$
            """.formatted(sqlLiteral(failureCode)));
        jdbcTemplate.execute("""
            CREATE TRIGGER a143_test_fail_customer_insert_trigger
            BEFORE INSERT ON md_customer
            FOR EACH ROW EXECUTE FUNCTION a143_test_fail_customer_insert()
            """);
    }

    private void installConfirmationLogFailureTrigger() {
        dropTestDatabaseGuards();
        jdbcTemplate.execute("""
            CREATE FUNCTION a143_test_fail_confirmation_log()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $function$
            BEGIN
                IF NEW.action_code = 'CONFIRM_MASTER_DATA_IMPORT'
                   AND NEW.target_type = 'MASTER_DATA_IMPORT' THEN
                    RAISE EXCEPTION 'A143 injected confirmation log failure'
                        USING ERRCODE = '58000';
                END IF;
                RETURN NEW;
            END
            $function$
            """);
        jdbcTemplate.execute("""
            CREATE TRIGGER a143_test_fail_confirmation_log_trigger
            BEFORE INSERT ON sys_operation_log
            FOR EACH ROW EXECUTE FUNCTION a143_test_fail_confirmation_log()
            """);
    }

    private void installCustomerContentionTrigger(String delayedCode, int advisoryLockKey) {
        dropTestDatabaseGuards();
        jdbcTemplate.execute("""
            CREATE FUNCTION a143_test_hold_customer_insert()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $function$
            BEGIN
                IF NEW.code = %s THEN
                    PERFORM pg_advisory_xact_lock(%d);
                    PERFORM pg_sleep(2);
                END IF;
                RETURN NEW;
            END
            $function$
            """.formatted(sqlLiteral(delayedCode), advisoryLockKey));
        jdbcTemplate.execute("""
            CREATE TRIGGER a143_test_hold_customer_insert_trigger
            BEFORE INSERT ON md_customer
            FOR EACH ROW EXECUTE FUNCTION a143_test_hold_customer_insert()
            """);
    }

    private void installCategoryParentOrderTrigger() {
        dropTestDatabaseGuards();
        jdbcTemplate.execute("""
            CREATE FUNCTION a143_test_require_category_parent_first()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $function$
            BEGIN
                IF NULLIF(btrim(NEW.parent_code), '') IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM md_product_category parent WHERE parent.code = NEW.parent_code
                   ) THEN
                    RAISE EXCEPTION 'A143 child category inserted before its parent'
                        USING ERRCODE = '58000';
                END IF;
                RETURN NEW;
            END
            $function$
            """);
        jdbcTemplate.execute("""
            CREATE TRIGGER a143_test_require_category_parent_first_trigger
            BEFORE INSERT ON md_product_category
            FOR EACH ROW EXECUTE FUNCTION a143_test_require_category_parent_first()
            """);
    }

    private boolean waitForAdvisoryLock(int advisoryLockKey, long timeout, TimeUnit unit) throws InterruptedException {
        var deadline = System.nanoTime() + unit.toNanos(timeout);
        while (System.nanoTime() < deadline) {
            var held = jdbcTemplate.queryForObject("""
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_locks
                    WHERE locktype = 'advisory'
                      AND classid = 0
                      AND objid = ?::oid
                      AND granted = TRUE
                )
                """, Boolean.class, advisoryLockKey);
            if (Boolean.TRUE.equals(held)) {
                return true;
            }
            Thread.sleep(25);
        }
        return false;
    }

    private void dropTestDatabaseGuards() {
        jdbcTemplate.execute("DROP TRIGGER IF EXISTS a143_test_fail_customer_insert_trigger ON md_customer");
        jdbcTemplate.execute("DROP TRIGGER IF EXISTS a143_test_hold_customer_insert_trigger ON md_customer");
        jdbcTemplate.execute("DROP TRIGGER IF EXISTS a143_test_fail_confirmation_log_trigger ON sys_operation_log");
        jdbcTemplate.execute("DROP TRIGGER IF EXISTS a143_test_require_category_parent_first_trigger ON md_product_category");
        jdbcTemplate.execute("DROP FUNCTION IF EXISTS a143_test_fail_customer_insert()");
        jdbcTemplate.execute("DROP FUNCTION IF EXISTS a143_test_hold_customer_insert()");
        jdbcTemplate.execute("DROP FUNCTION IF EXISTS a143_test_fail_confirmation_log()");
        jdbcTemplate.execute("DROP FUNCTION IF EXISTS a143_test_require_category_parent_first()");
    }

    private String sqlLiteral(String value) {
        return "'" + value.replace("'", "''") + "'";
    }

    private MasterDataImportService.JobView confirmWithEntrySignal(
        MockHttpSession session,
        String jobId,
        CountDownLatch entered
    ) throws Exception {
        try {
            bind(session);
            entered.countDown();
            return importService.confirm(jobId, 1, 100);
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private MasterDataImportService.JobView preview(byte[] bytes) {
        return preview("customer", bytes);
    }

    private MasterDataImportService.JobView preview(String type, byte[] bytes) {
        var result = importService.preview(
            type,
            fixturePrefix + type + ".xlsx",
            bytes.length,
            new ByteArrayInputStream(bytes),
            1,
            100
        );
        jobIds.add(result.id());
        return result;
    }

    private MasterDataImportService.JobView assertCommitted(
        String type,
        List<Map<String, String>> rows,
        int expectedRows
    ) throws IOException {
        var preview = preview(type, workbook(type, rows));
        assertThat(preview.status()).isEqualTo("VALIDATED");
        assertThat(preview.totalRows()).isEqualTo(expectedRows);
        assertThat(preview.validRows()).isEqualTo(expectedRows);
        assertThat(preview.errorRows()).isZero();
        assertThat(preview.committedRows()).isZero();
        var committed = importService.confirm(preview.id(), 1, 100);
        assertThat(committed.status()).isEqualTo("COMMITTED");
        assertThat(committed.committedRows()).isEqualTo(expectedRows);
        return committed;
    }

    private void assertDraft(String type, String code, boolean enabled) {
        assertThat(jdbcTemplate.queryForMap("""
            SELECT audit_status AS "auditStatus", version, enabled
            FROM %s
            WHERE code = ?
            """.formatted(tableName(type)), code))
            .containsEntry("auditStatus", "DRAFT")
            .containsEntry("version", 0L)
            .containsEntry("enabled", enabled);
    }

    private int masterCount(String type, String code) {
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM " + tableName(type) + " WHERE code = ?",
            Integer.class,
            code
        );
    }

    private String tableName(String type) {
        return switch (type) {
            case "product" -> "md_product";
            case "productCategory" -> "md_product_category";
            case "unit" -> "md_unit";
            case "customer" -> "md_customer";
            case "supplier" -> "md_supplier";
            case "warehouse" -> "md_warehouse";
            case "employee" -> "md_employee";
            case "financialAccount" -> "md_financial_account";
            default -> throw new IllegalArgumentException("Unsupported test master type: " + type);
        };
    }

    private Map<String, Object> batch(String jobId) {
        return jdbcTemplate.queryForMap("""
            SELECT status,
                   committed_rows AS "committedRows",
                   rows_payload::text AS "rowsPayload",
                   failure_reason AS "failureReason"
            FROM md_import_batch
            WHERE id = ?::uuid
            """, jobId);
    }

    private int customerCount(String... codes) {
        if (codes.length == 1) {
            return jdbcTemplate.queryForObject(
                "SELECT count(*)::int FROM md_customer WHERE code = ?",
                Integer.class,
                codes[0]
            );
        }
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM md_customer WHERE code = ANY (?::text[])",
            Integer.class,
            (Object) codes
        );
    }

    private int confirmLogCount(String jobId) {
        return jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_operation_log
            WHERE target_type = 'MASTER_DATA_IMPORT'
              AND target_id = ?::uuid
              AND action_code = 'CONFIRM_MASTER_DATA_IMPORT'
              AND success = TRUE
            """, Integer.class, jobId);
    }

    private byte[] customerWorkbook(List<Map<String, String>> rows) throws IOException {
        return workbook("customer", rows);
    }

    private byte[] workbook(String type, List<Map<String, String>> rows) throws IOException {
        var definition = definitions.require(type);
        try (var workbook = new XSSFWorkbook();
             var output = new ByteArrayOutputStream()) {
            var data = workbook.createSheet(MasterDataImportDefinitionRegistry.DATA_SHEET);
            data.createRow(0).createCell(0).setCellValue(definition.title() + "导入模板");
            var header = data.createRow(1);
            for (int column = 0; column < definition.headers().size(); column++) {
                header.createCell(column).setCellValue(definition.headers().get(column));
            }
            for (int index = 0; index < rows.size(); index++) {
                var row = data.createRow(index + 2);
                for (var value : rows.get(index).entrySet()) {
                    setByKey(row, definition, value.getKey(), value.getValue());
                }
            }
            workbook.createSheet(MasterDataImportDefinitionRegistry.GUIDE_SHEET)
                .createRow(0)
                .createCell(0)
                .setCellValue("填写说明");
            var meta = workbook.createSheet(MasterDataImportDefinitionRegistry.META_SHEET);
            var metadata = List.of(
                List.of("key", "value"),
                List.of("contract", "A143"),
                List.of("type", definition.type()),
                List.of("version", "1"),
                List.of("dataSheet", MasterDataImportDefinitionRegistry.DATA_SHEET),
                List.of("headerRow", "2"),
                List.of("maxDataRows", "5000")
            );
            for (int rowIndex = 0; rowIndex < metadata.size(); rowIndex++) {
                var row = meta.createRow(rowIndex);
                row.createCell(0).setCellValue(metadata.get(rowIndex).get(0));
                row.createCell(1).setCellValue(metadata.get(rowIndex).get(1));
            }
            meta.protectSheet("");
            workbook.setSheetVisibility(workbook.getSheetIndex(meta), SheetVisibility.VERY_HIDDEN);
            workbook.write(output);
            return output.toByteArray();
        }
    }

    private void setByKey(
        org.apache.poi.ss.usermodel.Row row,
        MasterDataImportDefinitionRegistry.ImportDefinition definition,
        String key,
        String value
    ) {
        for (int column = 0; column < definition.fields().size(); column++) {
            if (definition.fields().get(column).key().equals(key)) {
                row.createCell(column).setCellValue(value);
                return;
            }
        }
        throw new IllegalArgumentException("Unknown field: " + key);
    }

    private MockHttpSession login(String username, String password, String accountSetCode) throws Exception {
        var session = new MockHttpSession();
        mockMvc.perform(post("/api/system/login")
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "username", username,
                    "password", password,
                    "accountSetCode", accountSetCode
                ))))
            .andExpect(status().isOk());
        return session;
    }

    private void bind(MockHttpSession session) {
        TenantContext.clear();
        var request = new MockHttpServletRequest();
        request.setSession(session);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }
}
