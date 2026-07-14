package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.jdy.erp.inventory.application.InventoryPostingCommand;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

class PostingPipelineTest {
    private static final UUID INVENTORY_HEADER_ID = UUID.fromString("a1470000-0000-4000-8000-000000000001");
    private static final UUID INVENTORY_LINE_ID = UUID.fromString("a1470000-0000-4000-8000-000000000002");
    private static final UUID UNKNOWN_HEADER_ID = UUID.fromString("a1470000-0000-4000-8000-000000000003");
    private static final UUID UNKNOWN_LINE_ID = UUID.fromString("a1470000-0000-4000-8000-000000000004");

    @Test
    void dispatchesOnlyMatchingHooks() {
        var inventoryCalls = new ArrayList<PostingContext>();
        var financeCalls = new ArrayList<PostingContext>();
        var pipeline = new PostingPipeline(List.of(
            hook("INVENTORY", inventoryCalls),
            hook("FINANCE", financeCalls)
        ));
        var context = PostingContext.inventory(InventoryPostingCommand.test(
            "CP-001",
            "CK-001",
            BigDecimal.ONE,
            "IN",
            "TEST",
            INVENTORY_HEADER_ID,
            INVENTORY_LINE_ID,
            "TEST-PIPELINE",
            LocalDate.of(2026, 7, 14),
            PostingAction.AUDIT
        ));

        pipeline.post(context);

        assertThat(inventoryCalls).containsExactly(context);
        assertThat(financeCalls).isEmpty();
    }

    @Test
    void failsWhenNoHookSupportsChannel() {
        var pipeline = new PostingPipeline(List.of(hook("INVENTORY", new ArrayList<>())));
        var context = new PostingContext(
            "UNKNOWN",
            "CP-001",
            "CK-001",
            BigDecimal.ONE,
            "IN",
            "TEST",
            "TEST-UNKNOWN-CHANNEL",
            null,
            LocalDate.of(2026, 7, 14),
            null,
            "CNY",
            UNKNOWN_HEADER_ID,
            UNKNOWN_LINE_ID,
            PostingAction.AUDIT,
            InventoryPostingCommand.TraceQuality.TEST
        );

        assertThatThrownBy(() -> pipeline.post(context))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("未找到过账钩子");
    }

    private PostingHook hook(String channel, List<PostingContext> calls) {
        return new PostingHook() {
            @Override
            public boolean supports(String value) {
                return channel.equals(value);
            }

            @Override
            public void post(PostingContext context) {
                calls.add(context);
            }
        };
    }
}
