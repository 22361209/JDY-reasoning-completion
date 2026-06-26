package com.jdy.erp.shared.application;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class DocumentLockService {
    private static final int LOCK_TIMEOUT_MINUTES = 30;
    private static final String OVERRIDE_PERMISSION = "document.lock.override";
    private static final Set<String> DOCUMENT_TYPES = Set.of(
        "salesOrder",
        "salesOut",
        "purchaseOrder",
        "purchaseIn",
        "materialIssue",
        "productIn",
        "otherStockIn",
        "otherStockOut",
        "stockTransfer",
        "stockCount",
        "stockCountGain",
        "stockCountLoss"
    );

    private final JdbcTemplate jdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final CurrentPermissionService permissionService;

    public DocumentLockService(
        JdbcTemplate jdbcTemplate,
        CurrentSessionService currentSessionService,
        CurrentPermissionService permissionService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.permissionService = permissionService;
    }

    @Transactional
    public Map<String, Object> acquire(String documentType, String billNo) {
        guardDocumentKey(documentType, billNo);
        cleanupExpired();
        var currentUserId = currentSessionService.currentUserId();
        var currentUsername = currentSessionService.currentUsername();
        var currentDisplayName = currentSessionService.currentDisplayName();
        var existing = current(documentType, billNo);
        if (existing.isEmpty() || currentUserId.equals(String.valueOf(existing.get("holderUserId")))) {
            jdbcTemplate.update("""
                INSERT INTO doc_edit_lock (
                    document_type,
                    bill_no,
                    holder_user_id,
                    holder_username,
                    holder_display_name,
                    acquired_at,
                    expires_at
                )
                VALUES (?, ?, ?::uuid, ?, ?, now(), now() + (? || ' minutes')::interval)
                ON CONFLICT (document_type, bill_no) DO UPDATE
                SET holder_user_id = EXCLUDED.holder_user_id,
                    holder_username = EXCLUDED.holder_username,
                    holder_display_name = EXCLUDED.holder_display_name,
                    acquired_at = now(),
                    expires_at = EXCLUDED.expires_at
                """, documentType, billNo, currentUserId, currentUsername, currentDisplayName, LOCK_TIMEOUT_MINUTES);
            return status(documentType, billNo, "editable", false);
        }
        return lockedStatus(existing, false);
    }

    @Transactional
    public Map<String, Object> override(String documentType, String billNo) {
        guardDocumentKey(documentType, billNo);
        if (!permissionService.hasPermission(OVERRIDE_PERMISSION)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "当前角色无权强制解锁单据");
        }
        cleanupExpired();
        var previous = current(documentType, billNo);
        jdbcTemplate.update("""
            INSERT INTO doc_edit_lock (
                document_type,
                bill_no,
                holder_user_id,
                holder_username,
                holder_display_name,
                acquired_at,
                expires_at
            )
            VALUES (?, ?, ?::uuid, ?, ?, now(), now() + (? || ' minutes')::interval)
            ON CONFLICT (document_type, bill_no) DO UPDATE
            SET holder_user_id = EXCLUDED.holder_user_id,
                holder_username = EXCLUDED.holder_username,
                holder_display_name = EXCLUDED.holder_display_name,
                acquired_at = now(),
                expires_at = EXCLUDED.expires_at
            """,
            documentType,
            billNo,
            currentSessionService.currentUserId(),
            currentSessionService.currentUsername(),
            currentSessionService.currentDisplayName(),
            LOCK_TIMEOUT_MINUTES
        );
        return status(documentType, billNo, previous.isEmpty() ? "editable" : "overridden", !previous.isEmpty());
    }

    @Transactional
    public Map<String, Object> release(String documentType, String billNo) {
        guardDocumentKey(documentType, billNo);
        cleanupExpired();
        var deleted = jdbcTemplate.update("""
            DELETE FROM doc_edit_lock
            WHERE document_type = ?
              AND bill_no = ?
              AND holder_user_id = ?::uuid
            """, documentType, billNo, currentSessionService.currentUserId());
        return Map.of("ok", true, "released", deleted > 0);
    }

    @Transactional
    public void releaseIfOwned(String documentType, String billNo) {
        if (!isSupported(documentType) || billNo == null || billNo.isBlank()) {
            return;
        }
        jdbcTemplate.update("""
            DELETE FROM doc_edit_lock
            WHERE document_type = ?
              AND bill_no = ?
              AND holder_user_id = ?::uuid
            """, documentType, billNo.trim(), currentSessionService.currentUserId());
    }

    public Map<String, Object> status(String documentType, String billNo) {
        guardDocumentKey(documentType, billNo);
        cleanupExpired();
        return status(documentType, billNo, "", false);
    }

    public void assertWritable(String documentType, String billNo) {
        if (!isSupported(documentType) || billNo == null || billNo.isBlank()) {
            return;
        }
        cleanupExpired();
        var existing = current(documentType, billNo.trim());
        if (existing.isEmpty()) {
            return;
        }
        if (currentSessionService.currentUserId().equals(String.valueOf(existing.get("holderUserId")))) {
            return;
        }
        throw new ResponseStatusException(
            HttpStatus.LOCKED,
            "锁已被" + existing.get("holderDisplayName") + "夺取，已转只读"
        );
    }

    private Map<String, Object> status(String documentType, String billNo, String mode, boolean overridden) {
        var existing = current(documentType, billNo);
        if (existing.isEmpty()) {
            var result = new LinkedHashMap<String, Object>();
            result.put("mode", mode.isBlank() ? "editable" : mode);
            result.put("locked", false);
            result.put("readOnly", false);
            result.put("canOverride", permissionService.hasPermission(OVERRIDE_PERMISSION));
            result.put("overridden", overridden);
            return result;
        }
        if (currentSessionService.currentUserId().equals(String.valueOf(existing.get("holderUserId")))) {
            var result = new LinkedHashMap<String, Object>();
            result.put("mode", mode.isBlank() ? "editable" : mode);
            result.put("locked", false);
            result.put("readOnly", false);
            result.put("holderName", existing.get("holderDisplayName"));
            result.put("holderUsername", existing.get("holderUsername"));
            result.put("expiresAt", existing.get("expiresAt"));
            result.put("canOverride", permissionService.hasPermission(OVERRIDE_PERMISSION));
            result.put("overridden", overridden);
            return result;
        }
        return lockedStatus(existing, overridden);
    }

    private Map<String, Object> lockedStatus(Map<String, Object> existing, boolean overridden) {
        var result = new LinkedHashMap<String, Object>();
        result.put("mode", "readonly");
        result.put("locked", true);
        result.put("readOnly", true);
        result.put("holderName", existing.get("holderDisplayName"));
        result.put("holderUsername", existing.get("holderUsername"));
        result.put("expiresAt", existing.get("expiresAt"));
        result.put("canOverride", permissionService.hasPermission(OVERRIDE_PERMISSION));
        result.put("overridden", overridden);
        return result;
    }

    private Map<String, Object> current(String documentType, String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT holder_user_id::text AS "holderUserId",
                   holder_username AS "holderUsername",
                   holder_display_name AS "holderDisplayName",
                   acquired_at AS "acquiredAt",
                   expires_at AS "expiresAt"
            FROM doc_edit_lock
            WHERE document_type = ?
              AND bill_no = ?
              AND expires_at > now()
            """, documentType, billNo);
        return rows.isEmpty() ? Map.of() : rows.get(0);
    }

    private void cleanupExpired() {
        jdbcTemplate.update("DELETE FROM doc_edit_lock WHERE expires_at <= now()");
    }

    private void guardDocumentKey(String documentType, String billNo) {
        if (!isSupported(documentType) || billNo == null || billNo.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "不支持的单据锁目标");
        }
    }

    private boolean isSupported(String documentType) {
        return DOCUMENT_TYPES.contains(documentType);
    }
}
