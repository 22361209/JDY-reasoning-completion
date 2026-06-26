package com.jdy.erp.reports.api;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;

@RestController
@RequestMapping("/api/documents")
public class DocumentOutputController {
    private static final String CURRENT_ROLE_CODE = "ADMIN";

    private final JdbcTemplate jdbcTemplate;

    public DocumentOutputController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/{documentType}/{billNo}/export.csv")
    public ResponseEntity<String> exportCsv(@PathVariable String documentType, @PathVariable String billNo) {
        var payload = payload(documentType, billNo);
        var csv = new StringBuilder();
        csv.append("单据类型,").append(escapeCsv(title(documentType))).append('\n');
        csv.append("单据编号,").append(escapeCsv(String.valueOf(payload.header().get("billNo")))).append('\n');
        csv.append("往来单位,").append(escapeCsv(String.valueOf(payload.header().get("counterparty")))).append('\n');
        csv.append("业务日期,").append(escapeCsv(String.valueOf(payload.header().get("billDate")))).append('\n');
        csv.append("状态,").append(escapeCsv(String.valueOf(payload.header().get("status")))).append('\n');
        csv.append('\n');
        csv.append("行号,源单号,商品编码,商品名称,规格型号,仓库,数量,单价,金额,备注\n");
        for (var line : payload.lines()) {
            csv.append(escapeCsv(String.valueOf(line.get("lineNo")))).append(',')
                .append(escapeCsv(String.valueOf(line.getOrDefault("sourceOrderNo", "")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("productCode")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("productName")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("spec")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("warehouse")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("qty")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("unitPrice")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("amount")))).append(',')
                .append(escapeCsv(String.valueOf(line.get("lineRemark")))).append('\n');
        }
        var fileName = documentType + "-" + billNo + ".csv";
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(fileName, StandardCharsets.UTF_8).build().toString())
            .contentType(new MediaType("text", "csv", StandardCharsets.UTF_8))
            .body(csv.toString());
    }

    @GetMapping("/{documentType}/{billNo}/print.html")
    public ResponseEntity<String> printHtml(@PathVariable String documentType, @PathVariable String billNo) {
        var payload = payload(documentType, billNo);
        var template = printTemplate(documentType);
        var page = pageSpec(template);
        var html = new StringBuilder("""
            <!doctype html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8">
              <title>PRINT_TITLE</title>
              <style>
                @page { size: PRINT_SIZE; margin: PRINT_MARGIN; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2937; margin: 28px; }
                .template-head { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-bottom: 8px; font-size: 12px; color: #4b5563; }
                .template-head strong { display: block; color: #111827; font-size: 15px; }
                h1 { font-size: 20px; margin: 0 0 18px; text-align: center; }
                .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 18px; font-size: 12px; margin-bottom: 16px; }
                .print-params { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 14px; font-size: 11px; color: #64748b; }
                table { width: 100%; border-collapse: collapse; font-size: 12px; }
                th, td { border: 1px solid #d8e0eb; padding: 7px 8px; text-align: left; }
                th { background: #f3f7fb; }
                .amount { text-align: right; }
                .remark { min-width: 150px; white-space: normal; line-height: 1.5; }
                .copy-badges { display: flex; gap: 8px; margin: 16px 0 0; font-size: 11px; color: #475569; }
                .copy-badges span { border: 1px solid #d8e0eb; padding: 4px 8px; border-radius: 3px; background: #f8fafc; }
                .signature { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 28px; font-size: 12px; }
                .signature div { border-top: 1px solid #9ca3af; padding-top: 8px; }
                .seal { width: 116px; height: 72px; border: 1px dashed #9ca3af; display: grid; place-items: center; color: #6b7280; justify-self: end; }
                .footer-note { margin-top: 14px; font-size: 11px; color: #6b7280; }
              </style>
            </head>
            <body>
            """.replace("PRINT_TITLE", escapeHtml(title(documentType)))
            .replace("PRINT_SIZE", page.cssSize())
            .replace("PRINT_MARGIN", page.cssMargin()));
        html.append("<section class=\"template-head\">")
            .append("<div><strong>").append(escapeHtml(template.companyName())).append("</strong>")
            .append("<span>").append(escapeHtml(template.headerNote())).append("</span></div>")
            .append("<div>").append(escapeHtml(template.templateName())).append("</div>")
            .append("</section>");
        html.append("<h1>").append(escapeHtml(title(documentType))).append("</h1>");
        html.append("<section class=\"meta\">")
            .append("<div>单据编号：").append(escapeHtml(String.valueOf(payload.header().get("billNo")))).append("</div>")
            .append("<div>往来单位：").append(escapeHtml(String.valueOf(payload.header().get("counterparty")))).append("</div>")
            .append("<div>业务日期：").append(escapeHtml(String.valueOf(payload.header().get("billDate")))).append("</div>")
            .append("<div>状态：").append(escapeHtml(String.valueOf(payload.header().get("status")))).append("</div>");
        var redSourceBillNo = String.valueOf(payload.header().getOrDefault("redSourceBillNo", ""));
        if (!redSourceBillNo.isBlank() && !"null".equals(redSourceBillNo)) {
            html.append("<div>来源原单：").append(escapeHtml(redSourceBillNo)).append("</div>");
        }
        html.append("</section>");
        html.append("<section class=\"print-params\">")
            .append("<div>纸张：").append(escapeHtml(template.paperSize())).append("</div>")
            .append("<div>方向：").append(escapeHtml(orientationLabel(template.pageOrientation()))).append("</div>")
            .append("<div>边距：上").append(template.marginTopMm()).append(" / 右").append(template.marginRightMm()).append(" / 下").append(template.marginBottomMm()).append(" / 左").append(template.marginLeftMm()).append(" mm</div>")
            .append("<div>联次：").append(template.copyCount()).append("联</div>")
            .append("</section>");
        html.append("<table><thead><tr><th>行号</th><th>源单号</th><th>商品编码</th><th>商品名称</th><th>规格型号</th><th>仓库</th><th>数量</th><th>单价</th><th>金额</th><th>备注</th></tr></thead><tbody>");
        for (var line : payload.lines()) {
            html.append("<tr>")
                .append("<td>").append(escapeHtml(String.valueOf(line.get("lineNo")))).append("</td>")
                .append("<td>").append(escapeHtml(String.valueOf(line.getOrDefault("sourceOrderNo", "")))).append("</td>")
                .append("<td>").append(escapeHtml(String.valueOf(line.get("productCode")))).append("</td>")
                .append("<td>").append(escapeHtml(String.valueOf(line.get("productName")))).append("</td>")
                .append("<td>").append(escapeHtml(String.valueOf(line.get("spec")))).append("</td>")
                .append("<td>").append(escapeHtml(String.valueOf(line.get("warehouse")))).append("</td>")
                .append("<td class=\"amount\">").append(escapeHtml(String.valueOf(line.get("qty")))).append("</td>")
                .append("<td class=\"amount\">").append(escapeHtml(String.valueOf(line.get("unitPrice")))).append("</td>")
                .append("<td class=\"amount\">").append(escapeHtml(String.valueOf(line.get("amount")))).append("</td>")
                .append("<td class=\"remark\">").append(escapeHtml(String.valueOf(line.get("lineRemark")))).append("</td>")
                .append("</tr>");
        }
        html.append("</tbody></table>");
        if (template.showSignature()) {
            html.append("<section class=\"signature\"><div>制单：本地管理员</div><div>审核：</div><div>财务：</div><div>仓管：</div></section>");
        }
        if (template.showSeal()) {
            html.append("<section class=\"seal\">公司章</section>");
        }
        html.append("<section class=\"copy-badges\">");
        for (var copy = 1; copy <= template.copyCount(); copy += 1) {
            html.append("<span>第").append(copy).append("联 / 共").append(template.copyCount()).append("联</span>");
        }
        html.append("</section>");
        html.append("<p class=\"footer-note\">").append(escapeHtml(template.footerNote())).append("</p>");
        html.append("</body></html>");
        return ResponseEntity.ok()
            .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
            .body(html.toString());
    }

    @GetMapping("/{documentType}/print-template")
    public Map<String, Object> printTemplateConfig(@PathVariable String documentType) {
        return templateResponse(documentType, printTemplate(documentType));
    }

    @GetMapping("/print-templates")
    public List<Map<String, Object>> printTemplates() {
        var documentTypes = supportedDocumentTypes();
        var rows = jdbcTemplate.queryForList("""
            SELECT document_type AS "documentType",
                   template_code AS "templateCode",
                   template_name AS "templateName",
                   role_code AS "roleCode",
                   company_name AS "companyName",
                   header_note AS "headerNote",
                   footer_note AS "footerNote",
                   show_signature AS "showSignature",
                   show_seal AS "showSeal",
                   is_default AS "isDefault",
                   paper_size AS "paperSize",
                   page_orientation AS "pageOrientation",
                   margin_top_mm AS "marginTopMm",
                   margin_right_mm AS "marginRightMm",
                   margin_bottom_mm AS "marginBottomMm",
                   margin_left_mm AS "marginLeftMm",
                   copy_count AS "copyCount",
                   enabled
            FROM sys_print_template
            WHERE enabled = TRUE
            ORDER BY document_type,
                     CASE WHEN role_code = ? THEN 0 WHEN role_code IS NULL THEN 1 ELSE 2 END,
                     is_default DESC,
                     template_name
            """, CURRENT_ROLE_CODE);
        return rows.stream()
            .filter(row -> documentTypes.contains(String.valueOf(row.get("documentType"))))
            .map(row -> templateResponse(String.valueOf(row.get("documentType")), templateFromRow(row)))
            .toList();
    }

    @Transactional
    @PutMapping("/{documentType}/print-template")
    @RequirePermission("system.print_template.manage")
    public Map<String, Object> savePrintTemplate(@PathVariable String documentType, @RequestBody PrintTemplateRequest request) {
        if (!supportedDocumentTypes().contains(documentType)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "暂不支持该单据模板");
        }
        var templateCode = request.templateCode == null || request.templateCode.isBlank() ? "STANDARD" : request.templateCode.trim();
        var templateName = request.templateName == null || request.templateName.isBlank() ? "标准套打模板" : request.templateName.trim();
        var roleCode = request.roleCode == null || request.roleCode.isBlank() ? null : request.roleCode.trim();
        var companyName = request.companyName == null || request.companyName.isBlank() ? "博莱德机械测试账套" : request.companyName.trim();
        var headerNote = request.headerNote == null ? "" : request.headerNote.trim();
        var footerNote = request.footerNote == null ? "" : request.footerNote.trim();
        var showSignature = request.showSignature == null || request.showSignature;
        var showSeal = request.showSeal == null || request.showSeal;
        var isDefault = request.isDefault == null || request.isDefault;
        var paperSize = normalizePaperSize(request.paperSize);
        var pageOrientation = normalizeOrientation(request.pageOrientation);
        var marginTopMm = clampDecimal(request.marginTopMm, 0, 50, BigDecimal.valueOf(12));
        var marginRightMm = clampDecimal(request.marginRightMm, 0, 50, BigDecimal.valueOf(12));
        var marginBottomMm = clampDecimal(request.marginBottomMm, 0, 50, BigDecimal.valueOf(12));
        var marginLeftMm = clampDecimal(request.marginLeftMm, 0, 50, BigDecimal.valueOf(12));
        var copyCount = clampInt(request.copyCount, 1, 5, 1);
        if (isDefault) {
            jdbcTemplate.update("""
                UPDATE sys_print_template
                SET is_default = FALSE,
                    updated_at = now()
                WHERE document_type = ?
                  AND role_code IS NOT DISTINCT FROM ?
                """, documentType, roleCode);
        }
        jdbcTemplate.update("""
            INSERT INTO sys_print_template (
                document_type, template_code, template_name, role_code, company_name, header_note, footer_note,
                show_signature, show_seal, is_default, paper_size, page_orientation, margin_top_mm, margin_right_mm,
                margin_bottom_mm, margin_left_mm, copy_count, enabled, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, now())
            ON CONFLICT (document_type, template_code) DO UPDATE
            SET template_name = EXCLUDED.template_name,
                role_code = EXCLUDED.role_code,
                company_name = EXCLUDED.company_name,
                header_note = EXCLUDED.header_note,
                footer_note = EXCLUDED.footer_note,
                show_signature = EXCLUDED.show_signature,
                show_seal = EXCLUDED.show_seal,
                is_default = EXCLUDED.is_default,
                paper_size = EXCLUDED.paper_size,
                page_orientation = EXCLUDED.page_orientation,
                margin_top_mm = EXCLUDED.margin_top_mm,
                margin_right_mm = EXCLUDED.margin_right_mm,
                margin_bottom_mm = EXCLUDED.margin_bottom_mm,
                margin_left_mm = EXCLUDED.margin_left_mm,
                copy_count = EXCLUDED.copy_count,
                enabled = TRUE,
                updated_at = now()
            """, documentType, templateCode, templateName, roleCode, companyName, headerNote, footerNote, showSignature, showSeal, isDefault,
            paperSize, pageOrientation, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm, copyCount);
        return templateResponse(documentType, findPrintTemplate(documentType, templateCode));
    }

    @GetMapping("/{documentType}/{billNo}/print.pdf")
    public ResponseEntity<byte[]> printPdf(@PathVariable String documentType, @PathVariable String billNo) {
        var payload = payload(documentType, billNo);
        var template = printTemplate(documentType);
        var fileName = documentType + "-" + billNo + ".pdf";
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline().filename(fileName, StandardCharsets.UTF_8).build().toString())
            .contentType(MediaType.APPLICATION_PDF)
            .body(renderPdf(title(documentType), payload, template));
    }

    private DocumentPayload payload(String documentType, String billNo) {
        return switch (documentType) {
            case "sales-order" -> salesOrderPayload(billNo);
            case "purchase-order" -> purchaseOrderPayload(billNo);
            case "purchase-in" -> stockBillPayload("purchase_in", "purchase_in_line", "md_supplier", "供应商", billNo);
            case "sales-out" -> stockBillPayload("sales_out", "sales_out_line", "md_customer", "客户", billNo);
            case "material-issue" -> productionBillPayload("production_material_issue", "production_material_issue_line", "issue_id", "生产领料单", billNo);
            case "product-in" -> productionBillPayload("production_completion", "production_completion_line", "completion_id", "产品入库单", billNo);
            case "other-stock-in" -> inventoryBillPayload("other_stock_in", "other_stock_in_line", "其他入库单", billNo);
            case "other-stock-out" -> inventoryBillPayload("other_stock_out", "other_stock_out_line", "其他出库单", billNo);
            case "stock-transfer" -> stockTransferPayload(billNo);
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "暂不支持该单据输出");
        };
    }

    private DocumentPayload salesOrderPayload(String billNo) {
        return orderPayload("sales_order", "sales_order_line", "md_customer", "客户", "customer_id", billNo);
    }

    private DocumentPayload purchaseOrderPayload(String billNo) {
        return orderPayload("purchase_order", "purchase_order_line", "md_supplier", "供应商", "supplier_id", billNo);
    }

    private DocumentPayload orderPayload(String table, String lineTable, String counterpartyTable, String counterpartyAlias, String counterpartyColumn, String billNo) {
        var header = jdbcTemplate.queryForList("""
            SELECT b.bill_no AS "billNo",
                   c.name AS counterparty,
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.status,
                   b.total_amount AS "totalAmount"
            FROM %s b
            JOIN %s c ON c.id = b.%s
            WHERE b.bill_no = ?
            """.formatted(table, counterpartyTable, counterpartyColumn), billNo);
        if (header.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, counterpartyAlias + "单据不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   '' AS "sourceOrderNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   COALESCE(w.name, '') AS warehouse,
                   trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                   trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM %s l
            JOIN %s b ON b.id = l.order_id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """.formatted(lineTable, table), billNo);
        return new DocumentPayload(header.get(0), lines);
    }

    private DocumentPayload stockBillPayload(String table, String lineTable, String counterpartyTable, String counterpartyAlias, String billNo) {
        var counterpartyColumn = "sales_out".equals(table) ? "customer_id" : "supplier_id";
        var header = jdbcTemplate.queryForList("""
            SELECT b.bill_no AS "billNo",
                   c.name AS counterparty,
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.status,
                   b.total_amount AS "totalAmount"
            FROM %s b
            JOIN %s c ON c.id = b.%s
            WHERE b.bill_no = ?
            """.formatted(table, counterpartyTable, counterpartyColumn), billNo);
        if (header.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, counterpartyAlias + "单据不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   COALESCE(l.source_order_no, '') AS "sourceOrderNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.name AS warehouse,
                   trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                   trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM %s l
            JOIN %s b ON b.id = l.bill_id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """.formatted(lineTable, table), billNo);
        return new DocumentPayload(header.get(0), lines);
    }

    private DocumentPayload inventoryBillPayload(String table, String lineTable, String documentLabel, String billNo) {
        var header = jdbcTemplate.queryForList("""
            SELECT b.bill_no AS "billNo",
                   COALESCE(b.department, ?) AS counterparty,
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.status,
                   b.total_amount AS "totalAmount"
            FROM %s b
            WHERE b.bill_no = ?
            """.formatted(table), documentLabel, billNo);
        if (header.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, documentLabel + "不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   '' AS "sourceOrderNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.name AS warehouse,
                   trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                   trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM %s l
            JOIN %s b ON b.id = l.bill_id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """.formatted(lineTable, table), billNo);
        return new DocumentPayload(header.get(0), lines);
    }

    private DocumentPayload stockTransferPayload(String billNo) {
        var header = jdbcTemplate.queryForList("""
            SELECT b.bill_no AS "billNo",
                   COALESCE(b.department, '仓储部') AS counterparty,
                   to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
                   b.status,
                   0 AS "totalAmount"
            FROM stock_transfer b
            WHERE b.bill_no = ?
            """, billNo);
        if (header.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "调拨单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   '' AS "sourceOrderNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   sw.name || ' -> ' || tw.name AS warehouse,
                   trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                   trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM stock_transfer_line l
            JOIN stock_transfer b ON b.id = l.bill_id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse sw ON sw.id = l.source_warehouse_id
            JOIN md_warehouse tw ON tw.id = l.target_warehouse_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return new DocumentPayload(header.get(0), lines);
    }

    private DocumentPayload productionBillPayload(String table, String lineTable, String billColumn, String documentLabel, String billNo) {
        var header = jdbcTemplate.queryForList("""
            SELECT b.bill_no AS "billNo",
                   '生产车间 / ' || t.bill_no AS counterparty,
                   to_char(b.created_at, 'YYYY-MM-DD') AS "billDate",
                   b.status,
                   COALESCE(SUM(l.amount), 0) AS "totalAmount",
                   original.bill_no AS "redSourceBillNo"
            FROM %s b
            JOIN production_task t ON t.id = b.task_id
            LEFT JOIN %s original ON original.id = b.red_source_bill_id
            LEFT JOIN %s l ON l.%s = b.id
            WHERE b.bill_no = ?
            GROUP BY b.id, t.bill_no, original.bill_no
            """.formatted(table, table, lineTable, billColumn), billNo);
        if (header.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, documentLabel + "不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   '' AS "sourceOrderNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.name AS warehouse,
                   trim(to_char(l.qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(l.unit_price, 'FM9999999990.00')) AS "unitPrice",
                   trim(to_char(l.amount, 'FM9999999990.00')) AS amount,
                   '' AS "lineRemark"
            FROM %s l
            JOIN %s b ON b.id = l.%s
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE b.bill_no = ?
            ORDER BY l.line_no
            """.formatted(lineTable, table, billColumn), billNo);
        return new DocumentPayload(header.get(0), lines);
    }

    private String title(String documentType) {
        return switch (documentType) {
            case "sales-order" -> "销售订单";
            case "purchase-order" -> "采购订单";
            case "purchase-in" -> "采购入库单";
            case "sales-out" -> "销售出库单";
            case "material-issue" -> "生产领料单";
            case "product-in" -> "产品入库单";
            case "other-stock-in" -> "其他入库单";
            case "other-stock-out" -> "其他出库单";
            case "stock-transfer" -> "调拨单";
            default -> "业务单据";
        };
    }

    private List<String> supportedDocumentTypes() {
        return List.of("sales-order", "purchase-order", "sales-out", "purchase-in", "material-issue", "product-in", "other-stock-in", "other-stock-out", "stock-transfer");
    }

    private Map<String, Object> templateResponse(String documentType, PrintTemplate template) {
        var response = new LinkedHashMap<String, Object>();
        response.put("documentType", documentType);
        response.put("documentTitle", title(documentType));
        response.put("templateCode", template.templateCode());
        response.put("templateName", template.templateName());
        response.put("roleCode", template.roleCode() == null ? "" : template.roleCode());
        response.put("companyName", template.companyName());
        response.put("headerNote", template.headerNote());
        response.put("footerNote", template.footerNote());
        response.put("showSignature", template.showSignature());
        response.put("showSeal", template.showSeal());
        response.put("isDefault", template.isDefault());
        response.put("paperSize", template.paperSize());
        response.put("pageOrientation", template.pageOrientation());
        response.put("marginTopMm", template.marginTopMm());
        response.put("marginRightMm", template.marginRightMm());
        response.put("marginBottomMm", template.marginBottomMm());
        response.put("marginLeftMm", template.marginLeftMm());
        response.put("copyCount", template.copyCount());
        response.put("enabled", template.enabled());
        return response;
    }

    private String escapeCsv(String value) {
        var safe = value == null ? "" : value;
        return "\"" + safe.replace("\"", "\"\"") + "\"";
    }

    private String escapeHtml(String value) {
        return (value == null ? "" : value)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;");
    }

    private PrintTemplate printTemplate(String documentType) {
        var rows = jdbcTemplate.queryForList("""
            SELECT template_code AS "templateCode",
                   template_name AS "templateName",
                   role_code AS "roleCode",
                   company_name AS "companyName",
                   header_note AS "headerNote",
                   footer_note AS "footerNote",
                   show_signature AS "showSignature",
                   show_seal AS "showSeal",
                   is_default AS "isDefault",
                   paper_size AS "paperSize",
                   page_orientation AS "pageOrientation",
                   margin_top_mm AS "marginTopMm",
                   margin_right_mm AS "marginRightMm",
                   margin_bottom_mm AS "marginBottomMm",
                   margin_left_mm AS "marginLeftMm",
                   copy_count AS "copyCount",
                   enabled
            FROM sys_print_template
            WHERE document_type = ?
              AND enabled = TRUE
            ORDER BY
              CASE
                WHEN role_code = ? AND is_default THEN 0
                WHEN role_code IS NULL AND is_default THEN 1
                WHEN role_code = ? THEN 2
                ELSE 3
              END,
              updated_at DESC
            LIMIT 1
            """, documentType, CURRENT_ROLE_CODE, CURRENT_ROLE_CODE);
        if (rows.isEmpty()) {
            return new PrintTemplate(
                "STANDARD",
                "标准套打模板",
                null,
                "博莱德机械测试账套",
                "会计期间 2026-06 / 业务期间 2026-06",
                "本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。",
                true,
                true,
                true,
                "A4",
                "PORTRAIT",
                "12.00",
                "12.00",
                "12.00",
                "12.00",
                1,
                true
            );
        }
        return templateFromRow(rows.get(0));
    }

    private PrintTemplate findPrintTemplate(String documentType, String templateCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT template_code AS "templateCode",
                   template_name AS "templateName",
                   role_code AS "roleCode",
                   company_name AS "companyName",
                   header_note AS "headerNote",
                   footer_note AS "footerNote",
                   show_signature AS "showSignature",
                   show_seal AS "showSeal",
                   is_default AS "isDefault",
                   paper_size AS "paperSize",
                   page_orientation AS "pageOrientation",
                   margin_top_mm AS "marginTopMm",
                   margin_right_mm AS "marginRightMm",
                   margin_bottom_mm AS "marginBottomMm",
                   margin_left_mm AS "marginLeftMm",
                   copy_count AS "copyCount",
                   enabled
            FROM sys_print_template
            WHERE document_type = ?
              AND template_code = ?
              AND enabled = TRUE
            LIMIT 1
            """, documentType, templateCode);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "打印模板不存在");
        }
        return templateFromRow(rows.get(0));
    }

    private PrintTemplate templateFromRow(Map<String, Object> row) {
        return new PrintTemplate(
            String.valueOf(row.get("templateCode")),
            String.valueOf(row.get("templateName")),
            row.get("roleCode") == null ? null : String.valueOf(row.get("roleCode")),
            String.valueOf(row.get("companyName")),
            String.valueOf(row.get("headerNote")),
            String.valueOf(row.get("footerNote")),
            Boolean.TRUE.equals(row.get("showSignature")),
            Boolean.TRUE.equals(row.get("showSeal")),
            Boolean.TRUE.equals(row.get("isDefault")),
            row.get("paperSize") == null ? "A4" : String.valueOf(row.get("paperSize")),
            row.get("pageOrientation") == null ? "PORTRAIT" : String.valueOf(row.get("pageOrientation")),
            decimalString(row.get("marginTopMm"), "12.00"),
            decimalString(row.get("marginRightMm"), "12.00"),
            decimalString(row.get("marginBottomMm"), "12.00"),
            decimalString(row.get("marginLeftMm"), "12.00"),
            row.get("copyCount") instanceof Number number ? Math.max(1, number.intValue()) : 1,
            Boolean.TRUE.equals(row.get("enabled"))
        );
    }

    private byte[] renderPdf(String title, DocumentPayload payload, PrintTemplate template) {
        var page = pageSpec(template);
        var baseLines = new ArrayList<String>();
        baseLines.add("纸张：" + template.paperSize() + "    方向：" + orientationLabel(template.pageOrientation())
            + "    边距：" + template.marginTopMm() + "/" + template.marginRightMm() + "/" + template.marginBottomMm() + "/" + template.marginLeftMm() + "mm"
            + "    联次：" + template.copyCount() + "联");
        baseLines.add(template.companyName());
        baseLines.add(template.headerNote() + "    模板：" + template.templateName());
        baseLines.add(title);
        baseLines.add("单据编号：" + payload.header().get("billNo"));
        baseLines.add("往来单位：" + payload.header().get("counterparty"));
        var redSourceBillNo = String.valueOf(payload.header().getOrDefault("redSourceBillNo", ""));
        if (!redSourceBillNo.isBlank() && !"null".equals(redSourceBillNo)) {
            baseLines.add("来源原单：" + redSourceBillNo);
        }
        baseLines.add("业务日期：" + payload.header().get("billDate") + "    状态：" + payload.header().get("status") + "    合计：" + payload.header().get("totalAmount"));
        baseLines.add("行号  源单号  商品编码  商品名称 / 规格型号");
        for (var line : payload.lines()) {
            baseLines.add(line.get("lineNo") + "  " + line.getOrDefault("sourceOrderNo", "") + "  " + line.get("productCode") + "  " + line.get("productName") + " / " + line.get("spec"));
            baseLines.add("    仓库：" + line.get("warehouse") + "    数量：" + line.get("qty") + "    单价：" + line.get("unitPrice") + "    金额：" + line.get("amount"));
            var remark = String.valueOf(line.get("lineRemark"));
            if (!remark.isBlank()) {
                baseLines.add("    备注：" + remark);
            }
        }
        baseLines.add("");
        if (template.showSignature()) {
            baseLines.add("制单：本地管理员    审核：____________");
            baseLines.add("财务：____________    仓管：____________");
        }
        if (template.showSeal()) {
            baseLines.add("公司章：________________");
        }
        baseLines.add("打印日期：" + LocalDate.now());
        baseLines.add("归档提示：" + template.footerNote());

        var objects = new ArrayList<String>();
        objects.add("<< /Type /Catalog /Pages 2 0 R >>");
        objects.add("PAGES_PLACEHOLDER");
        objects.add("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>");
        objects.add("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 5 0 R >>");
        objects.add("<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>");

        var pageObjectNumbers = new ArrayList<Integer>();
        for (var copy = 1; copy <= template.copyCount(); copy += 1) {
            var content = renderPdfPageContent(title, page, baseLines, copy, template.copyCount());
            var contentBytes = content.getBytes(StandardCharsets.US_ASCII);
            var pageObjectNumber = objects.size() + 1;
            var contentObjectNumber = pageObjectNumber + 1;
            pageObjectNumbers.add(pageObjectNumber);
            objects.add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + page.widthPt() + " " + page.heightPt() + "] /Resources << /Font << /F1 3 0 R >> >> /Contents " + contentObjectNumber + " 0 R >>");
            objects.add("<< /Length " + contentBytes.length + " >>\nstream\n" + content + "endstream");
        }

        var kids = new StringBuilder("[");
        for (var pageObjectNumber : pageObjectNumbers) {
            kids.append(pageObjectNumber).append(" 0 R ");
        }
        kids.append("]");
        objects.set(1, "<< /Type /Pages /Kids " + kids + " /Count " + pageObjectNumbers.size() + " >>");

        var output = new ByteArrayOutputStream();
        writeLatin1(output, "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
        var offsets = new ArrayList<Integer>();
        for (var index = 0; index < objects.size(); index += 1) {
            offsets.add(output.size());
            writeAscii(output, (index + 1) + " 0 obj\n" + objects.get(index) + "\nendobj\n");
        }
        var xrefOffset = output.size();
        writeAscii(output, "xref\n0 " + (objects.size() + 1) + "\n");
        writeAscii(output, "0000000000 65535 f \n");
        for (var offset : offsets) {
            writeAscii(output, String.format("%010d 00000 n \n", offset));
        }
        writeAscii(output, "trailer\n<< /Size " + (objects.size() + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n");
        return output.toByteArray();
    }

    private String renderPdfPageContent(String title, PageSpec page, List<String> baseLines, int copyIndex, int copyCount) {
        var lines = new ArrayList<String>();
        lines.add("第" + copyIndex + "联 / 共" + copyCount + "联");
        lines.addAll(baseLines);
        var content = new StringBuilder();
        var y = page.heightPt() - page.marginTopPt();
        for (var index = 0; index < lines.size(); index += 1) {
            if (y < page.marginBottomPt() + 20) {
                break;
            }
            var isTitle = title.equals(lines.get(index));
            var fontSize = isTitle ? 16 : index <= 2 ? 12 : 10;
            var x = isTitle ? Math.max(page.marginLeftPt(), (page.widthPt() / 2) - 40) : page.marginLeftPt();
            content.append("BT /F1 ").append(fontSize).append(" Tf 1 0 0 1 ").append(x).append(' ').append(y).append(" Tm <")
                .append(utf16Hex(lines.get(index)))
                .append("> Tj ET\n");
            y -= isTitle ? 30 : 20;
        }
        return content.toString();
    }

    private PageSpec pageSpec(PrintTemplate template) {
        var baseWidth = "A5".equalsIgnoreCase(template.paperSize()) ? 420 : 595;
        var baseHeight = "A5".equalsIgnoreCase(template.paperSize()) ? 595 : 842;
        var landscape = "LANDSCAPE".equalsIgnoreCase(template.pageOrientation());
        var width = landscape ? baseHeight : baseWidth;
        var height = landscape ? baseWidth : baseHeight;
        return new PageSpec(
            width,
            height,
            mmToPt(template.marginTopMm()),
            mmToPt(template.marginRightMm()),
            mmToPt(template.marginBottomMm()),
            mmToPt(template.marginLeftMm()),
            template.paperSize() + (landscape ? " landscape" : ""),
            template.marginTopMm() + "mm " + template.marginRightMm() + "mm " + template.marginBottomMm() + "mm " + template.marginLeftMm() + "mm"
        );
    }

    private int mmToPt(String value) {
        return BigDecimal.valueOf(Double.parseDouble(value)).multiply(BigDecimal.valueOf(72)).divide(BigDecimal.valueOf(25.4), 0, java.math.RoundingMode.HALF_UP).intValue();
    }

    private String normalizePaperSize(String value) {
        if ("A5".equalsIgnoreCase(value)) {
            return "A5";
        }
        return "A4";
    }

    private String normalizeOrientation(String value) {
        if ("LANDSCAPE".equalsIgnoreCase(value)) {
            return "LANDSCAPE";
        }
        return "PORTRAIT";
    }

    private String orientationLabel(String value) {
        return "LANDSCAPE".equalsIgnoreCase(value) ? "横向" : "纵向";
    }

    private BigDecimal clampDecimal(BigDecimal value, int min, int max, BigDecimal fallback) {
        var actual = value == null ? fallback : value;
        if (actual.compareTo(BigDecimal.valueOf(min)) < 0) {
            return BigDecimal.valueOf(min);
        }
        if (actual.compareTo(BigDecimal.valueOf(max)) > 0) {
            return BigDecimal.valueOf(max);
        }
        return actual;
    }

    private int clampInt(Integer value, int min, int max, int fallback) {
        var actual = value == null ? fallback : value;
        return Math.max(min, Math.min(max, actual));
    }

    private String decimalString(Object value, String fallback) {
        if (value instanceof BigDecimal decimal) {
            return decimal.stripTrailingZeros().toPlainString();
        }
        if (value instanceof Number number) {
            return BigDecimal.valueOf(number.doubleValue()).stripTrailingZeros().toPlainString();
        }
        return fallback;
    }

    private String utf16Hex(String value) {
        var bytes = (value == null ? "" : value).getBytes(StandardCharsets.UTF_16BE);
        var hex = new StringBuilder(bytes.length * 2);
        for (var b : bytes) {
            hex.append(String.format("%02X", b & 0xff));
        }
        return hex.toString();
    }

    private void writeAscii(ByteArrayOutputStream output, String value) {
        output.writeBytes(value.getBytes(StandardCharsets.US_ASCII));
    }

    private void writeLatin1(ByteArrayOutputStream output, String value) {
        output.writeBytes(value.getBytes(StandardCharsets.ISO_8859_1));
    }

    private record DocumentPayload(Map<String, Object> header, List<Map<String, Object>> lines) {
    }

    private record PrintTemplate(
        String templateCode,
        String templateName,
        String roleCode,
        String companyName,
        String headerNote,
        String footerNote,
        boolean showSignature,
        boolean showSeal,
        boolean isDefault,
        String paperSize,
        String pageOrientation,
        String marginTopMm,
        String marginRightMm,
        String marginBottomMm,
        String marginLeftMm,
        int copyCount,
        boolean enabled
    ) {
    }

    private record PageSpec(
        int widthPt,
        int heightPt,
        int marginTopPt,
        int marginRightPt,
        int marginBottomPt,
        int marginLeftPt,
        String cssSize,
        String cssMargin
    ) {
    }

    public record PrintTemplateRequest(
        String templateCode,
        String templateName,
        String roleCode,
        String companyName,
        String headerNote,
        String footerNote,
        Boolean showSignature,
        Boolean showSeal,
        Boolean isDefault,
        String paperSize,
        String pageOrientation,
        BigDecimal marginTopMm,
        BigDecimal marginRightMm,
        BigDecimal marginBottomMm,
        BigDecimal marginLeftMm,
        Integer copyCount
    ) {
    }
}
