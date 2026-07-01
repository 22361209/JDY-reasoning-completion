package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

import com.jdy.erp.system.application.list.ListExportColumnProvider;
import com.jdy.erp.system.application.list.ListQueryService;
import com.jdy.erp.system.application.list.ListSeedRowsProvider;
import com.jdy.erp.system.application.list.ListStubStateGuard;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class ListStubControllerTest {
    private final ListQueryService listQueryService = mock(ListQueryService.class);
    private final ListSeedRowsProvider seedRowsProvider = mock(ListSeedRowsProvider.class);
    private final ListStubController controller = new ListStubController(
        listQueryService,
        seedRowsProvider,
        new ListExportColumnProvider(),
        new ListStubStateGuard()
    );

    @Test
    void rowsAndExportShareListStateGuard() {
        assertForbidden(() -> controller.rows(
            "permission-denied-list",
            "",
            "",
            1,
            200,
            "header",
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        ));

        assertForbidden(() -> controller.exportCsv(
            "permission-denied-list",
            "",
            "",
            1000,
            "header",
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        ));

        verifyNoInteractions(listQueryService, seedRowsProvider);
    }

    private void assertForbidden(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }
}
