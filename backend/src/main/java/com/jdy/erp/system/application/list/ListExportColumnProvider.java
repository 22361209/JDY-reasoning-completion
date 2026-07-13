package com.jdy.erp.system.application.list;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

@Component
public class ListExportColumnProvider {
    public List<ListExportColumn> columnsFor(String listKey, List<Map<String, ?>> rows) {
        if ("operation-log-list".equals(listKey)) {
            return List.of(
                new ListExportColumn("id", "日志ID"),
                new ListExportColumn("operatedAt", "操作时间"),
                new ListExportColumn("module", "模块"),
                new ListExportColumn("action", "动作"),
                new ListExportColumn("actorType", "主体类型"),
                new ListExportColumn("actorUsername", "操作人账号"),
                new ListExportColumn("actorDisplayName", "操作时姓名"),
                new ListExportColumn("operator", "操作人"),
                new ListExportColumn("accountSetId", "账套ID"),
                new ListExportColumn("accountSetCode", "账套编码"),
                new ListExportColumn("accountSetName", "账套名称"),
                new ListExportColumn("targetType", "对象类型"),
                new ListExportColumn("targetId", "对象ID"),
                new ListExportColumn("targetNo", "业务单号"),
                new ListExportColumn("status", "状态"),
                new ListExportColumn("reason", "失败原因"),
                new ListExportColumn("beforeState", "操作前状态"),
                new ListExportColumn("afterState", "操作后状态")
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
