package com.jdy.erp.system.application.list;

import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;

public record OperationLogRow(
    String id,
    String operatedAt,
    String module,
    String action,
    String actorType,
    String actorUsername,
    String actorDisplayName,
    String operator,
    String accountSetId,
    String accountSetCode,
    String accountSetName,
    String targetType,
    String targetId,
    String targetNo,
    boolean success,
    String status,
    String reason,
    JsonNode beforeState,
    JsonNode afterState
) {
    public Map<String, ?> toMap() {
        var row = new LinkedHashMap<String, Object>();
        row.put("id", id);
        row.put("operatedAt", operatedAt);
        row.put("module", module);
        row.put("action", action);
        row.put("actorType", actorType);
        row.put("actorUsername", actorUsername);
        row.put("actorDisplayName", actorDisplayName);
        row.put("operator", operator);
        row.put("accountSetId", accountSetId);
        row.put("accountSetCode", accountSetCode);
        row.put("accountSetName", accountSetName);
        row.put("targetType", targetType);
        row.put("targetId", targetId);
        row.put("targetNo", targetNo);
        row.put("success", success);
        row.put("status", status);
        row.put("reason", reason);
        row.put("beforeState", beforeState);
        row.put("afterState", afterState);
        return row;
    }
}
