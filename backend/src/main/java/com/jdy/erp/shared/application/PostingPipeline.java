package com.jdy.erp.shared.application;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class PostingPipeline {
    private final List<PostingHook> hooks;

    public PostingPipeline(List<PostingHook> hooks) {
        this.hooks = hooks;
    }

    public void post(PostingContext context) {
        var matched = hooks.stream()
            .filter(hook -> hook.supports(context.channel()))
            .toList();
        if (matched.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "未找到过账钩子");
        }
        matched.forEach(hook -> hook.post(context));
    }
}
