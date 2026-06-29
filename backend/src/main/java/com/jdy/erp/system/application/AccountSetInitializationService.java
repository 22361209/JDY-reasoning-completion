package com.jdy.erp.system.application;

import java.util.Map;

import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountSetInitializationService {
    private final JdbcTemplate jdbcTemplate;
    private final CurrentSessionService currentSessionService;

    public AccountSetInitializationService(JdbcTemplate jdbcTemplate, CurrentSessionService currentSessionService) {
        this.jdbcTemplate = jdbcTemplate;
        this.currentSessionService = currentSessionService;
    }

    @Transactional
    public Map<String, Object> initializeCurrentAccountSet(boolean clearBusinessData) {
        var accountSet = currentSessionService.currentAccountSet();
        var accountSetId = String.valueOf(accountSet.get("id"));
        if (clearBusinessData) {
            clearBusinessTables();
        }
        jdbcTemplate.update("""
            DELETE FROM document_number_sequence
            WHERE account_set_id = ?::uuid
            """, accountSetId);
        jdbcTemplate.update("""
            UPDATE sys_account_set
            SET initialized = TRUE,
                initialized_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, accountSetId);
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason, operated_by)
            SELECT 'SYSTEM', 'INITIALIZE_ACCOUNT_SET', 'sys_account_set', ?::uuid, TRUE, ?, id
            FROM sys_user
            WHERE username = ?
            """, accountSetId, clearBusinessData ? "cleared_business_data=true" : "cleared_business_data=false", currentSessionService.currentUsername());
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
                sales_quote,
                sales_order,
                delivery_notice,
                sales_out,
                purchase_requisition,
                purchase_order,
                purchase_in,
                purchase_return,
                production_plan,
                production_task,
                production_material_issue,
                production_completion,
                other_stock_in,
                other_stock_out,
                stock_transfer,
                stock_count,
                stock_count_gain,
                stock_count_loss,
                outsourcing_surface_process
            RESTART IDENTITY CASCADE
            """);
    }
}
