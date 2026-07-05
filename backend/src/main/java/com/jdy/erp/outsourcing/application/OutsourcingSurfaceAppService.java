package com.jdy.erp.outsourcing.application;

import java.math.BigDecimal;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class OutsourcingSurfaceAppService {
    @Transactional
    public Map<String, Object> saveDraft(SurfaceProcessRequest request) {
        throw retired();
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        throw retired();
    }

    @Transactional
    public Map<String, Object> complete(String billNo) {
        throw retired();
    }

    private ResponseStatusException retired() {
        return new ResponseStatusException(HttpStatus.GONE, "委外表面处理单据已废弃，不能继续新增、审核或完成");
    }

    public record SurfaceProcessRequest(String billNo, String sourceBillNo, String productCode, BigDecimal qty, String processorSupplierCode, String surfaceTreatment, String remark) {
    }
}
