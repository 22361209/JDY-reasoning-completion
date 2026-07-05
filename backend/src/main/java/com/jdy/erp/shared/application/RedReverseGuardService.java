package com.jdy.erp.shared.application;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class RedReverseGuardService {
    private final JdbcTemplate jdbcTemplate;

    public RedReverseGuardService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void assertNoNonVoidRedBill(String tableName, Object sourceBillId, String documentLabel) {
        var count = countNonVoidRedBills(tableName, sourceBillId);
        if (count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, documentLabel + "已存在非作废红字单，不能重复创建红冲");
        }
    }

    public void assertNoNonVoidRedBillForBillNo(String tableName, String billNo, String documentLabel, String actionLabel) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM %s
            WHERE bill_no = ?
            """.formatted(tableName), billNo);
        if (rows.isEmpty()) {
            return;
        }
        var count = countNonVoidRedBills(tableName, rows.get(0).get("id"));
        if (count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, documentLabel + "已存在非作废红字单，不能" + actionLabel);
        }
    }

    public void assertNotRedDraftForBillNo(String tableName, String billNo, String documentLabel) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM %s
            WHERE bill_no = ?
              AND red_source_bill_id IS NOT NULL
              AND status = 'DRAFT'
            """.formatted(tableName), Integer.class, billNo);
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, documentLabel + "红字草稿由来源单生成，不能通过普通保存修改");
        }
    }

    public int countNonVoidRedBills(String tableName, Object sourceBillId) {
        return countRedBills(tableName, sourceBillId, "status <> 'VOID'");
    }

    public boolean hasEffectiveRedBill(String tableName, Object sourceBillId) {
        return countEffectiveRedBills(tableName, sourceBillId) > 0;
    }

    public int countEffectiveRedBills(String tableName, Object sourceBillId) {
        return countRedBills(tableName, sourceBillId, "status IN ('AUDITED', 'RED_REVERSED')");
    }

    private int countRedBills(String tableName, Object sourceBillId, String statusPredicate) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM %s
            WHERE red_source_bill_id = ?::uuid
              AND %s
            """.formatted(tableName, statusPredicate), Integer.class, sourceBillId);
        return count == null ? 0 : count;
    }
}
