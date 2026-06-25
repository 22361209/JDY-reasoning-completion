package com.jdy.erp.shared.application;

public interface PostingHook {
    boolean supports(String channel);

    void post(PostingContext context);
}
