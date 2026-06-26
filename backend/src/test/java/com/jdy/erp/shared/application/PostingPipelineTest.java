package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

class PostingPipelineTest {
    @Test
    void dispatchesOnlyMatchingHooks() {
        var inventoryCalls = new ArrayList<PostingContext>();
        var financeCalls = new ArrayList<PostingContext>();
        var pipeline = new PostingPipeline(List.of(
            hook("INVENTORY", inventoryCalls),
            hook("FINANCE", financeCalls)
        ));
        var context = new PostingContext("INVENTORY", "CP-001", "CK-001", BigDecimal.ONE, "IN", "TEST");

        pipeline.post(context);

        assertThat(inventoryCalls).containsExactly(context);
        assertThat(financeCalls).isEmpty();
    }

    @Test
    void failsWhenNoHookSupportsChannel() {
        var pipeline = new PostingPipeline(List.of(hook("INVENTORY", new ArrayList<>())));
        var context = new PostingContext("UNKNOWN", "CP-001", "CK-001", BigDecimal.ONE, "IN", "TEST");

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
