package com.jdy.erp.system.application;

import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantSchemaProvisioner;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountSetInitializationService {
    private final JdbcTemplate jdbcTemplate;
    private final JdbcTemplate platformJdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final TenantSchemaProvisioner tenantSchemaProvisioner;
    private final OperationLogService operationLogService;

    public AccountSetInitializationService(
        JdbcTemplate jdbcTemplate,
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate,
        CurrentSessionService currentSessionService,
        TenantSchemaProvisioner tenantSchemaProvisioner,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.tenantSchemaProvisioner = tenantSchemaProvisioner;
        this.operationLogService = operationLogService;
    }

    @Transactional
    public Map<String, Object> initializeCurrentAccountSet(boolean clearBusinessData) {
        var accountSet = currentSessionService.currentAccountSet();
        var accountSetId = String.valueOf(accountSet.get("id"));
        tenantSchemaProvisioner.provisionSchema(String.valueOf(accountSet.get("schemaName")));
        if (clearBusinessData) {
            clearBusinessTables();
        }
        clearNumberingRules(accountSetId);
        platformJdbcTemplate.update("""
            UPDATE sys_account_set
            SET initialized = TRUE,
                initialized_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, accountSetId);
        operationLogService.logCurrent(OperationLogCommand.success(
            "SYSTEM",
            "INITIALIZE_ACCOUNT_SET",
            "sys_account_set",
            UUID.fromString(accountSetId),
            String.valueOf(accountSet.get("code")),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(OperationLogCommand.StateField.INITIALIZED, accountSet.get("initialized")),
            OperationLogCommand.state(
                OperationLogCommand.StateField.INITIALIZED, true,
                OperationLogCommand.StateField.CLEARED_BUSINESS_DATA, clearBusinessData
            ),
            null
        ));
        return Map.of(
            "ok", true,
            "accountSet", currentSessionService.currentAccountSet(),
            "message", clearBusinessData ? "本账套已初始化，开发期业务数据已清空。" : "本账套已初始化。"
        );
    }

    private void clearBusinessTables() {
        jdbcTemplate.execute("""
            TRUNCATE TABLE
                doc_edit_lock,
                sys_list_filter_preset,
                inv_stock_txn,
                inv_stock_balance,
                inv_stock_opening,
                ar_receipt,
                ar_receivable,
                ap_payment,
                ap_payable,
                sales_quote_line,
                sales_quote,
                sales_order_line,
                sales_order,
                delivery_notice_line,
                delivery_notice,
                sales_out_line,
                sales_out,
                purchase_requisition_line,
                purchase_requisition,
                purchase_order_line,
                purchase_order,
                purchase_in_line,
                purchase_in,
                purchase_return_line,
                purchase_return,
                outsourcing_work_order_component,
                outsourcing_work_order_line,
                outsourcing_work_order,
                outsourcing_material_issue_line,
                outsourcing_material_issue,
                outsourcing_receipt_line,
                outsourcing_receipt,
                outsourcing_return_line,
                outsourcing_return,
                outsourcing_scrap_line,
                outsourcing_scrap,
                production_plan,
                production_task,
                production_task_material_snapshot,
                production_material_issue_line,
                production_material_issue,
                production_completion_line,
                production_completion,
                other_stock_in_line,
                other_stock_in,
                other_stock_out_line,
                other_stock_out,
                stock_transfer_line,
                stock_transfer,
                stock_count_line,
                stock_count,
                stock_count_gain_line,
                stock_count_gain,
                stock_count_loss_line,
                stock_count_loss,
                outsourcing_surface_process
            RESTART IDENTITY CASCADE
            """);
    }

    private void clearNumberingRules(String accountSetId) {
        var context = TenantContext.current().orElse(null);
        var schemaName = context == null ? "" : context.schemaName();
        if (schemaName == null || schemaName.isBlank() || "public".equalsIgnoreCase(schemaName)) {
            jdbcTemplate.update("""
                DELETE FROM document_number_sequence
                WHERE account_set_id = ?::uuid
                """, accountSetId);
            return;
        }
        jdbcTemplate.update("DELETE FROM document_number_sequence");
    }
}
