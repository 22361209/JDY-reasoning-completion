package com.jdy.erp.system.application.list;

import java.util.List;
import java.util.Map;

@FunctionalInterface
public interface ListSeedRowsProvider {
    List<Map<String, ?>> seedRows(String listKey, String view, int pageSize);
}
