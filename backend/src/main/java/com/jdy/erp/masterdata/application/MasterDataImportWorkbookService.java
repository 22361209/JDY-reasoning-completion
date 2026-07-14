package com.jdy.erp.masterdata.application;

import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.DATA_SHEET;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.GUIDE_SHEET;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.MAX_CELL_CHARACTERS;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.MAX_COLUMNS;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.MAX_DATA_ROWS;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.MAX_EXPANDED_BYTES;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.MAX_FILE_BYTES;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.META_SHEET;
import static com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry.TEMPLATE_VERSION;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;

import org.apache.commons.compress.archivers.zip.ZipArchiveEntry;
import org.apache.poi.openxml4j.exceptions.InvalidFormatException;
import org.apache.poi.openxml4j.exceptions.OpenXML4JException;
import org.apache.poi.openxml4j.opc.OPCPackage;
import org.apache.poi.openxml4j.opc.PackageAccess;
import org.apache.poi.openxml4j.util.ZipSecureFile;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.HorizontalAlignment;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.ss.util.CellReference;
import org.apache.poi.util.XMLHelper;
import org.apache.poi.xssf.eventusermodel.XSSFReader;
import org.apache.poi.xssf.eventusermodel.XSSFSheetXMLHandler;
import org.apache.poi.xssf.model.SharedStrings;
import org.apache.poi.xssf.model.Styles;
import org.apache.poi.xssf.streaming.SXSSFWorkbook;
import org.apache.poi.xssf.usermodel.XSSFComment;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.XMLReader;
import org.xml.sax.helpers.DefaultHandler;
import org.xml.sax.helpers.XMLFilterImpl;

/**
 * Handles untrusted A143 workbooks without touching tenant or business data.
 *
 * <p>The input is staged to a bounded temporary file, fully subjected to ZIP expansion limits, and then parsed
 * through POI's event model. Structural/security failures are HTTP 400/413 errors; field failures are returned as
 * stable, structured row errors so the import workflow can persist an INVALID preview.</p>
 */
@Service
public final class MasterDataImportWorkbookService {
    public static final int MAX_ERROR_VALUE_CHARACTERS = 256;

    private static final int BUFFER_SIZE = 16 * 1024;
    private static final long MAX_XML_CONTROL_PART_BYTES = 1024L * 1024;
    private static final String WORKBOOK_CONTENT_TYPE =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
    private static final Pattern ORDINARY_INTEGER = Pattern.compile("[0-9]+");
    private static final Pattern ORDINARY_DECIMAL = Pattern.compile("[0-9]+(?:\\.[0-9]+)?");
    private static final Pattern NEGATIVE_INTEGER = Pattern.compile("-[0-9]+");
    private static final Pattern NEGATIVE_DECIMAL = Pattern.compile("-[0-9]+(?:\\.[0-9]+)?");
    private static final Set<String> REQUIRED_PACKAGE_PARTS = Set.of(
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels"
    );
    private static final Set<String> REQUIRED_SHEETS = Set.of(DATA_SHEET, GUIDE_SHEET, META_SHEET);

    private final MasterDataImportDefinitionRegistry definitions;

    public MasterDataImportWorkbookService(MasterDataImportDefinitionRegistry definitions) {
        this.definitions = Objects.requireNonNull(definitions, "definitions");
    }

    /**
     * Parses an A143 workbook and returns normalized, whitelist-only row payloads.
     * The caller retains ownership of {@code source}; this method consumes but does not close it.
     */
    public ParsedWorkbook parse(
        MasterDataImportDefinitionRegistry.ImportDefinition definition,
        String originalFilename,
        long declaredSize,
        InputStream source
    ) {
        Objects.requireNonNull(definition, "definition");
        Objects.requireNonNull(source, "source");
        validateFilename(originalFilename);
        if (declaredSize > MAX_FILE_BYTES) {
            throw payloadTooLarge("Excel 文件不能超过 10 MiB");
        }

        StagedFile staged = null;
        try {
            staged = stage(source);
            validateZipSignature(staged.path());
            scanPackage(staged.path());
            var rows = parseOoxml(staged.path(), definition);
            return new ParsedWorkbook(
                definition.type(),
                TEMPLATE_VERSION,
                staged.sizeBytes(),
                staged.sha256(),
                rows
            );
        } catch (ResponseStatusException error) {
            throw error;
        } catch (IOException | OpenXML4JException | SAXException | RuntimeException error) {
            if (isZipBomb(error)) {
                throw payloadTooLarge("Excel 解压内容超出安全上限");
            }
            throw badRequest("无法解析 Excel 文件，文件可能已损坏或格式不正确");
        } finally {
            if (staged != null) {
                try {
                    Files.deleteIfExists(staged.path());
                } catch (IOException ignored) {
                    // Best-effort cleanup; no path is surfaced to the client.
                }
            }
        }
    }

    /** Convenience overload used by application services that only have a type key. */
    public ParsedWorkbook parse(String type, String originalFilename, long declaredSize, InputStream source) {
        return parse(definitions.require(type), originalFilename, declaredSize, source);
    }

    /**
     * Creates a formula-free .xlsx receipt. The supplied list may combine parser and live database validation errors.
     */
    public byte[] createErrorReceipt(String type, List<ReceiptError> errors) {
        var definition = definitions.require(type);
        var stableErrors = errors == null
            ? List.<ReceiptError>of()
            : errors.stream()
                .filter(Objects::nonNull)
                .sorted(Comparator.comparingInt(ReceiptError::rowNo))
                .toList();

        var workbook = new SXSSFWorkbook(null, 100, true, true);
        try (workbook; var output = new ByteArrayOutputStream()) {
            var sheet = workbook.createSheet("错误回执");
            sheet.createFreezePane(0, 2);
            sheet.setAutoFilter(new CellRangeAddress(1, 1, 0, 5));
            sheet.setColumnWidth(0, 12 * 256);
            sheet.setColumnWidth(1, 24 * 256);
            sheet.setColumnWidth(2, 20 * 256);
            sheet.setColumnWidth(3, 24 * 256);
            sheet.setColumnWidth(4, 48 * 256);
            sheet.setColumnWidth(5, 32 * 256);

            var titleStyle = titleStyle(workbook);
            var headerStyle = headerStyle(workbook);
            var textStyle = textStyle(workbook);

            var titleRow = sheet.createRow(0);
            titleRow.setHeightInPoints(28);
            var titleCell = titleRow.createCell(0);
            titleCell.setCellValue(definition.title() + " Excel 导入错误回执");
            titleCell.setCellStyle(titleStyle);
            sheet.addMergedRegion(new CellRangeAddress(0, 0, 0, 5));

            var header = sheet.createRow(1);
            var headers = List.of("行号", "业务编码", "字段", "错误码", "错误信息", "原值");
            for (int column = 0; column < headers.size(); column++) {
                var cell = header.createCell(column);
                cell.setCellValue(headers.get(column));
                cell.setCellStyle(headerStyle);
            }

            var rowIndex = 2;
            for (var error : stableErrors) {
                var row = sheet.createRow(rowIndex++);
                row.createCell(0).setCellValue(error.rowNo());
                setTextCell(row, 1, error.businessCode(), textStyle);
                setTextCell(row, 2, error.field(), textStyle);
                setTextCell(row, 3, error.code(), textStyle);
                setTextCell(row, 4, error.message(), textStyle);
                setTextCell(row, 5, error.value(), textStyle);
            }
            workbook.write(output);
            return output.toByteArray();
        } catch (IOException error) {
            throw new IllegalStateException("生成 Excel 错误回执失败", error);
        } finally {
            workbook.dispose();
        }
    }

    private List<ParsedRow> parseOoxml(
        Path path,
        MasterDataImportDefinitionRegistry.ImportDefinition definition
    ) throws IOException, OpenXML4JException, SAXException {
        try (var pkg = OPCPackage.open(path.toFile(), PackageAccess.READ)) {
            var reader = new XSSFReader(pkg, true);
            var workbookSheets = readWorkbookSheets(reader);
            validateWorkbookSheets(workbookSheets);

            Styles styles = reader.getStylesTable();
            SharedStrings sharedStrings = reader.getSharedStringsTable();
            var formatter = new DataFormatter(Locale.ROOT, false, false);
            var iterator = reader.getSheetIterator();
            DataSheetHandler dataHandler = null;
            MetaSheetHandler metaHandler = null;
            var parsedNames = new LinkedHashSet<String>();

            while (iterator.hasNext()) {
                try (var sheetInput = iterator.next()) {
                    var sheetName = iterator.getSheetName();
                    if (!REQUIRED_SHEETS.contains(sheetName) || !parsedNames.add(sheetName)) {
                        throw badRequest("工作簿只允许导入数据、填写说明和 __meta 三个固定 sheet");
                    }
                    BaseSheetHandler handler;
                    if (DATA_SHEET.equals(sheetName)) {
                        dataHandler = new DataSheetHandler(definition);
                        handler = dataHandler;
                    } else if (META_SHEET.equals(sheetName)) {
                        metaHandler = new MetaSheetHandler();
                        handler = metaHandler;
                    } else {
                        handler = new DiscardingSheetHandler();
                    }
                    var protectedSheet = parseSheet(sheetInput, styles, sharedStrings, formatter, handler);
                    if (META_SHEET.equals(sheetName) && !protectedSheet) {
                        throw badRequest("__meta sheet 必须受保护");
                    }
                }
            }
            if (!parsedNames.equals(REQUIRED_SHEETS) || dataHandler == null || metaHandler == null) {
                throw badRequest("工作簿 sheet 结构不完整");
            }
            dataHandler.validateHeaders();
            metaHandler.validate(definition);
            return addDuplicateCodeErrors(dataHandler.rows());
        }
    }

    private boolean parseSheet(
        InputStream input,
        Styles styles,
        SharedStrings sharedStrings,
        DataFormatter formatter,
        BaseSheetHandler handler
    ) throws IOException, SAXException {
        XMLReader parser = newXmlReader();
        var guard = new FormulaAndProtectionGuard(parser);
        guard.setContentHandler(new XSSFSheetXMLHandler(styles, sharedStrings, handler, formatter, false));
        guard.parse(new InputSource(new BufferedInputStream(input)));
        return guard.protectedSheet();
    }

    private List<WorkbookSheet> readWorkbookSheets(XSSFReader reader)
        throws IOException, InvalidFormatException, SAXException {
        var handler = new WorkbookSheetHandler();
        try (var input = reader.getWorkbookData()) {
            XMLReader parser = newXmlReader();
            parser.setContentHandler(handler);
            parser.parse(new InputSource(new BufferedInputStream(input)));
        }
        return handler.sheets();
    }

    private void validateWorkbookSheets(List<WorkbookSheet> sheets) {
        var names = new LinkedHashSet<String>();
        for (var sheet : sheets) {
            if (!names.add(sheet.name())) {
                throw badRequest("工作簿包含重复 sheet");
            }
            if (META_SHEET.equals(sheet.name()) && !"veryHidden".equals(sheet.state())) {
                throw badRequest("__meta sheet 必须隐藏");
            }
        }
        if (sheets.size() != REQUIRED_SHEETS.size() || !names.equals(REQUIRED_SHEETS)) {
            throw badRequest("工作簿只允许导入数据、填写说明和 __meta 三个固定 sheet");
        }
    }

    private List<ParsedRow> addDuplicateCodeErrors(List<ParsedRow> sourceRows) {
        var codeRows = new LinkedHashMap<String, List<Integer>>();
        for (int index = 0; index < sourceRows.size(); index++) {
            var code = normalized(sourceRows.get(index).payload().get("code"));
            if (!code.isBlank()) {
                codeRows.computeIfAbsent(code, ignored -> new ArrayList<>()).add(index);
            }
        }
        var duplicateIndexes = new HashSet<Integer>();
        codeRows.values().stream()
            .filter(indexes -> indexes.size() > 1)
            .forEach(duplicateIndexes::addAll);
        if (duplicateIndexes.isEmpty()) {
            return sourceRows;
        }
        var result = new ArrayList<ParsedRow>(sourceRows.size());
        for (int index = 0; index < sourceRows.size(); index++) {
            var row = sourceRows.get(index);
            if (!duplicateIndexes.contains(index)) {
                result.add(row);
                continue;
            }
            var errors = new ArrayList<>(row.errors());
            errors.add(new RowError(
                row.rowNo(),
                "code",
                "DUPLICATE_FILE_CODE",
                "编码在当前工作簿内重复",
                row.payload().get("code")
            ));
            result.add(new ParsedRow(row.rowNo(), row.payload(), errors));
        }
        return List.copyOf(result);
    }

    private StagedFile stage(InputStream source) throws IOException {
        var path = Files.createTempFile("jdy-a143-import-", ".xlsx");
        var digest = sha256Digest();
        long total = 0;
        try (OutputStream output = Files.newOutputStream(path)) {
            var buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = source.read(buffer)) != -1) {
                total += read;
                if (total > MAX_FILE_BYTES) {
                    throw payloadTooLarge("Excel 文件不能超过 10 MiB");
                }
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
            }
        } catch (RuntimeException | IOException error) {
            Files.deleteIfExists(path);
            throw error;
        }
        if (total == 0) {
            Files.deleteIfExists(path);
            throw badRequest("Excel 文件不能为空");
        }
        return new StagedFile(path, total, toHex(digest.digest()));
    }

    private void validateZipSignature(Path path) throws IOException {
        try (var input = Files.newInputStream(path)) {
            var signature = input.readNBytes(4);
            if (signature.length != 4
                || signature[0] != 'P'
                || signature[1] != 'K'
                || signature[2] != 3
                || signature[3] != 4) {
                throw badRequest("文件不是有效的 .xlsx OOXML 工作簿");
            }
        }
    }

    private void scanPackage(Path path) throws IOException, SAXException {
        var names = new HashSet<String>();
        var controlParts = new LinkedHashMap<String, byte[]>();
        long expanded = 0;

        try (var zip = new ZipSecureFile(path.toFile())) {
            Enumeration<ZipArchiveEntry> entries = zip.getEntries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                var name = entry.getName();
                validateEntryName(name);
                if (!names.add(name)) {
                    throw badRequest("工作簿 ZIP 包含重复部件");
                }
                var lowerName = name.toLowerCase(Locale.ROOT);
                if (lowerName.endsWith("vbaproject.bin")
                    || lowerName.endsWith("encryptedpackage")
                    || lowerName.endsWith("encryptioninfo")
                    || lowerName.startsWith("xl/externallinks/")) {
                    throw badRequest("工作簿不允许宏或外部链接");
                }
                if (entry.isDirectory()) {
                    continue;
                }
                var collect = "[Content_Types].xml".equals(name) || lowerName.endsWith(".rels");
                ByteArrayOutputStream captured = collect ? new ByteArrayOutputStream() : null;
                try (var input = zip.getInputStream(entry)) {
                    var buffer = new byte[BUFFER_SIZE];
                    int read;
                    long entryExpanded = 0;
                    while ((read = input.read(buffer)) != -1) {
                        entryExpanded += read;
                        expanded += read;
                        if (expanded > MAX_EXPANDED_BYTES) {
                            throw payloadTooLarge("Excel 解压内容不能超过 50 MiB");
                        }
                        if (captured != null) {
                            if (entryExpanded > MAX_XML_CONTROL_PART_BYTES) {
                                throw badRequest("Excel OOXML 控制部件过大");
                            }
                            captured.write(buffer, 0, read);
                        }
                    }
                }
                if (captured != null) {
                    controlParts.put(name, captured.toByteArray());
                }
            }
        }

        if (!names.containsAll(REQUIRED_PACKAGE_PARTS)) {
            throw badRequest("Excel OOXML 工作簿结构不完整");
        }
        validateContentTypes(controlParts.get("[Content_Types].xml"));
        for (var entry : controlParts.entrySet()) {
            if (entry.getKey().toLowerCase(Locale.ROOT).endsWith(".rels")) {
                validateRelationships(entry.getValue());
            }
        }
    }

    private void validateContentTypes(byte[] xml) throws IOException, SAXException {
        if (xml == null) {
            throw badRequest("Excel OOXML 缺少内容类型定义");
        }
        var handler = new ContentTypesHandler();
        parseControlXml(xml, handler);
        if (!WORKBOOK_CONTENT_TYPE.equals(handler.effectiveWorkbookContentType()) || handler.hasMacroContent()) {
            throw badRequest("只允许无宏 .xlsx 工作簿");
        }
    }

    private void validateRelationships(byte[] xml) throws IOException, SAXException {
        var handler = new RelationshipHandler();
        parseControlXml(xml, handler);
        if (handler.external()) {
            throw badRequest("工作簿不允许外部链接");
        }
    }

    private void parseControlXml(byte[] xml, DefaultHandler handler) throws IOException, SAXException {
        XMLReader parser = newXmlReader();
        parser.setContentHandler(handler);
        parser.parse(new InputSource(new ByteArrayInputStream(xml)));
    }

    private static XMLReader newXmlReader() throws SAXException {
        try {
            return XMLHelper.newXMLReader();
        } catch (javax.xml.parsers.ParserConfigurationException error) {
            throw new SAXException("Unable to configure secure XML parser", error);
        }
    }

    private void validateEntryName(String name) {
        if (name == null
            || name.isBlank()
            || name.startsWith("/")
            || name.startsWith("\\")
            || name.contains("\\")
            || List.of(name.split("/", -1)).contains("..")) {
            throw badRequest("Excel OOXML 包含非法部件路径");
        }
    }

    private void validateFilename(String originalFilename) {
        var filename = originalFilename == null ? "" : originalFilename.strip();
        if (filename.isBlank() || !filename.toLowerCase(Locale.ROOT).endsWith(".xlsx")) {
            throw badRequest("只允许上传 .xlsx 文件");
        }
    }

    private static CellStyle titleStyle(SXSSFWorkbook workbook) {
        var style = workbook.createCellStyle();
        style.setFillForegroundColor(IndexedColors.DARK_BLUE.getIndex());
        style.setFillPattern(FillPatternType.SOLID_FOREGROUND);
        style.setAlignment(HorizontalAlignment.LEFT);
        var font = workbook.createFont();
        font.setBold(true);
        font.setColor(IndexedColors.WHITE.getIndex());
        font.setFontHeightInPoints((short) 14);
        style.setFont(font);
        return style;
    }

    private static CellStyle headerStyle(SXSSFWorkbook workbook) {
        var style = workbook.createCellStyle();
        style.setFillForegroundColor(IndexedColors.LIGHT_CORNFLOWER_BLUE.getIndex());
        style.setFillPattern(FillPatternType.SOLID_FOREGROUND);
        var font = workbook.createFont();
        font.setBold(true);
        style.setFont(font);
        return style;
    }

    private static CellStyle textStyle(SXSSFWorkbook workbook) {
        var style = workbook.createCellStyle();
        style.setDataFormat(workbook.createDataFormat().getFormat("@"));
        return style;
    }

    private static void setTextCell(org.apache.poi.ss.usermodel.Row row, int column, String value, CellStyle style) {
        var cell = row.createCell(column);
        cell.setCellStyle(style);
        cell.setCellValue(value == null ? "" : value);
    }

    private static MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static String toHex(byte[] bytes) {
        var result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(Character.forDigit((value >>> 4) & 0x0f, 16));
            result.append(Character.forDigit(value & 0x0f, 16));
        }
        return result.toString();
    }

    private static boolean isZipBomb(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            var message = current.getMessage();
            if (message != null && message.toLowerCase(Locale.ROOT).contains("zip bomb")) {
                return true;
            }
        }
        return false;
    }

    private static ResponseStatusException badRequest(String reason) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, reason);
    }

    private static ResponseStatusException payloadTooLarge(String reason) {
        return new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, reason);
    }

    private static String xmlName(String localName, String qName) {
        if (localName != null && !localName.isBlank()) {
            return localName;
        }
        var separator = qName == null ? -1 : qName.indexOf(':');
        return separator >= 0 ? qName.substring(separator + 1) : qName;
    }

    private static String attribute(Attributes attributes, String name) {
        var direct = attributes.getValue(name);
        if (direct != null) {
            return direct;
        }
        for (int index = 0; index < attributes.getLength(); index++) {
            if (name.equals(xmlName(attributes.getLocalName(index), attributes.getQName(index)))) {
                return attributes.getValue(index);
            }
        }
        return null;
    }

    private static String normalized(String value) {
        if (value == null || value.isEmpty()) {
            return "";
        }
        int start = 0;
        int end = value.length();
        while (start < end) {
            int codePoint = value.codePointAt(start);
            if (!Character.isWhitespace(codePoint) && !Character.isSpaceChar(codePoint)) {
                break;
            }
            start += Character.charCount(codePoint);
        }
        while (end > start) {
            int codePoint = value.codePointBefore(end);
            if (!Character.isWhitespace(codePoint) && !Character.isSpaceChar(codePoint)) {
                break;
            }
            end -= Character.charCount(codePoint);
        }
        return value.substring(start, end);
    }

    private static String limitedErrorValue(String value) {
        if (value == null) {
            return null;
        }
        if (value.length() <= MAX_ERROR_VALUE_CHARACTERS) {
            return value;
        }
        return value.substring(0, MAX_ERROR_VALUE_CHARACTERS - 1) + "…";
    }

    private static String safeRecordText(String value, String fallback) {
        var normalized = normalized(value);
        return normalized.isBlank() ? fallback : normalized;
    }

    public record ParsedWorkbook(
        String type,
        int templateVersion,
        long fileSizeBytes,
        String sha256,
        List<ParsedRow> rows
    ) {
        public ParsedWorkbook {
            type = safeRecordText(type, "unknown");
            sha256 = safeRecordText(sha256, "unknown");
            rows = rows == null ? List.of() : List.copyOf(rows);
        }
    }

    public record ParsedRow(int rowNo, Map<String, String> payload, List<RowError> errors) {
        public ParsedRow {
            if (rowNo < 1) {
                throw new IllegalArgumentException("rowNo must be positive");
            }
            payload = payload == null
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(payload));
            errors = errors == null ? List.of() : List.copyOf(errors);
        }
    }

    public record RowError(int rowNo, String field, String code, String message, String value) {
        public RowError {
            if (rowNo < 1) {
                throw new IllegalArgumentException("rowNo must be positive");
            }
            field = safeRecordText(field, "workbook");
            code = safeRecordText(code, "INVALID_VALUE");
            message = safeRecordText(message, "数据不符合导入规则");
            value = limitedErrorValue(value);
        }
    }

    public record ReceiptError(
        int rowNo,
        String businessCode,
        String field,
        String code,
        String message,
        String value
    ) {
        public ReceiptError {
            if (rowNo < 1) {
                throw new IllegalArgumentException("rowNo must be positive");
            }
            businessCode = limitedErrorValue(normalized(businessCode));
            field = safeRecordText(field, "workbook");
            code = safeRecordText(code, "INVALID_VALUE");
            message = safeRecordText(message, "数据不符合导入规则");
            value = limitedErrorValue(value);
        }

        public static ReceiptError from(ParsedRow row, RowError error) {
            Objects.requireNonNull(row, "row");
            Objects.requireNonNull(error, "error");
            return new ReceiptError(
                error.rowNo(),
                row.payload().get("code"),
                error.field(),
                error.code(),
                error.message(),
                error.value()
            );
        }
    }

    private record StagedFile(Path path, long sizeBytes, String sha256) {
    }

    private record WorkbookSheet(String name, String state) {
    }

    private static final class WorkbookSheetHandler extends DefaultHandler {
        private final List<WorkbookSheet> sheets = new ArrayList<>();

        @Override
        public void startElement(String uri, String localName, String qName, Attributes attributes) {
            if ("sheet".equals(xmlName(localName, qName))) {
                sheets.add(new WorkbookSheet(attribute(attributes, "name"), attribute(attributes, "state")));
            }
        }

        private List<WorkbookSheet> sheets() {
            return List.copyOf(sheets);
        }
    }

    private static final class ContentTypesHandler extends DefaultHandler {
        private String workbookContentType;
        private String defaultXmlContentType;
        private boolean macroContent;

        @Override
        public void startElement(String uri, String localName, String qName, Attributes attributes) {
            var contentType = attribute(attributes, "ContentType");
            if (contentType != null) {
                var normalizedContentType = contentType.toLowerCase(Locale.ROOT);
                if (normalizedContentType.contains("macro") || normalizedContentType.contains("vba")) {
                    macroContent = true;
                }
            }
            if ("Override".equals(xmlName(localName, qName))
                && "/xl/workbook.xml".equals(attribute(attributes, "PartName"))) {
                workbookContentType = contentType;
            }
            if ("Default".equals(xmlName(localName, qName))
                && "xml".equalsIgnoreCase(attribute(attributes, "Extension"))) {
                defaultXmlContentType = contentType;
            }
        }

        private String effectiveWorkbookContentType() {
            return workbookContentType == null ? defaultXmlContentType : workbookContentType;
        }

        private boolean hasMacroContent() {
            return macroContent;
        }
    }

    private static final class RelationshipHandler extends DefaultHandler {
        private boolean external;

        @Override
        public void startElement(String uri, String localName, String qName, Attributes attributes) {
            if ("Relationship".equals(xmlName(localName, qName))
                && "External".equalsIgnoreCase(attribute(attributes, "TargetMode"))) {
                external = true;
            }
        }

        private boolean external() {
            return external;
        }
    }

    private static final class FormulaAndProtectionGuard extends XMLFilterImpl {
        private boolean protectedSheet;

        private FormulaAndProtectionGuard(XMLReader parent) {
            super(parent);
        }

        @Override
        public void startElement(String uri, String localName, String qName, Attributes attributes)
            throws SAXException {
            var name = xmlName(localName, qName);
            if ("f".equals(name)) {
                throw new SAXException("工作簿不允许公式");
            }
            if ("sheetProtection".equals(name)) {
                protectedSheet = "1".equals(attribute(attributes, "sheet"))
                    || "true".equalsIgnoreCase(attribute(attributes, "sheet"));
            }
            super.startElement(uri, localName, qName, attributes);
        }

        private boolean protectedSheet() {
            return protectedSheet;
        }
    }

    private abstract static class BaseSheetHandler implements XSSFSheetXMLHandler.SheetContentsHandler {
        private int currentRow = -1;
        private Map<Integer, String> currentCells = Map.of();

        @Override
        public final void startRow(int rowNum) {
            currentRow = rowNum;
            currentCells = new TreeMap<>();
        }

        @Override
        public final void cell(String cellReference, String formattedValue, XSSFComment comment) {
            if (cellReference == null || cellReference.isBlank()) {
                throw badRequest("Excel 单元格引用不正确");
            }
            final int column;
            try {
                column = new CellReference(cellReference).getCol();
            } catch (RuntimeException error) {
                throw badRequest("Excel 单元格引用不正确");
            }
            if (column >= MAX_COLUMNS) {
                throw badRequest("Excel 工作簿不能超过 64 列");
            }
            var value = formattedValue == null ? "" : formattedValue;
            if (value.indexOf('\u0000') >= 0) {
                throw badRequest("Excel 单元格包含不支持的空字符");
            }
            if (value.length() > MAX_CELL_CHARACTERS) {
                throw badRequest("Excel 单元格不能超过 32,767 个字符");
            }
            currentCells.put(column, value);
        }

        @Override
        public final void endRow(int rowNum) {
            if (rowNum != currentRow) {
                throw badRequest("Excel 行结构不正确");
            }
            acceptRow(rowNum, currentCells);
            currentCells = Map.of();
        }

        protected abstract void acceptRow(int zeroBasedRow, Map<Integer, String> cells);
    }

    private static final class DiscardingSheetHandler extends BaseSheetHandler {
        @Override
        protected void acceptRow(int zeroBasedRow, Map<Integer, String> cells) {
            // The guide is intentionally not retained; BaseSheetHandler still enforces cell/column limits.
        }
    }

    private static final class MetaSheetHandler extends BaseSheetHandler {
        private final Map<Integer, Map<Integer, String>> rows = new TreeMap<>();

        @Override
        protected void acceptRow(int zeroBasedRow, Map<Integer, String> cells) {
            var nonBlank = new TreeMap<Integer, String>();
            cells.forEach((column, value) -> {
                var normalized = normalized(value);
                if (!normalized.isBlank()) {
                    nonBlank.put(column, normalized);
                }
            });
            if (!nonBlank.isEmpty()) {
                rows.put(zeroBasedRow, Collections.unmodifiableMap(nonBlank));
            }
        }

        private void validate(MasterDataImportDefinitionRegistry.ImportDefinition definition) {
            var expected = List.of(
                List.of("key", "value"),
                List.of("contract", "A143"),
                List.of("type", definition.type()),
                List.of("version", String.valueOf(TEMPLATE_VERSION)),
                List.of("dataSheet", DATA_SHEET),
                List.of("headerRow", "2"),
                List.of("maxDataRows", String.valueOf(MAX_DATA_ROWS))
            );
            if (rows.size() != expected.size()) {
                throw badRequest("__meta 元数据不匹配");
            }
            for (int row = 0; row < expected.size(); row++) {
                var actual = rows.get(row);
                if (actual == null
                    || actual.size() != 2
                    || !expected.get(row).get(0).equals(actual.get(0))
                    || !expected.get(row).get(1).equals(actual.get(1))) {
                    throw badRequest("__meta 元数据不匹配");
                }
            }
        }
    }

    private static final class DataSheetHandler extends BaseSheetHandler {
        private final MasterDataImportDefinitionRegistry.ImportDefinition definition;
        private final List<ParsedRow> rows = new ArrayList<>();
        private Map<Integer, String> headerCells = Map.of();

        private DataSheetHandler(MasterDataImportDefinitionRegistry.ImportDefinition definition) {
            this.definition = definition;
        }

        @Override
        protected void acceptRow(int zeroBasedRow, Map<Integer, String> cells) {
            if (zeroBasedRow == 1) {
                headerCells = Map.copyOf(cells);
                return;
            }
            if (zeroBasedRow < 2 || cells.values().stream().map(MasterDataImportWorkbookService::normalized).allMatch(String::isBlank)) {
                return;
            }
            if (rows.size() >= MAX_DATA_ROWS) {
                throw payloadTooLarge("Excel 非空数据行不能超过 5,000 行");
            }
            cells.entrySet().stream()
                .filter(entry -> entry.getKey() >= definition.fields().size())
                .filter(entry -> !normalized(entry.getValue()).isBlank())
                .findFirst()
                .ifPresent(entry -> {
                    throw badRequest("数据行包含未定义列");
                });

            var rowNo = zeroBasedRow + 1;
            var payload = new LinkedHashMap<String, String>();
            var errors = new ArrayList<RowError>();
            for (int column = 0; column < definition.fields().size(); column++) {
                var field = definition.fields().get(column);
                var raw = normalized(cells.get(column));
                if (raw.isBlank()) {
                    raw = field.defaultValue();
                }
                if (raw == null || raw.isBlank()) {
                    if (field.required()) {
                        errors.add(new RowError(rowNo, field.key(), "REQUIRED", field.header() + "为必填项", null));
                    }
                    continue;
                }
                var normalizedField = normalizeField(rowNo, field, raw, errors);
                payload.put(field.key(), normalizedField);
            }
            definition.hiddenDefaults().forEach(payload::putIfAbsent);
            rows.add(new ParsedRow(rowNo, payload, errors));
        }

        private void validateHeaders() {
            var expected = definition.headers();
            var actual = new ArrayList<String>(expected.size());
            for (int column = 0; column < expected.size(); column++) {
                actual.add(normalized(headerCells.get(column)));
            }
            var extra = headerCells.entrySet().stream()
                .filter(entry -> entry.getKey() >= expected.size())
                .map(Map.Entry::getValue)
                .map(MasterDataImportWorkbookService::normalized)
                .filter(value -> !value.isBlank())
                .findFirst();
            if (extra.isPresent() || !actual.equals(expected)) {
                var nonBlank = actual.stream().filter(value -> !value.isBlank()).toList();
                if (new HashSet<>(nonBlank).size() != nonBlank.size()) {
                    throw badRequest("Excel 表头包含重复列");
                }
                var expectedSet = new HashSet<>(expected);
                if (extra.isPresent() || nonBlank.stream().anyMatch(value -> !expectedSet.contains(value))) {
                    throw badRequest("Excel 表头包含未知列");
                }
                throw badRequest("Excel 表头缺失或顺序不匹配");
            }
        }

        private List<ParsedRow> rows() {
            return List.copyOf(rows);
        }

        private static String normalizeField(
            int rowNo,
            MasterDataImportDefinitionRegistry.FieldDefinition field,
            String value,
            List<RowError> errors
        ) {
            return switch (field.kind()) {
                case TEXT -> normalizeText(rowNo, field, value, errors);
                case INTEGER -> normalizeInteger(rowNo, field, value, errors);
                case DECIMAL -> normalizeDecimal(rowNo, field, value, errors);
                case BOOLEAN -> normalizeBoolean(rowNo, field, value, errors);
                case ENUM -> normalizeEnum(rowNo, field, value, errors);
            };
        }

        private static String normalizeText(
            int rowNo,
            MasterDataImportDefinitionRegistry.FieldDefinition field,
            String value,
            List<RowError> errors
        ) {
            if (field.maxLength() > 0 && value.length() > field.maxLength()) {
                errors.add(new RowError(
                    rowNo,
                    field.key(),
                    "TOO_LONG",
                    field.header() + "不能超过 " + field.maxLength() + " 个字符",
                    value
                ));
            }
            return value;
        }

        private static String normalizeInteger(
            int rowNo,
            MasterDataImportDefinitionRegistry.FieldDefinition field,
            String value,
            List<RowError> errors
        ) {
            if (NEGATIVE_INTEGER.matcher(value).matches()) {
                errors.add(new RowError(rowNo, field.key(), "OUT_OF_RANGE", field.header() + "不能为负数", value));
                return value;
            }
            if (!ORDINARY_INTEGER.matcher(value).matches()) {
                errors.add(new RowError(rowNo, field.key(), "TYPE_ERROR", field.header() + "必须为非负整数", value));
                return value;
            }
            try {
                var integer = new BigInteger(value);
                if (integer.toString().length() > field.precision() || integer.compareTo(BigInteger.valueOf(Integer.MAX_VALUE)) > 0) {
                    errors.add(new RowError(rowNo, field.key(), "OUT_OF_RANGE", field.header() + "超出可用范围", value));
                }
                return integer.toString();
            } catch (NumberFormatException error) {
                errors.add(new RowError(rowNo, field.key(), "TYPE_ERROR", field.header() + "必须为非负整数", value));
                return value;
            }
        }

        private static String normalizeDecimal(
            int rowNo,
            MasterDataImportDefinitionRegistry.FieldDefinition field,
            String value,
            List<RowError> errors
        ) {
            if (NEGATIVE_DECIMAL.matcher(value).matches()) {
                errors.add(new RowError(rowNo, field.key(), "OUT_OF_RANGE", field.header() + "不能为负数", value));
                return value;
            }
            if (!ORDINARY_DECIMAL.matcher(value).matches()) {
                errors.add(new RowError(rowNo, field.key(), "TYPE_ERROR", field.header() + "必须为普通非负十进制数", value));
                return value;
            }
            try {
                var decimal = new BigDecimal(value);
                var integerDigits = Math.max(0, decimal.precision() - decimal.scale());
                if (decimal.precision() > field.precision()
                    || decimal.scale() > field.scale()
                    || integerDigits > field.precision() - field.scale()) {
                    errors.add(new RowError(
                        rowNo,
                        field.key(),
                        "OUT_OF_RANGE",
                        field.header() + "最多 " + field.precision() + " 位数字、" + field.scale() + " 位小数",
                        value
                    ));
                }
                var stripped = decimal.stripTrailingZeros();
                return stripped.signum() == 0 ? "0" : stripped.toPlainString();
            } catch (NumberFormatException error) {
                errors.add(new RowError(rowNo, field.key(), "TYPE_ERROR", field.header() + "必须为普通非负十进制数", value));
                return value;
            }
        }

        private static String normalizeBoolean(
            int rowNo,
            MasterDataImportDefinitionRegistry.FieldDefinition field,
            String value,
            List<RowError> errors
        ) {
            return switch (value) {
                case "是", "true" -> "true";
                case "否", "false" -> "false";
                default -> {
                    errors.add(new RowError(
                        rowNo,
                        field.key(),
                        "INVALID_BOOLEAN",
                        field.header() + "只允许 是/否/true/false",
                        value
                    ));
                    yield value;
                }
            };
        }

        private static String normalizeEnum(
            int rowNo,
            MasterDataImportDefinitionRegistry.FieldDefinition field,
            String value,
            List<RowError> errors
        ) {
            if (!field.allowedValues().contains(value)) {
                errors.add(new RowError(
                    rowNo,
                    field.key(),
                    "INVALID_ENUM",
                    field.header() + "不在允许值范围内",
                    value
                ));
            }
            return value;
        }
    }
}
