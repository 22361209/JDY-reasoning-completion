package com.jdy.erp.system.application.list;

public interface ListQueryAdapter {
    String key();

    ListQueryResult query(ListQueryRequest request, ListQueryContract contract, ListQuerySupport support, ListSeedRowsProvider seedRowsProvider);
}
