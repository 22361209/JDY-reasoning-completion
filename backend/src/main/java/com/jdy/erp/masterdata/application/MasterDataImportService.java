package com.jdy.erp.masterdata.application;

import java.io.InputStream;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.masterdata.application.MasterDataCreateService.CreateOptions;
import com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.ImportDefinition;
import com.jdy.erp.masterdata.application.MasterDataImportWorkbookService.ParsedRow;
import com.jdy.erp.masterdata.application.MasterDataImportWorkbookService.ReceiptError;
import com.jdy.erp.masterdata.application.MasterDataImportWorkbookService.RowError;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
public final class MasterDataImportService {
    private static final int DEFAULT_ROW_PAGE_SIZE = 100;
    private static final int MAX_ROW_PAGE_SIZE = 500;
    private static final int DEFAULT_JOB_PAGE_SIZE = 20;
    private static final int MAX_JOB_PAGE_SIZE = 100;
    private static final TypeReference<List<StoredRow>> STORED_ROWS_TYPE = new TypeReference<>() {
    };

    private final JdbcTemplate jdbcTemplate;
    private final MasterDataImportDefinitionRegistry definitions;
    private final MasterDataImportWorkbookService workbookService;
    private final MasterDataCreateService createService;
    private final CurrentSessionService currentSessionService;
    private final OperationLogService operationLogService;
    private final ObjectMapper objectMapper;
    private final TransactionTemplate transactions;

    public MasterDataImportService(
        JdbcTemplate jdbcTemplate,
        MasterDataImportDefinitionRegistry definitions,
        MasterDataImportWorkbookService workbookService,
        MasterDataCreateService createService,
        CurrentSessionService currentSessionService,
        OperationLogService operationLogService,
        ObjectMapper objectMapper,
        PlatformTransactionManager transactionManager
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.definitions = definitions;
        this.workbookService = workbookService;
        this.createService = createService;
        this.currentSessionService = currentSessionService;
        this.operationLogService = operationLogService;
        this.objectMapper = objectMapper;
        this.transactions = new TransactionTemplate(transactionManager);
    }

    public List<TemplateView> templates() {
        return definitions.all().stream().map(definition -> new TemplateView(
            definition.type(),
            definition.title(),
            MasterDataImportDefinitionRegistry.TEMPLATE_VERSION,
            definition.fileName(),
            "仅新增，确认后保存为草稿；任一错误整批不写入",
            MasterDataImportDefinitionRegistry.MAX_DATA_ROWS,
            MasterDataImportDefinitionRegistry.MAX_FILE_BYTES,
            "/api/master-data/import/templates/" + definition.type()
        )).toList();
    }

    public ImportDefinition template(String type) {
        return definitions.require(type);
    }

    public JobView preview(
        String type,
        String originalFilename,
        long declaredSize,
        InputStream source,
        int rowPage,
        int rowPageSize
    ) {
        var scope = currentScope();
        var definition = definitions.require(type);
        var parsed = workbookService.parse(definition, originalFilename, declaredSize, source);
        if (parsed.rows().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Excel 未包含非空数据行");
        }
        var validated = validateRows(definition, parsed.rows().stream().map(StoredRow::from).toList(), false);
        var validRows = (int) validated.stream().filter(StoredRow::valid).count();
        var errorRows = validated.size() - validRows;
        var status = errorRows == 0 ? JobStatus.VALIDATED : JobStatus.INVALID;
        var serializedRows = writeRows(validated);
        var jobId = Objects.requireNonNull(transactions.execute(ignored -> {
            var id = jdbcTemplate.queryForObject("""
                INSERT INTO md_import_batch (
                    account_set_id, account_set_code, created_by, created_by_username,
                    import_type, template_version, original_file_name, file_sha256, file_size_bytes,
                    status, total_rows, valid_rows, error_rows, committed_rows,
                    rows_payload, expires_at
                )
                VALUES (
                    ?::uuid, ?, ?::uuid, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, 0,
                    ?::jsonb, now() + interval '30 minutes'
                )
                RETURNING id::text
                """,
                String.class,
                scope.accountSetId().toString(),
                scope.accountSetCode(),
                scope.userId().toString(),
                scope.username(),
                definition.type(),
                parsed.templateVersion(),
                safeOriginalFilename(originalFilename),
                parsed.sha256(),
                parsed.fileSizeBytes(),
                status.name(),
                validated.size(),
                validRows,
                errorRows,
                serializedRows
            );
            var batchId = UUID.fromString(id);
            operationLogService.logCurrent(OperationLogCommand.success(
                "MASTER_DATA",
                "PREVIEW_MASTER_DATA_IMPORT",
                "MASTER_DATA_IMPORT",
                batchId,
                definition.type(),
                OperationLogCommand.ActorMode.CURRENT_USER,
                null,
                Map.of(),
                OperationLogCommand.state(
                    OperationLogCommand.StateField.STATUS, status.name(),
                    OperationLogCommand.StateField.SOURCE_COUNT, validated.size(),
                    OperationLogCommand.StateField.VERSION, 0
                ),
                summaryReason(definition.type(), validated.size(), errorRows, parsed.sha256())
            ));
            return batchId;
        }));
        return get(jobId.toString(), rowPage, rowPageSize);
    }

    public JobPage list(int requestedPage, int requestedPageSize) {
        var page = positivePage(requestedPage);
        var pageSize = boundedPageSize(requestedPageSize, DEFAULT_JOB_PAGE_SIZE, MAX_JOB_PAGE_SIZE);
        var scope = currentScope();
        expireOwned(scope, null);
        var total = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM md_import_batch
            WHERE account_set_id = ?::uuid
              AND account_set_code = ?
              AND created_by = ?::uuid
              AND created_by_username = ?
            """, Long.class,
            scope.accountSetId().toString(), scope.accountSetCode(), scope.userId().toString(), scope.username()
        );
        var jobs = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   import_type AS type,
                   template_version AS "templateVersion",
                   original_file_name AS "fileName",
                   file_sha256 AS "fileSha256",
                   file_size_bytes AS "fileSizeBytes",
                   status,
                   total_rows AS "totalRows",
                   valid_rows AS "validRows",
                   error_rows AS "errorRows",
                   committed_rows AS "committedRows",
                   created_at AS "createdAt",
                   expires_at AS "expiresAt",
                   committed_at AS "committedAt",
                   version
            FROM md_import_batch
            WHERE account_set_id = ?::uuid
              AND account_set_code = ?
              AND created_by = ?::uuid
              AND created_by_username = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            scope.accountSetId().toString(), scope.accountSetCode(), scope.userId().toString(), scope.username(),
            pageSize, pageOffset(page, pageSize)
        ).stream().map(row -> view(row, List.of(), 1, 0, 0)).toList();
        return new JobPage(page, pageSize, total == null ? 0 : total, jobs);
    }

    public JobView get(String jobId, int requestedRowPage, int requestedRowPageSize) {
        var id = visibleJobId(jobId);
        var page = positivePage(requestedRowPage);
        var pageSize = boundedPageSize(requestedRowPageSize, DEFAULT_ROW_PAGE_SIZE, MAX_ROW_PAGE_SIZE);
        var scope = currentScope();
        expireOwned(scope, id);
        var row = ownedJob(scope, id, false);
        var storedRows = readRows(String.valueOf(row.get("rowsPayload")));
        var offset = boundedOffset(page, pageSize, storedRows.size());
        var end = Math.min(offset + pageSize, storedRows.size());
        var rows = storedRows.subList(offset, end).stream().map(StoredRow::view).toList();
        return view(row, rows, page, pageSize, storedRows.size());
    }

    public Receipt errorReceipt(String jobId) {
        var id = visibleJobId(jobId);
        var scope = currentScope();
        expireOwned(scope, id);
        var row = ownedJob(scope, id, false);
        var status = JobStatus.valueOf(String.valueOf(row.get("status")));
        if (status == JobStatus.EXPIRED) {
            throw new ResponseStatusException(HttpStatus.GONE, "预检任务已过期，请重新上传并预检");
        }
        var storedRows = readRows(String.valueOf(row.get("rowsPayload")));
        var errors = storedRows.stream().flatMap(stored -> stored.errors().stream().map(error -> new ReceiptError(
            error.rowNo(),
            stored.payload().get("code"),
            error.field(),
            error.code(),
            error.message(),
            error.value()
        ))).toList();
        var bytes = workbookService.createErrorReceipt(String.valueOf(row.get("type")), errors);
        return new Receipt("master-data-import-" + id + "-errors.xlsx", bytes);
    }

    public JobView confirm(String jobId, int requestedRowPage, int requestedRowPageSize) {
        var id = visibleJobId(jobId);
        var page = positivePage(requestedRowPage);
        var pageSize = boundedPageSize(requestedRowPageSize, DEFAULT_ROW_PAGE_SIZE, MAX_ROW_PAGE_SIZE);
        final ConfirmOutcome outcome;
        try {
            outcome = Objects.requireNonNull(transactions.execute(ignored -> confirmInTransaction(id, page, pageSize)));
        } catch (DataIntegrityViolationException | ResponseStatusException exception) {
            var raced = markAfterRollback(id, true, exception);
            if (raced.status() == JobStatus.COMMITTED) {
                return raced.job();
            }
            if (raced.status() == JobStatus.EXPIRED) {
                throw new ResponseStatusException(HttpStatus.GONE, "预检任务已过期，请重新上传并预检");
            }
            throw new ResponseStatusException(HttpStatus.CONFLICT, "确认时资料已变化，整批未写入");
        } catch (RuntimeException exception) {
            var failed = markAfterRollback(id, false, exception);
            if (failed.status() == JobStatus.COMMITTED) {
                return failed.job();
            }
            if (failed.status() == JobStatus.EXPIRED) {
                throw new ResponseStatusException(HttpStatus.GONE, "预检任务已过期，请重新上传并预检");
            }
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "导入确认失败，整批已回滚");
        }
        return switch (outcome.status()) {
            case COMMITTED -> outcome.job();
            case EXPIRED -> throw new ResponseStatusException(HttpStatus.GONE, "预检任务已过期，请重新上传并预检");
            case STALE -> throw new ResponseStatusException(HttpStatus.CONFLICT, "确认时资料已变化，整批未写入");
            default -> throw new ResponseStatusException(HttpStatus.CONFLICT, "当前任务状态不允许确认");
        };
    }

    private ConfirmOutcome confirmInTransaction(UUID id, int page, int pageSize) {
        var scope = currentScope();
        var row = ownedJob(scope, id, true);
        var status = JobStatus.valueOf(String.valueOf(row.get("status")));
        if (status == JobStatus.COMMITTED) {
            return new ConfirmOutcome(status, view(row, List.of(), page, pageSize, 0));
        }
        if (status == JobStatus.EXPIRED) {
            return new ConfirmOutcome(status, view(row, List.of(), page, pageSize, 0));
        }
        if (!offsetDateTime(row.get("expiresAt")).isAfter(OffsetDateTime.now())) {
            expireLocked(id);
            var expired = ownedJob(scope, id, false);
            return new ConfirmOutcome(JobStatus.EXPIRED, view(expired, List.of(), page, pageSize, 0));
        }
        if (status != JobStatus.VALIDATED) {
            return new ConfirmOutcome(status, view(row, List.of(), page, pageSize, 0));
        }
        var definition = definitions.require(String.valueOf(row.get("type")));
        var storedRows = readRows(String.valueOf(row.get("rowsPayload")));
        var validated = validateRows(definition, storedRows, true);
        var errorRows = (int) validated.stream().filter(stored -> !stored.valid()).count();
        if (errorRows > 0) {
            var validRows = validated.size() - errorRows;
            jdbcTemplate.update("""
                UPDATE md_import_batch
                SET status = 'STALE',
                    valid_rows = ?,
                    error_rows = ?,
                    committed_rows = 0,
                    rows_payload = ?::jsonb,
                    failure_reason = NULL,
                    updated_at = now(),
                    version = version + 1
                WHERE id = ?::uuid
                """, validRows, errorRows, writeRows(validated), id.toString());
            var stale = ownedJob(scope, id, false);
            var visibleRows = pageRows(validated, page, pageSize);
            return new ConfirmOutcome(JobStatus.STALE, view(stale, visibleRows, page, pageSize, validated.size()));
        }
        for (var stored : stableCreateOrder(definition, validated)) {
            createService.create(definition.type(), stored.payload(), CreateOptions.importStrict(definition.defaults()));
        }
        jdbcTemplate.update("""
            UPDATE md_import_batch
            SET status = 'COMMITTED',
                valid_rows = total_rows,
                error_rows = 0,
                committed_rows = total_rows,
                rows_payload = '[]'::jsonb,
                failure_reason = NULL,
                committed_at = now(),
                payload_cleared_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, id.toString());
        operationLogService.logCurrent(OperationLogCommand.success(
            "MASTER_DATA",
            "CONFIRM_MASTER_DATA_IMPORT",
            "MASTER_DATA_IMPORT",
            id,
            definition.type(),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, JobStatus.VALIDATED.name(),
                OperationLogCommand.StateField.SOURCE_COUNT, validated.size()
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, JobStatus.COMMITTED.name(),
                OperationLogCommand.StateField.SOURCE_COUNT, validated.size()
            ),
            summaryReason(
                definition.type(),
                validated.size(),
                0,
                String.valueOf(row.get("fileSha256"))
            )
        ));
        var committed = ownedJob(scope, id, false);
        return new ConfirmOutcome(JobStatus.COMMITTED, view(committed, List.of(), page, pageSize, 0));
    }

    private ConfirmOutcome markAfterRollback(UUID id, boolean stale, RuntimeException exception) {
        return Objects.requireNonNull(transactions.execute(ignored -> {
            var scope = currentScope();
            var row = ownedJob(scope, id, true);
            var status = JobStatus.valueOf(String.valueOf(row.get("status")));
            if (status == JobStatus.COMMITTED) {
                return new ConfirmOutcome(status, view(row, List.of(), 1, DEFAULT_ROW_PAGE_SIZE, 0));
            }
            if (status != JobStatus.VALIDATED) {
                return new ConfirmOutcome(status, view(row, List.of(), 1, DEFAULT_ROW_PAGE_SIZE, 0));
            }
            if (stale) {
                var storedRows = readRows(String.valueOf(row.get("rowsPayload")));
                var validated = validateRows(definitions.require(String.valueOf(row.get("type"))), storedRows, true);
                if (validated.stream().allMatch(StoredRow::valid) && !validated.isEmpty()) {
                    var first = validated.getFirst();
                    validated = replaceFirst(validated, first.withError(new RowError(
                        first.rowNo(), "code", "CONFIRM_CONFLICT", "确认时资料已变化，请重新预检", first.payload().get("code")
                    )));
                }
                var errorRows = (int) validated.stream().filter(value -> !value.valid()).count();
                jdbcTemplate.update("""
                    UPDATE md_import_batch
                    SET status = 'STALE',
                        valid_rows = ?,
                        error_rows = ?,
                        rows_payload = ?::jsonb,
                        failure_reason = NULL,
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                    """, validated.size() - errorRows, errorRows, writeRows(validated), id.toString());
                var updated = ownedJob(scope, id, false);
                return new ConfirmOutcome(JobStatus.STALE, view(updated, pageRows(validated, 1, DEFAULT_ROW_PAGE_SIZE), 1, DEFAULT_ROW_PAGE_SIZE, validated.size()));
            }
            jdbcTemplate.update("""
                UPDATE md_import_batch
                SET status = 'FAILED',
                    committed_rows = 0,
                    failure_reason = ?,
                    updated_at = now(),
                    version = version + 1
                WHERE id = ?::uuid
                """, "确认事务失败: " + exception.getClass().getSimpleName(), id.toString());
            var updated = ownedJob(scope, id, false);
            return new ConfirmOutcome(JobStatus.FAILED, view(updated, List.of(), 1, DEFAULT_ROW_PAGE_SIZE, 0));
        }));
    }

    private List<StoredRow> validateRows(
        ImportDefinition definition,
        List<StoredRow> inputRows,
        boolean lockCategoryParents
    ) {
        var rows = inputRows.stream().sorted(Comparator.comparingInt(StoredRow::rowNo)).map(MutableRow::new).toList();
        addFileDuplicateErrors(rows, "code", "DUPLICATE_FILE_CODE", "工作簿内编码重复");
        if ("productCategory".equals(definition.type())) {
            addFileDuplicateErrors(rows, "name", "DUPLICATE_FILE_NAME", "工作簿内类别名称重复");
            validateCategoryParents(rows, lockCategoryParents);
            validateExistingCategoryNames(rows);
        }
        if ("financialAccount".equals(definition.type())) {
            validateFinancialAccountFields(rows);
        }
        for (var row : rows) {
            if (!row.errors.isEmpty()) {
                continue;
            }
            try {
                var validated = createService.validateCreate(
                    definition.type(), row.payload, CreateOptions.importStrict(definition.defaults())
                );
                row.payload.clear();
                row.payload.putAll(validated.normalizedPayload());
            } catch (ResponseStatusException exception) {
                var field = errorField(definition.type(), exception.getReason());
                var code = exception.getStatusCode().value() == HttpStatus.CONFLICT.value()
                    ? "DUPLICATE_DATABASE_CODE"
                    : "BUSINESS_RULE";
                row.addError(field, code, safeReason(exception), row.payload.get(field));
            }
        }
        return rows.stream().map(MutableRow::stored).toList();
    }

    private void validateFinancialAccountFields(List<MutableRow> rows) {
        for (var row : rows) {
            var accountType = normalized(row.payload.get("accountType"));
            if ("CASH".equals(accountType)) {
                addForbiddenBankField(row, "bankName", "CASH 账户不得填写开户行");
                addForbiddenBankField(row, "accountNo", "CASH 账户不得填写账号");
                addForbiddenBankField(row, "accountHolder", "CASH 账户不得填写户名");
                continue;
            }
            if (!Set.of("BANK", "DEPOSIT").contains(accountType)) {
                continue;
            }
            addRequiredBankField(row, "bankName", "BANK/DEPOSIT 账户必须填写开户行");
            addRequiredBankField(row, "accountNo", "BANK/DEPOSIT 账户必须填写账号");
            addRequiredBankField(row, "accountHolder", "BANK/DEPOSIT 账户必须填写户名");
        }
    }

    private void addForbiddenBankField(MutableRow row, String field, String message) {
        var value = row.payload.get(field);
        if (!normalized(value).isBlank()) {
            row.addError(field, "FIELD_NOT_ALLOWED", message, value);
        }
    }

    private void addRequiredBankField(MutableRow row, String field, String message) {
        var value = row.payload.get(field);
        if (normalized(value).isBlank()) {
            row.addError(field, "REQUIRED", message, value);
        }
    }

    private void addFileDuplicateErrors(
        List<MutableRow> rows,
        String field,
        String code,
        String message
    ) {
        var grouped = new LinkedHashMap<String, List<MutableRow>>();
        for (var row : rows) {
            var value = normalized(row.payload.get(field));
            if (!value.isBlank()) {
                grouped.computeIfAbsent(value, ignored -> new ArrayList<>()).add(row);
            }
        }
        grouped.values().stream().filter(group -> group.size() > 1).forEach(group -> group.forEach(row ->
            row.addError(field, code, message, row.payload.get(field))
        ));
    }

    private void validateExistingCategoryNames(List<MutableRow> rows) {
        for (var row : rows) {
            if (!row.errors.isEmpty()) {
                continue;
            }
            var name = row.payload.get("name");
            if (name != null && !jdbcTemplate.queryForList(
                "SELECT 1 FROM md_product_category WHERE name = ? LIMIT 1", name
            ).isEmpty()) {
                row.addError("name", "DUPLICATE_DATABASE_NAME", "当前账套已存在相同类别名称", name);
            }
        }
    }

    private void validateCategoryParents(List<MutableRow> rows, boolean lockExistingParents) {
        var byCode = new LinkedHashMap<String, MutableRow>();
        rows.forEach(row -> {
            var code = normalized(row.payload.get("code"));
            if (!code.isBlank()) {
                byCode.putIfAbsent(code, row);
            }
        });
        for (var row : rows) {
            var code = normalized(row.payload.get("code"));
            var parent = normalized(row.payload.get("parentCode"));
            if (parent.isBlank()) {
                continue;
            }
            if (parent.equals(code)) {
                row.addError("parentCode", "CATEGORY_PARENT_SELF", "上级类别不能引用自身", parent);
            } else if (!byCode.containsKey(parent)) {
                var lockClause = lockExistingParents ? " FOR SHARE" : "";
                if (jdbcTemplate.queryForList(
                    "SELECT 1 FROM md_product_category WHERE code = ? LIMIT 1" + lockClause,
                    parent
                ).isEmpty()) {
                    row.addError("parentCode", "CATEGORY_PARENT_NOT_FOUND", "上级类别编码不存在", parent);
                }
            }
        }
        var cycleCodes = categoryCycleCodes(byCode);
        cycleCodes.forEach(code -> {
            var row = byCode.get(code);
            row.addError("parentCode", "CATEGORY_PARENT_CYCLE", "类别上级关系形成环", row.payload.get("parentCode"));
        });
    }

    private Set<String> categoryCycleCodes(Map<String, MutableRow> byCode) {
        var color = new HashMap<String, Integer>();
        var stack = new ArrayList<String>();
        var cycles = new LinkedHashSet<String>();
        for (var code : byCode.keySet()) {
            visitCategory(code, byCode, color, stack, cycles);
        }
        return cycles;
    }

    private void visitCategory(
        String code,
        Map<String, MutableRow> byCode,
        Map<String, Integer> color,
        List<String> stack,
        Set<String> cycles
    ) {
        var state = color.getOrDefault(code, 0);
        if (state == 2) {
            return;
        }
        if (state == 1) {
            var index = stack.indexOf(code);
            if (index >= 0) {
                cycles.addAll(stack.subList(index, stack.size()));
            }
            return;
        }
        color.put(code, 1);
        stack.add(code);
        var parent = normalized(byCode.get(code).payload.get("parentCode"));
        if (byCode.containsKey(parent)) {
            visitCategory(parent, byCode, color, stack, cycles);
        }
        stack.removeLast();
        color.put(code, 2);
    }

    private List<StoredRow> stableCreateOrder(ImportDefinition definition, List<StoredRow> rows) {
        if (!"productCategory".equals(definition.type())) {
            return rows.stream().sorted(Comparator.comparingInt(StoredRow::rowNo)).toList();
        }
        var byCode = new LinkedHashMap<String, StoredRow>();
        rows.forEach(row -> byCode.put(row.payload().get("code"), row));
        var indegree = new HashMap<String, Integer>();
        var children = new HashMap<String, List<String>>();
        byCode.keySet().forEach(code -> indegree.put(code, 0));
        byCode.forEach((code, row) -> {
            var parent = normalized(row.payload().get("parentCode"));
            if (byCode.containsKey(parent)) {
                indegree.put(code, indegree.get(code) + 1);
                children.computeIfAbsent(parent, ignored -> new ArrayList<>()).add(code);
            }
        });
        var ready = new PriorityQueue<String>(Comparator.comparingInt(code -> byCode.get(code).rowNo()));
        indegree.forEach((code, value) -> {
            if (value == 0) {
                ready.add(code);
            }
        });
        var ordered = new ArrayList<StoredRow>();
        while (!ready.isEmpty()) {
            var code = ready.remove();
            ordered.add(byCode.get(code));
            for (var child : children.getOrDefault(code, List.of())) {
                var next = indegree.compute(child, (ignored, value) -> value - 1);
                if (next == 0) {
                    ready.add(child);
                }
            }
        }
        if (ordered.size() != rows.size()) {
            throw new IllegalStateException("类别拓扑排序失败");
        }
        return List.copyOf(ordered);
    }

    private Map<String, Object> ownedJob(Scope scope, UUID id, boolean forUpdate) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   import_type AS type,
                   template_version AS "templateVersion",
                   original_file_name AS "fileName",
                   file_sha256 AS "fileSha256",
                   file_size_bytes AS "fileSizeBytes",
                   status,
                   total_rows AS "totalRows",
                   valid_rows AS "validRows",
                   error_rows AS "errorRows",
                   committed_rows AS "committedRows",
                   rows_payload::text AS "rowsPayload",
                   created_at AS "createdAt",
                   expires_at AS "expiresAt",
                   committed_at AS "committedAt",
                   version
            FROM md_import_batch
            WHERE id = ?::uuid
              AND account_set_id = ?::uuid
              AND account_set_code = ?
              AND created_by = ?::uuid
              AND created_by_username = ?
            %s
            """.formatted(forUpdate ? "FOR UPDATE" : ""),
            id.toString(), scope.accountSetId().toString(), scope.accountSetCode(),
            scope.userId().toString(), scope.username()
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "导入任务不存在");
        }
        return rows.getFirst();
    }

    private void expireOwned(Scope scope, UUID id) {
        var idClause = id == null ? "" : " AND id = ?::uuid";
        var sql = """
            UPDATE md_import_batch
            SET status = 'EXPIRED',
                rows_payload = '[]'::jsonb,
                committed_rows = 0,
                committed_at = NULL,
                payload_cleared_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE account_set_id = ?::uuid
              AND account_set_code = ?
              AND created_by = ?::uuid
              AND created_by_username = ?
              AND status IN ('VALIDATED', 'INVALID', 'STALE', 'FAILED')
              AND expires_at <= now()
            """ + idClause;
        if (id == null) {
            jdbcTemplate.update(sql,
                scope.accountSetId().toString(), scope.accountSetCode(), scope.userId().toString(), scope.username());
        } else {
            jdbcTemplate.update(sql,
                scope.accountSetId().toString(), scope.accountSetCode(), scope.userId().toString(), scope.username(), id.toString());
        }
    }

    private void expireLocked(UUID id) {
        jdbcTemplate.update("""
            UPDATE md_import_batch
            SET status = 'EXPIRED',
                rows_payload = '[]'::jsonb,
                committed_rows = 0,
                committed_at = NULL,
                payload_cleared_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
              AND status <> 'COMMITTED'
            """, id.toString());
    }

    private JobView view(
        Map<String, Object> row,
        List<JobRowView> rows,
        int rowPage,
        int rowPageSize,
        int rowTotal
    ) {
        var status = JobStatus.valueOf(String.valueOf(row.get("status")));
        var expiresAt = offsetDateTime(row.get("expiresAt"));
        return new JobView(
            String.valueOf(row.get("id")),
            String.valueOf(row.get("type")),
            number(row.get("templateVersion")),
            String.valueOf(row.get("fileName")),
            String.valueOf(row.get("fileSha256")),
            longNumber(row.get("fileSizeBytes")),
            status.name(),
            number(row.get("totalRows")),
            number(row.get("validRows")),
            number(row.get("errorRows")),
            number(row.get("committedRows")),
            status == JobStatus.VALIDATED && expiresAt.isAfter(OffsetDateTime.now()),
            offsetDateTime(row.get("createdAt")),
            expiresAt,
            nullableOffsetDateTime(row.get("committedAt")),
            longNumber(row.get("version")),
            rows,
            rowPage,
            rowPageSize,
            rowTotal
        );
    }

    private List<JobRowView> pageRows(List<StoredRow> rows, int page, int pageSize) {
        var offset = boundedOffset(page, pageSize, rows.size());
        var end = Math.min(offset + pageSize, rows.size());
        return rows.subList(offset, end).stream().map(StoredRow::view).toList();
    }

    private List<StoredRow> readRows(String json) {
        if (json == null || json.isBlank() || "null".equals(json)) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, STORED_ROWS_TYPE).stream()
                .sorted(Comparator.comparingInt(StoredRow::rowNo))
                .toList();
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("导入任务行快照损坏", exception);
        }
    }

    private String writeRows(List<StoredRow> rows) {
        try {
            return objectMapper.writeValueAsString(rows);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("导入任务行快照无法序列化", exception);
        }
    }

    private Scope currentScope() {
        var tenant = TenantContext.requireTenant();
        try {
            return new Scope(
                UUID.fromString(tenant.accountSetId()),
                tenant.accountSetCode(),
                UUID.fromString(currentSessionService.currentUserId()),
                currentSessionService.currentUsername()
            );
        } catch (IllegalArgumentException exception) {
            throw new IllegalStateException("当前导入作用域身份无效", exception);
        }
    }

    private UUID visibleJobId(String value) {
        try {
            return UUID.fromString(value == null ? "" : value.trim());
        } catch (IllegalArgumentException exception) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "导入任务不存在");
        }
    }

    private String errorField(String type, String reason) {
        var text = reason == null ? "" : reason;
        if (text.contains("物料类别")) return "category";
        if (text.contains("计量单位")) return "unit";
        if (text.contains("默认仓库")) return "defaultWarehouseCode";
        if (text.contains("默认供应商")) return "defaultSupplierCode";
        if (text.contains("默认生产车间")) return "defaultWorkshop";
        if (text.contains("账户类型") || text.contains("accountType")) return "accountType";
        if (text.contains("币种") || text.contains("currency")) return "currency";
        if (text.contains("开户行")) return "bankName";
        if (text.contains("账号")) return "accountNo";
        if (text.contains("户名")) return "accountHolder";
        if (text.contains("status")) return "status";
        if (text.contains("name") || text.contains("名称") || text.contains("姓名")) return "name";
        return "code";
    }

    private String safeReason(ResponseStatusException exception) {
        var reason = exception.getReason();
        if (reason == null || reason.isBlank()) {
            return "数据不符合主数据新增规则";
        }
        return reason.length() > 300 ? reason.substring(0, 300) : reason;
    }

    private String summaryReason(String type, int rows, int errors, String sha256) {
        var digestPrefix = sha256 == null ? "unknown" : sha256.substring(0, Math.min(12, sha256.length()));
        return "type=" + type + "; rows=" + rows + "; errors=" + errors + "; sha256=" + digestPrefix;
    }

    private String safeOriginalFilename(String value) {
        var candidate = normalized(value).replace('\\', '/');
        var separator = candidate.lastIndexOf('/');
        if (separator >= 0) {
            candidate = candidate.substring(separator + 1);
        }
        var safe = new StringBuilder(candidate.length());
        candidate.codePoints().forEach(codePoint -> {
            if (!Character.isISOControl(codePoint)) {
                safe.appendCodePoint(codePoint);
            }
        });
        var filename = normalized(safe.toString());
        if (filename.isBlank()) {
            return "import.xlsx";
        }
        var codePoints = filename.codePointCount(0, filename.length());
        if (codePoints <= 255) {
            return filename;
        }
        return filename.substring(filename.offsetByCodePoints(0, codePoints - 255));
    }

    private String normalized(String value) {
        return value == null ? "" : value.trim();
    }

    private int positivePage(int page) {
        return Math.max(1, page);
    }

    private int boundedPageSize(int requested, int defaultValue, int maxValue) {
        return requested <= 0 ? defaultValue : Math.min(requested, maxValue);
    }

    private long pageOffset(int page, int pageSize) {
        return (long) (page - 1) * pageSize;
    }

    private int boundedOffset(int page, int pageSize, int total) {
        return (int) Math.min(pageOffset(page, pageSize), total);
    }

    private int number(Object value) {
        return value == null ? 0 : ((Number) value).intValue();
    }

    private long longNumber(Object value) {
        return value == null ? 0L : ((Number) value).longValue();
    }

    private OffsetDateTime offsetDateTime(Object value) {
        var result = nullableOffsetDateTime(value);
        if (result == null) {
            throw new IllegalStateException("导入任务时间字段缺失");
        }
        return result;
    }

    private OffsetDateTime nullableOffsetDateTime(Object value) {
        if (value == null) return null;
        if (value instanceof OffsetDateTime offsetDateTime) return offsetDateTime;
        if (value instanceof Timestamp timestamp) return timestamp.toInstant().atOffset(ZoneOffset.UTC);
        if (value instanceof Instant instant) return instant.atOffset(ZoneOffset.UTC);
        return OffsetDateTime.parse(String.valueOf(value));
    }

    private List<StoredRow> replaceFirst(List<StoredRow> rows, StoredRow replacement) {
        var result = new ArrayList<>(rows);
        result.set(0, replacement);
        return List.copyOf(result);
    }

    public enum JobStatus {
        VALIDATED,
        INVALID,
        COMMITTED,
        STALE,
        FAILED,
        EXPIRED
    }

    public record TemplateView(
        String type,
        String label,
        int templateVersion,
        String fileName,
        String description,
        int maxRows,
        long maxFileBytes,
        String downloadUrl
    ) {
    }

    public record JobPage(int page, int pageSize, long total, List<JobView> jobs) {
        public JobPage {
            jobs = List.copyOf(jobs);
        }
    }

    public record JobView(
        String id,
        String type,
        int templateVersion,
        String fileName,
        String fileSha256,
        long fileSizeBytes,
        String status,
        int totalRows,
        int validRows,
        int errorRows,
        int committedRows,
        boolean canConfirm,
        OffsetDateTime createdAt,
        OffsetDateTime expiresAt,
        OffsetDateTime committedAt,
        long version,
        List<JobRowView> rows,
        int rowPage,
        int rowPageSize,
        int rowTotal
    ) {
        public JobView {
            rows = List.copyOf(rows);
        }
    }

    public record JobRowView(
        int rowNo,
        String businessCode,
        boolean valid,
        Map<String, String> payload,
        List<RowError> errors
    ) {
    }

    public record Receipt(String fileName, byte[] bytes) {
        public Receipt {
            bytes = bytes.clone();
        }
    }

    private record Scope(UUID accountSetId, String accountSetCode, UUID userId, String username) {
    }

    private record ConfirmOutcome(JobStatus status, JobView job) {
    }

    private record StoredRow(int rowNo, Map<String, String> payload, List<RowError> errors) {
        private StoredRow {
            payload = Map.copyOf(new LinkedHashMap<>(payload));
            errors = List.copyOf(errors);
        }

        static StoredRow from(ParsedRow row) {
            return new StoredRow(row.rowNo(), row.payload(), row.errors());
        }

        boolean valid() {
            return errors.isEmpty();
        }

        StoredRow withError(RowError error) {
            var next = new ArrayList<>(errors);
            next.add(error);
            return new StoredRow(rowNo, payload, next);
        }

        JobRowView view() {
            return new JobRowView(rowNo, payload.getOrDefault("code", ""), valid(), payload, errors);
        }
    }

    private static final class MutableRow {
        private final int rowNo;
        private final LinkedHashMap<String, String> payload;
        private final ArrayList<RowError> errors;

        private MutableRow(StoredRow row) {
            rowNo = row.rowNo();
            payload = new LinkedHashMap<>(row.payload());
            errors = new ArrayList<>(row.errors());
        }

        private void addError(String field, String code, String message, String value) {
            var duplicate = errors.stream().anyMatch(error -> error.field().equals(field) && error.code().equals(code));
            if (!duplicate) {
                errors.add(new RowError(rowNo, field, code, message, value));
            }
        }

        private StoredRow stored() {
            return new StoredRow(rowNo, payload, errors);
        }
    }
}
