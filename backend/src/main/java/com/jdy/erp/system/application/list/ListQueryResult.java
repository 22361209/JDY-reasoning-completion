package com.jdy.erp.system.application.list;

import java.util.List;
import java.util.Map;

public record ListQueryResult(
    int page,
    int pageSize,
    String view,
    String sortField,
    String sortOrder,
    long total,
    List<Map<String, ?>> rows
) {}
