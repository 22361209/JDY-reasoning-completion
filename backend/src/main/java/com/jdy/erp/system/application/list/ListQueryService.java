package com.jdy.erp.system.application.list;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;

@Service
public class ListQueryService {
    private final ListQueryContractRegistry contractRegistry;
    private final ListQuerySupport support;
    private final Map<String, ListQueryAdapter> adapters;

    public ListQueryService(
        ListQueryContractRegistry contractRegistry,
        ListQuerySupport support,
        List<ListQueryAdapter> adapters
    ) {
        this.contractRegistry = contractRegistry;
        this.support = support;
        this.adapters = adapters.stream().collect(Collectors.toMap(ListQueryAdapter::key, Function.identity()));
    }

    public ListQueryResult query(ListQueryRequest request, ListSeedRowsProvider seedRowsProvider) {
        var contract = contractRegistry.contractFor(request.listKey(), request.normalizedView());
        var adapter = adapters.get(contract.adapterKey());
        if (adapter == null) {
            throw new IllegalStateException("Missing list query adapter: " + contract.adapterKey() + " for " + contract.listKey() + "/" + contract.view());
        }
        return adapter.query(request, contract, support, seedRowsProvider);
    }
}
