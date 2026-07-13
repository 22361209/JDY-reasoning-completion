package com.jdy.erp.system.application.list;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class ListQueryServiceTest {
    @Test
    void missingNonDefaultAdapterFailsFast() {
        var registry = new ListQueryContractRegistry() {
            @Override
            public ListQueryContract contractFor(String listKey, String view) {
                return new ListQueryContract(
                    listKey,
                    "header",
                    List.of(),
                    "",
                    "row",
                    "header",
                    "missingAdapter",
                    true
                );
            }
        };
        var service = new ListQueryService(
            registry,
            new ListQuerySupport(new ObjectMapper()),
            List.of(new DefaultStubListQueryAdapter())
        );
        var request = new ListQueryRequest(
            "test-list", "", "", 1, 200, "header", "", "asc", "",
            "", "", "", "", "", "current", "", "", false
        );

        assertThatThrownBy(() -> service.query(request, (listKey, view, pageSize) -> List.of()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Missing list query adapter: missingAdapter for test-list/header");
    }
}
