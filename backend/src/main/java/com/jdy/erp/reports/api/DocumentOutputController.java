package com.jdy.erp.reports.api;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api/documents")
public class DocumentOutputController {
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
        csv.append("行号,商品编码,商品名称,规格型号,仓库,数量,单价,金额,备注\n");
        for (var line : payload.lines()) {
            csv.append(escapeCsv(String.valueOf(line.get("lineNo")))).append(',')
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
        var html = new StringBuilder("""
            <!doctype html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8">
              <title>PRINT_TITLE</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2937; margin: 28px; }
                .template-head { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-bottom: 8px; font-size: 12px; color: #4b5563; }
                .template-head strong { display: block; color: #111827; font-size: 15px; }
                h1 { font-size: 20px; margin: 0 0 18px; text-align: center; }
                .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 18px; font-size: 12px; margin-bottom: 16px; }
                table { width: 100%; border-collapse: collapse; font-size: 12px; }
                th, td { border: 1px solid #d8e0eb; padding: 7px 8px; text-align: left; }
                th { background: #f3f7fb; }
                .amount { text-align: right; }
                .remark { min-width: 150px; white-space: normal; line-height: 1.5; }
                .signature { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 28px; font-size: 12px; }
                .signature div { border-top: 1px solid #9ca3af; padding-top: 8px; }
                .seal { width: 116px; height: 72px; border: 1px dashed #9ca3af; display: grid; place-items: center; color: #6b7280; justify-self: end; }
                .footer-note { margin-top: 14px; font-size: 11px; color: #6b7280; }
              </style>
            </head>
            <body>
            """.replace("PRINT_TITLE", escapeHtml(title(documentType))));
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
            .append("<div>状态：").append(escapeHtml(String.valueOf(payload.header().get("status")))).append("</div>")
            .append("</section>");
        html.append("<table><thead><tr><th>行号</th><th>商品编码</th><th>商品名称</th><th>规格型号</th><th>仓库</th><th>数量</th><th>单价</th><th>金额</th><th>备注</th></tr></thead><tbody>");
        for (var line : payload.lines()) {
            html.append("<tr>")
                .append("<td>").append(escapeHtml(String.valueOf(line.get("lineNo")))).append("</td>")
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
        html.append("<p class=\"footer-note\">").append(escapeHtml(template.footerNote())).append("</p>");
        html.append("</body></html>");
        return ResponseEntity.ok()
            .contentType(new MediaType("text", "html", StandardCharsets.UTF_8))
            .body(html.toString());
    }

    @GetMapping("/{documentType}/print-template")
    public Map<String, Object> printTemplateConfig(@PathVariable String documentType) {
        var template = printTemplate(documentType);
        return Map.of(
            "documentType", documentType,
            "templateCode", template.templateCode(),
            "templateName", template.templateName(),
            "companyName", template.companyName(),
            "headerNote", template.headerNote(),
            "footerNote", template.footerNote(),
            "showSignature", template.showSignature(),
            "showSeal", template.showSeal()
        );
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

    private DocumentPayload productionBillPayload(String table, String lineTable, String billColumn, String documentLabel, String billNo) {
        var header = jdbcTemplate.queryForList("""
            SELECT b.bill_no AS "billNo",
                   '生产车间 / ' || t.bill_no AS counterparty,
                   to_char(b.created_at, 'YYYY-MM-DD') AS "billDate",
                   b.status,
                   COALESCE(SUM(l.amount), 0) AS "totalAmount"
            FROM %s b
            JOIN production_task t ON t.id = b.task_id
            LEFT JOIN %s l ON l.%s = b.id
            WHERE b.bill_no = ?
            GROUP BY b.id, t.bill_no
            """.formatted(table, lineTable, billColumn), billNo);
        if (header.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, documentLabel + "不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
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
            default -> "业务单据";
        };
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
                   company_name AS "companyName",
                   header_note AS "headerNote",
                   footer_note AS "footerNote",
                   show_signature AS "showSignature",
                   show_seal AS "showSeal"
            FROM sys_print_template
            WHERE document_type = ?
              AND enabled = TRUE
            ORDER BY is_default DESC, updated_at DESC
            LIMIT 1
            """, documentType);
        if (rows.isEmpty()) {
            return new PrintTemplate(
                "STANDARD",
                "标准套打模板",
                "博莱德机械测试账套",
                "会计期间 2026-06 / 业务期间 2026-06",
                "本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。",
                true,
                true
            );
        }
        var row = rows.get(0);
        return new PrintTemplate(
            String.valueOf(row.get("templateCode")),
            String.valueOf(row.get("templateName")),
            String.valueOf(row.get("companyName")),
            String.valueOf(row.get("headerNote")),
            String.valueOf(row.get("footerNote")),
            Boolean.TRUE.equals(row.get("showSignature")),
            Boolean.TRUE.equals(row.get("showSeal"))
        );
    }

    private byte[] renderPdf(String title, DocumentPayload payload, PrintTemplate template) {
        var lines = new ArrayList<String>();
        lines.add(template.companyName());
        lines.add(template.headerNote() + "    模板：" + template.templateName());
        lines.add(title);
        lines.add("单据编号：" + payload.header().get("billNo"));
        lines.add("往来单位：" + payload.header().get("counterparty"));
        lines.add("业务日期：" + payload.header().get("billDate") + "    状态：" + payload.header().get("status") + "    合计：" + payload.header().get("totalAmount"));
        lines.add("行号  商品编码  商品名称 / 规格型号");
        for (var line : payload.lines()) {
            lines.add(line.get("lineNo") + "  " + line.get("productCode") + "  " + line.get("productName") + " / " + line.get("spec"));
            lines.add("    仓库：" + line.get("warehouse") + "    数量：" + line.get("qty") + "    单价：" + line.get("unitPrice") + "    金额：" + line.get("amount"));
            var remark = String.valueOf(line.get("lineRemark"));
            if (!remark.isBlank()) {
                lines.add("    备注：" + remark);
            }
        }
        lines.add("");
        if (template.showSignature()) {
            lines.add("制单：本地管理员    审核：____________");
            lines.add("财务：____________    仓管：____________");
        }
        if (template.showSeal()) {
            lines.add("公司章：________________");
        }
        lines.add("打印日期：" + LocalDate.now());
        lines.add("归档提示：" + template.footerNote());

        var content = new StringBuilder();
        var y = 800;
        for (var index = 0; index < lines.size(); index += 1) {
            var fontSize = index == 2 ? 16 : index == 0 ? 12 : 10;
            var x = index == 2 ? 260 : 42;
            content.append("BT /F1 ").append(fontSize).append(" Tf 1 0 0 1 ").append(x).append(' ').append(y).append(" Tm <")
                .append(utf16Hex(lines.get(index)))
                .append("> Tj ET\n");
            y -= index == 2 ? 30 : 20;
        }

        var contentBytes = content.toString().getBytes(StandardCharsets.US_ASCII);
        var objects = List.of(
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
            "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>",
            "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 6 0 R >>",
            "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
            "<< /Length " + contentBytes.length + " >>\nstream\n" + content + "endstream"
        );

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
        String companyName,
        String headerNote,
        String footerNote,
        boolean showSignature,
        boolean showSeal
    ) {
    }
}
