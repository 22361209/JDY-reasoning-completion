package com.jdy.erp.system.application.list;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

@Component
public class ListExportColumnProvider {
    public List<ListExportColumn> columnsFor(String listKey, List<Map<String, ?>> rows) {
        if ("operation-log-list".equals(listKey)) {
            return List.of(
                new ListExportColumn("operatedAt", "操作时间"),
                new ListExportColumn("module", "模块"),
                new ListExportColumn("action", "动作"),
                new ListExportColumn("targetType", "对象类型"),
                new ListExportColumn("targetNo", "业务单号"),
                new ListExportColumn("operator", "操作人"),
                new ListExportColumn("status", "状态"),
                new ListExportColumn("reason", "失败原因")
            );
        }
        if (rows.isEmpty()) {
            return List.of();
        }
        return rows.get(0).keySet().stream()
            .filter(field -> !"id".equals(field))
            .map(field -> new ListExportColumn(field, field))
            .toList();
    }
}
