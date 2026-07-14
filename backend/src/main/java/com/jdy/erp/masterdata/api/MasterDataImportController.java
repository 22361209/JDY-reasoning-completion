package com.jdy.erp.masterdata.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import com.jdy.erp.masterdata.application.MasterDataImportService;
import com.jdy.erp.masterdata.application.MasterDataImportService.JobPage;
import com.jdy.erp.masterdata.application.MasterDataImportService.JobView;
import com.jdy.erp.masterdata.application.MasterDataImportService.TemplateView;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/master-data/import")
@RequirePermission("master.data.manage")
public class MasterDataImportController {
    private static final MediaType XLSX = MediaType.parseMediaType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    private final MasterDataImportService importService;

    public MasterDataImportController(MasterDataImportService importService) {
        this.importService = importService;
    }

    @GetMapping("/templates")
    public List<TemplateView> templates() {
        return importService.templates();
    }

    @GetMapping("/templates/{type}")
    public ResponseEntity<Resource> template(@PathVariable String type) {
        var definition = importService.template(type);
        var resource = new ClassPathResource(definition.resourcePath());
        if (!resource.exists()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "导入模板资源缺失");
        }
        return ResponseEntity.ok()
            .contentType(XLSX)
            .header(HttpHeaders.CONTENT_DISPOSITION, attachment(definition.fileName()))
            .body(resource);
    }

    @PostMapping(
        value = "/jobs/{type}/preview",
        consumes = MediaType.MULTIPART_FORM_DATA_VALUE
    )
    @ResponseStatus(HttpStatus.CREATED)
    public JobView preview(
        @PathVariable String type,
        @RequestPart("file") MultipartFile file,
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "100") int pageSize
    ) {
        try (var input = file.getInputStream()) {
            return importService.preview(
                type,
                file.getOriginalFilename(),
                file.getSize(),
                input,
                page,
                pageSize
            );
        } catch (IOException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "无法读取上传的 Excel 文件");
        }
    }

    @GetMapping("/jobs")
    public JobPage jobs(
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "20") int pageSize
    ) {
        return importService.list(page, pageSize);
    }

    @GetMapping("/jobs/{jobId}")
    public JobView job(
        @PathVariable String jobId,
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "100") int pageSize
    ) {
        return importService.get(jobId, page, pageSize);
    }

    @GetMapping("/jobs/{jobId}/error-receipt")
    public ResponseEntity<Resource> errorReceipt(@PathVariable String jobId) {
        var receipt = importService.errorReceipt(jobId);
        return ResponseEntity.ok()
            .contentType(XLSX)
            .contentLength(receipt.bytes().length)
            .header(HttpHeaders.CONTENT_DISPOSITION, attachment(receipt.fileName()))
            .body(new ByteArrayResource(receipt.bytes()));
    }

    @PostMapping("/jobs/{jobId}/confirm")
    public JobView confirm(
        @PathVariable String jobId,
        @RequestParam(defaultValue = "1") int page,
        @RequestParam(defaultValue = "100") int pageSize
    ) {
        return importService.confirm(jobId, page, pageSize);
    }

    private String attachment(String fileName) {
        return ContentDisposition.attachment()
            .filename(fileName, StandardCharsets.UTF_8)
            .build()
            .toString();
    }
}
