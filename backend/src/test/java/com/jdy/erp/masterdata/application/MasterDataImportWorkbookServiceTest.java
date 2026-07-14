package com.jdy.erp.masterdata.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.SheetVisibility;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class MasterDataImportWorkbookServiceTest {
    private MasterDataImportDefinitionRegistry definitions;
    private MasterDataImportWorkbookService service;

    @BeforeEach
    void setUp() {
        definitions = new MasterDataImportDefinitionRegistry();
        service = new MasterDataImportWorkbookService(definitions);
    }

    @Test
    void parsesAllCheckedInTemplatesAgainstRegistry() throws Exception {
        for (var definition : definitions.all()) {
            try (var input = getClass().getClassLoader().getResourceAsStream(definition.resourcePath())) {
                assertThat(input).as(definition.resourcePath()).isNotNull();
                var bytes = input.readAllBytes();

                var parsed = service.parse(definition, definition.fileName(), bytes.length, new ByteArrayInputStream(bytes));

                assertThat(parsed.type()).isEqualTo(definition.type());
                assertThat(parsed.templateVersion()).isEqualTo(MasterDataImportDefinitionRegistry.TEMPLATE_VERSION);
                assertThat(parsed.fileSizeBytes()).isEqualTo(bytes.length);
                assertThat(parsed.sha256()).hasSize(64).matches("[0-9a-f]{64}");
                assertThat(parsed.rows()).isEmpty();
            }
        }
    }

    @Test
    void preservesDisplayedLeadingZerosAndAppliesCanonicalDefaults() throws Exception {
        var definition = definitions.require("unit");
        var bytes = workbook(definition, workbook -> {
            var row = workbook.getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET).createRow(2);
            row.createCell(0).setCellValue(" 0007 ");
            row.createCell(1).setCellValue(2);
        });

        var parsed = parse(definition, bytes);

        assertThat(parsed.rows()).singleElement().satisfies(row -> {
            assertThat(row.rowNo()).isEqualTo(3);
            assertThat(row.payload()).hasSize(4).containsAllEntriesOf(Map.of(
                "code", "0007",
                "decimalPlaces", "2",
                "sortNo", "0",
                "status", "启用"
            ));
            assertThat(row.errors()).isEmpty();
        });
    }

    @Test
    void returnsStructuredErrorsForRequiredBooleanDecimalAndRangeFailures() throws Exception {
        var definition = definitions.require("product");
        var bytes = workbook(definition, workbook -> {
            var row = workbook.getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET).createRow(2);
            setByKey(row, definition, "code", "P-001");
            setByKey(row, definition, "name", "测试物料");
            setByKey(row, definition, "category", "C-001");
            setByKey(row, definition, "netWeight", "1E3");
            setByKey(row, definition, "isSale", "TRUE");
            setByKey(row, definition, "purchasePrice", "-1");
            setByKey(row, definition, "taxRate", "12345");
        });

        var row = parse(definition, bytes).rows().getFirst();

        assertThat(row.payload()).containsEntry("code", "P-001");
        assertThat(row.errors())
            .extracting(MasterDataImportWorkbookService.RowError::field, MasterDataImportWorkbookService.RowError::code)
            .contains(
                org.assertj.core.groups.Tuple.tuple("unit", "REQUIRED"),
                org.assertj.core.groups.Tuple.tuple("netWeight", "TYPE_ERROR"),
                org.assertj.core.groups.Tuple.tuple("isSale", "INVALID_BOOLEAN"),
                org.assertj.core.groups.Tuple.tuple("purchasePrice", "OUT_OF_RANGE"),
                org.assertj.core.groups.Tuple.tuple("taxRate", "OUT_OF_RANGE")
            );
    }

    @Test
    void reportsEveryOccurrenceOfDuplicateWorkbookCode() throws Exception {
        var definition = definitions.require("customer");
        var bytes = workbook(definition, workbook -> {
            var sheet = workbook.getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET);
            var first = sheet.createRow(2);
            setByKey(first, definition, "code", "C-001");
            setByKey(first, definition, "name", "客户一");
            var second = sheet.createRow(7);
            setByKey(second, definition, "code", " C-001 ");
            setByKey(second, definition, "name", "客户二");
        });

        var parsed = parse(definition, bytes);

        assertThat(parsed.rows()).extracting(MasterDataImportWorkbookService.ParsedRow::rowNo).containsExactly(3, 8);
        assertThat(parsed.rows()).allSatisfy(row -> assertThat(row.errors())
            .extracting(MasterDataImportWorkbookService.RowError::code)
            .contains("DUPLICATE_FILE_CODE"));
    }

    @Test
    void rejectsFormulaWithoutUsingCachedValue() throws Exception {
        var definition = definitions.require("customer");
        var bytes = workbook(definition, workbook -> {
            var row = workbook.getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET).createRow(2);
            row.createCell(0).setCellFormula("1+1");
            setByKey(row, definition, "name", "公式客户");
        });

        assertBadRequest(() -> parse(definition, bytes));
    }

    @Test
    void rejectsWrongExtensionUnknownHeaderWrongMetaAndExtraSheet() throws Exception {
        var definition = definitions.require("customer");
        var valid = workbook(definition, ignored -> {
        });
        assertBadRequest(() -> service.parse(definition, "customer.xls", valid.length, new ByteArrayInputStream(valid)));

        var wrongHeader = workbook(definition, workbook -> workbook
            .getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET)
            .getRow(1)
            .getCell(0)
            .setCellValue("未知列"));
        assertBadRequest(() -> parse(definition, wrongHeader));

        var wrongMeta = workbook(definition, workbook -> workbook
            .getSheet(MasterDataImportDefinitionRegistry.META_SHEET)
            .getRow(2)
            .getCell(1)
            .setCellValue("supplier"));
        assertBadRequest(() -> parse(definition, wrongMeta));

        var extraSheet = workbook(definition, workbook -> workbook.createSheet("额外数据"));
        assertBadRequest(() -> parse(definition, extraSheet));
    }

    @Test
    void rejectsMacroExternalLinkAndNonOoxmlPayloads() throws Exception {
        var definition = definitions.require("customer");
        var valid = workbook(definition, ignored -> {
        });

        assertBadRequest(() -> parse(definition, addZipEntry(valid, "xl/vbaProject.bin", new byte[] {1, 2, 3})));
        assertBadRequest(() -> parse(definition, addZipEntry(
            valid,
            "xl/externalLinks/externalLink1.xml",
            "<externalLink/>".getBytes(StandardCharsets.UTF_8)
        )));
        assertBadRequest(() -> parse(definition, "not a workbook".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void enforcesDeclaredSizeExpandedSizeRowColumnAndCellLimits() throws Exception {
        var definition = definitions.require("customer");
        var valid = workbook(definition, ignored -> {
        });
        var declaredAtLimit = service.parse(
            definition,
            definition.fileName(),
            MasterDataImportDefinitionRegistry.MAX_FILE_BYTES,
            new ByteArrayInputStream(valid)
        );
        assertThat(declaredAtLimit.fileSizeBytes()).isEqualTo(valid.length);
        var exactMaximumFile = padXlsxToExactSize(
            valid,
            Math.toIntExact(MasterDataImportDefinitionRegistry.MAX_FILE_BYTES)
        );
        var parsedMaximumFile = service.parse(
            definition,
            definition.fileName(),
            exactMaximumFile.length,
            new ByteArrayInputStream(exactMaximumFile)
        );
        assertThat(parsedMaximumFile.fileSizeBytes())
            .isEqualTo(MasterDataImportDefinitionRegistry.MAX_FILE_BYTES);
        assertStatus(
            HttpStatus.PAYLOAD_TOO_LARGE,
            () -> service.parse(
                definition,
                definition.fileName(),
                MasterDataImportDefinitionRegistry.MAX_FILE_BYTES + 1,
                new ByteArrayInputStream(valid)
            )
        );

        var maximumRows = workbook(definition, workbook -> {
            var sheet = workbook.getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET);
            for (int index = 0; index < MasterDataImportDefinitionRegistry.MAX_DATA_ROWS; index++) {
                var row = sheet.createRow(index + 2);
                row.createCell(0).setCellValue("C-MAX-" + index);
                row.createCell(1).setCellValue("边界客户 " + index);
            }
        });
        var parsedAtRowLimit = parse(definition, maximumRows);
        assertThat(parsedAtRowLimit.rows()).hasSize(MasterDataImportDefinitionRegistry.MAX_DATA_ROWS);
        assertThat(parsedAtRowLimit.rows().getFirst().rowNo()).isEqualTo(3);
        assertThat(parsedAtRowLimit.rows().getLast().rowNo())
            .isEqualTo(MasterDataImportDefinitionRegistry.MAX_DATA_ROWS + 2);

        var tooManyRows = workbook(definition, workbook -> {
            var sheet = workbook.getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET);
            for (int index = 0; index <= MasterDataImportDefinitionRegistry.MAX_DATA_ROWS; index++) {
                var row = sheet.createRow(index + 2);
                row.createCell(0).setCellValue("C-" + index);
                row.createCell(1).setCellValue("客户 " + index);
            }
        });
        assertStatus(HttpStatus.PAYLOAD_TOO_LARGE, () -> parse(definition, tooManyRows));

        var tooManyColumns = workbook(definition, workbook -> workbook
            .getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET)
            .createRow(2)
            .createCell(MasterDataImportDefinitionRegistry.MAX_COLUMNS)
            .setCellValue("越界"));
        assertBadRequest(() -> parse(definition, tooManyColumns));

        var longCellBase = workbook(definition, workbook -> {
            var row = workbook.getSheet(MasterDataImportDefinitionRegistry.DATA_SHEET).createRow(2);
            row.createCell(0).setCellValue("CELL_LIMIT_MARKER");
            row.createCell(1).setCellValue("客户");
        });
        var longCell = rewriteZipEntry(longCellBase, "xl/sharedStrings.xml", xml -> {
            var source = new String(xml, StandardCharsets.UTF_8);
            return source.replace(
                "CELL_LIMIT_MARKER",
                "X".repeat(MasterDataImportDefinitionRegistry.MAX_CELL_CHARACTERS + 1)
            ).getBytes(StandardCharsets.UTF_8);
        });
        assertBadRequest(() -> parse(definition, longCell));

        var expandedBomb = zipWithExpandedEntry(
            "xl/worksheets/sheet1.xml",
            MasterDataImportDefinitionRegistry.MAX_EXPANDED_BYTES + 1
        );
        assertStatus(HttpStatus.PAYLOAD_TOO_LARGE, () -> parse(definition, expandedBomb));
    }

    @Test
    void createsStableFormulaFreeXlsxErrorReceipt() throws Exception {
        var errors = List.of(
            new MasterDataImportWorkbookService.ReceiptError(8, "0008", "phone", "INVALID", "电话错误", "=1+1"),
            new MasterDataImportWorkbookService.ReceiptError(3, "0003", "code", "DUPLICATE", "编码重复", "0003")
        );

        var bytes = service.createErrorReceipt("customer", errors);

        assertThat(bytes).startsWith((byte) 'P', (byte) 'K');
        try (var workbook = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            assertThat(workbook.getNumberOfSheets()).isOne();
            var sheet = workbook.getSheet("错误回执");
            assertThat(sheet.getRow(0).getCell(0).getStringCellValue()).contains("客户", "Excel", "错误回执");
            assertThat(sheet.getRow(1).getCell(0).getStringCellValue()).isEqualTo("行号");
            assertThat(sheet.getRow(2).getCell(0).getNumericCellValue()).isEqualTo(3);
            assertThat(sheet.getRow(2).getCell(1).getStringCellValue()).isEqualTo("0003");
            assertThat(sheet.getRow(3).getCell(0).getNumericCellValue()).isEqualTo(8);
            assertThat(sheet.getRow(3).getCell(5).getCellType()).isEqualTo(CellType.STRING);
            assertThat(sheet.getRow(3).getCell(5).getStringCellValue()).isEqualTo("=1+1");
            for (var row : sheet) {
                for (var cell : row) {
                    assertThat(cell.getCellType()).isNotEqualTo(CellType.FORMULA);
                }
            }
        }
    }

    private MasterDataImportWorkbookService.ParsedWorkbook parse(
        MasterDataImportDefinitionRegistry.ImportDefinition definition,
        byte[] bytes
    ) {
        return service.parse(definition, definition.fileName(), bytes.length, new ByteArrayInputStream(bytes));
    }

    private byte[] workbook(
        MasterDataImportDefinitionRegistry.ImportDefinition definition,
        Consumer<XSSFWorkbook> customizer
    ) throws IOException {
        try (var workbook = new XSSFWorkbook();
             var output = new ByteArrayOutputStream()) {
            var data = workbook.createSheet(MasterDataImportDefinitionRegistry.DATA_SHEET);
            data.createRow(0).createCell(0).setCellValue(definition.title() + "导入模板");
            var header = data.createRow(1);
            for (int column = 0; column < definition.headers().size(); column++) {
                header.createCell(column).setCellValue(definition.headers().get(column));
            }
            workbook.createSheet(MasterDataImportDefinitionRegistry.GUIDE_SHEET)
                .createRow(0)
                .createCell(0)
                .setCellValue("填写说明");
            var meta = workbook.createSheet(MasterDataImportDefinitionRegistry.META_SHEET);
            var metadata = List.of(
                List.of("key", "value"),
                List.of("contract", "A143"),
                List.of("type", definition.type()),
                List.of("version", "1"),
                List.of("dataSheet", MasterDataImportDefinitionRegistry.DATA_SHEET),
                List.of("headerRow", "2"),
                List.of("maxDataRows", "5000")
            );
            for (int rowIndex = 0; rowIndex < metadata.size(); rowIndex++) {
                var row = meta.createRow(rowIndex);
                row.createCell(0).setCellValue(metadata.get(rowIndex).get(0));
                row.createCell(1).setCellValue(metadata.get(rowIndex).get(1));
            }
            meta.protectSheet("");
            workbook.setSheetVisibility(workbook.getSheetIndex(meta), SheetVisibility.VERY_HIDDEN);
            customizer.accept(workbook);
            workbook.write(output);
            return output.toByteArray();
        }
    }

    private static void setByKey(
        org.apache.poi.ss.usermodel.Row row,
        MasterDataImportDefinitionRegistry.ImportDefinition definition,
        String key,
        String value
    ) {
        for (int column = 0; column < definition.fields().size(); column++) {
            if (definition.fields().get(column).key().equals(key)) {
                row.createCell(column).setCellValue(value);
                return;
            }
        }
        throw new IllegalArgumentException("Unknown field: " + key);
    }

    private static byte[] addZipEntry(byte[] source, String entryName, byte[] entryBytes) throws IOException {
        return rewriteZip(source, Map.of(), Map.of(entryName, entryBytes));
    }

    private static byte[] rewriteZipEntry(byte[] source, String entryName, BytesTransform transform) throws IOException {
        return rewriteZip(source, Map.of(entryName, transform), Map.of());
    }

    private static byte[] padXlsxToExactSize(byte[] source, int targetBytes) throws IOException {
        var emptyPaddingArchive = rewriteZipWithStoredPadding(source, new byte[0]);
        var paddingSize = targetBytes - emptyPaddingArchive.length;
        if (paddingSize <= 0) {
            throw new IllegalArgumentException("Target XLSX size is too small for fixed ZIP overhead");
        }
        var padding = new byte[paddingSize];
        Arrays.fill(padding, (byte) 0x5a);
        var padded = rewriteZipWithStoredPadding(source, padding);
        if (padded.length != targetBytes) {
            throw new IllegalStateException("Stored ZIP padding did not produce the exact target size");
        }
        return padded;
    }

    private static byte[] rewriteZipWithStoredPadding(byte[] source, byte[] padding) throws IOException {
        try (var input = new ZipInputStream(new ByteArrayInputStream(source));
             var outputBytes = new ByteArrayOutputStream();
             var output = new ZipOutputStream(outputBytes)) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                var bytes = input.readAllBytes();
                if ("[Content_Types].xml".equals(entry.getName())) {
                    var contentTypes = new String(bytes, StandardCharsets.UTF_8);
                    if (!contentTypes.contains("</Types>")) {
                        throw new IllegalArgumentException("OOXML content types root is not supported by the test helper");
                    }
                    bytes = contentTypes.replace(
                        "</Types>",
                        "<Default Extension=\"pad\" ContentType=\"application/octet-stream\"/></Types>"
                    ).getBytes(StandardCharsets.UTF_8);
                }
                output.putNextEntry(new ZipEntry(entry.getName()));
                if (!entry.isDirectory()) {
                    output.write(bytes);
                }
                output.closeEntry();
            }

            var checksum = new CRC32();
            checksum.update(padding);
            var paddingEntry = new ZipEntry("xl/a143-padding.pad");
            paddingEntry.setMethod(ZipEntry.STORED);
            paddingEntry.setSize(padding.length);
            paddingEntry.setCompressedSize(padding.length);
            paddingEntry.setCrc(checksum.getValue());
            output.putNextEntry(paddingEntry);
            output.write(padding);
            output.closeEntry();
            output.finish();
            return outputBytes.toByteArray();
        }
    }

    private static byte[] rewriteZip(
        byte[] source,
        Map<String, BytesTransform> transforms,
        Map<String, byte[]> additions
    ) throws IOException {
        try (var input = new ZipInputStream(new ByteArrayInputStream(source));
             var outputBytes = new ByteArrayOutputStream();
             var output = new ZipOutputStream(outputBytes)) {
            ZipEntry entry;
            var seen = new ArrayList<String>();
            while ((entry = input.getNextEntry()) != null) {
                var bytes = input.readAllBytes();
                var transform = transforms.get(entry.getName());
                if (transform != null) {
                    bytes = transform.apply(bytes);
                }
                output.putNextEntry(new ZipEntry(entry.getName()));
                if (!entry.isDirectory()) {
                    output.write(bytes);
                }
                output.closeEntry();
                seen.add(entry.getName());
            }
            for (var addition : additions.entrySet()) {
                var name = addition.getKey();
                var bytes = addition.getValue();
                if (seen.contains(name)) {
                    throw new IllegalArgumentException("Duplicate ZIP test entry: " + name);
                }
                output.putNextEntry(new ZipEntry(name));
                output.write(bytes);
                output.closeEntry();
            }
            output.finish();
            return outputBytes.toByteArray();
        }
    }

    private static byte[] zipWithExpandedEntry(String entryName, long expandedBytes) throws IOException {
        try (var bytes = new ByteArrayOutputStream();
             var output = new ZipOutputStream(bytes)) {
            output.putNextEntry(new ZipEntry(entryName));
            var block = new byte[16 * 1024];
            long remaining = expandedBytes;
            while (remaining > 0) {
                var write = (int) Math.min(block.length, remaining);
                output.write(block, 0, write);
                remaining -= write;
            }
            output.closeEntry();
            output.finish();
            return bytes.toByteArray();
        }
    }

    private static void assertBadRequest(ThrowingOperation operation) {
        assertStatus(HttpStatus.BAD_REQUEST, operation);
    }

    private static void assertStatus(HttpStatus expected, ThrowingOperation operation) {
        assertThatThrownBy(operation::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(expected));
    }

    @FunctionalInterface
    private interface ThrowingOperation {
        void run() throws Exception;
    }

    @FunctionalInterface
    private interface BytesTransform {
        byte[] apply(byte[] source) throws IOException;
    }

}
