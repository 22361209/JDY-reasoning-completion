package com.jdy.erp.system.application.list;

import java.util.List;

public record ListQueryContract(
    String listKey,
    String view,
    List<String> keywordFields,
    String dateField,
    String lineMatchPolicy,
    String returnShape,
    String adapterKey,
    boolean supportsSqlPushdown
) {
    public boolean usesLineExists() {
        return "exists".equals(lineMatchPolicy);
    }
}
