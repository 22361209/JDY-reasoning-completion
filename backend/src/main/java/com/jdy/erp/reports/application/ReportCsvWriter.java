package com.jdy.erp.reports.application;

import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.temporal.TemporalAccessor;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public final class ReportCsvWriter {
    static final int MAX_CELL_CHARACTERS = 32_767;
    static final int MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

    public Buffer open(ReportQuerySpec spec, OutputStream destination) {
        return new Buffer(spec, destination);
    }

    public static final class Buffer {
        private final ReportQuerySpec spec;
        private final BoundedOutputStream output;
        private final OutputStreamWriter writer;
        private boolean finished;

        private Buffer(ReportQuerySpec spec, OutputStream destination) {
            this.spec = spec;
            this.output = new BoundedOutputStream(destination, MAX_OUTPUT_BYTES);
            this.writer = new OutputStreamWriter(output, StandardCharsets.UTF_8);
            try {
                writer.write('\ufeff');
                for (int index = 0; index < spec.csvColumns().size(); index++) {
                    if (index > 0) {
                        writer.write(',');
                    }
                    writeCell(spec.csvColumns().get(index).title(), false, false);
                }
                writer.write("\r\n");
            } catch (IOException exception) {
                throw new UncheckedIOException(exception);
            }
        }

        public void writeRow(ResultSet resultSet) throws SQLException {
            requireOpen();
            try {
                for (int index = 0; index < spec.csvColumns().size(); index++) {
                    if (index > 0) {
                        writer.write(',');
                    }
                    var column = spec.csvColumns().get(index);
                    var value = resultSet.getObject(column.sourceColumn());
                    writeCell(csvValue(value), column.forceText(), isNumericValue(value));
                }
                writer.write("\r\n");
            } catch (IOException exception) {
                throw new UncheckedIOException(exception);
            }
        }

        public long finish() {
            requireOpen();
            finished = true;
            try {
                writer.flush();
            } catch (IOException exception) {
                throw new UncheckedIOException(exception);
            }
            return output.bytesWritten();
        }

        private void writeCell(String rawValue, boolean forceText, boolean numericValue) throws IOException {
            var value = rawValue == null ? "" : rawValue;
            if (value.length() > MAX_CELL_CHARACTERS) {
                throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "报表引出单元格超过长度限制");
            }
            var neutralizeFormula = !numericValue && startsFormula(value);
            if (forceText && !value.isEmpty()) {
                value = "\t" + value;
            }
            if (neutralizeFormula) {
                // Keep the apostrophe as the actual first character. Prefixing a force-text
                // tab afterwards could let spreadsheet clients trim the tab and reinterpret
                // the remaining text as a formula.
                value = "'" + value;
            }
            var quote = forceText
                || value.indexOf(',') >= 0
                || value.indexOf('"') >= 0
                || value.indexOf('\r') >= 0
                || value.indexOf('\n') >= 0
                || containsControlCharacter(value);
            if (quote) {
                writer.write('"');
                writer.write(value.replace("\"", "\"\""));
                writer.write('"');
            } else {
                writer.write(value);
            }
        }

        private boolean startsFormula(String value) {
            if (value.isEmpty()) {
                return false;
            }
            var offset = 0;
            while (offset < value.length()
                && Character.isWhitespace(value.charAt(offset))
                && value.charAt(offset) != '\t'
                && value.charAt(offset) != '\r') {
                offset++;
            }
            if (offset == value.length()) {
                return false;
            }
            var first = value.charAt(offset);
            if (first == '=' || first == '+' || first == '@' || first == '\t' || first == '\r') {
                return true;
            }
            return first == '-';
        }

        private boolean containsControlCharacter(String value) {
            return value.codePoints().anyMatch(Character::isISOControl);
        }

        private String csvValue(Object value) {
            if (value == null) {
                return "";
            }
            if (value instanceof BigDecimal decimal) {
                return decimal.toPlainString();
            }
            if (value instanceof TemporalAccessor) {
                return value.toString();
            }
            return String.valueOf(value);
        }

        private boolean isNumericValue(Object value) {
            return value instanceof Number;
        }

        private void requireOpen() {
            if (finished) {
                throw new IllegalStateException("CSV buffer is already finished");
            }
        }
    }

    private static final class BoundedOutputStream extends OutputStream {
        private final OutputStream delegate;
        private final int maximumBytes;
        private long bytesWritten;

        private BoundedOutputStream(OutputStream delegate, int maximumBytes) {
            this.delegate = java.util.Objects.requireNonNull(delegate, "CSV destination must not be null");
            this.maximumBytes = maximumBytes;
        }

        @Override
        public void write(int value) throws IOException {
            requireCapacity(1);
            delegate.write(value);
            bytesWritten++;
        }

        @Override
        public void write(byte[] bytes, int offset, int length) throws IOException {
            requireCapacity(length);
            delegate.write(bytes, offset, length);
            bytesWritten += length;
        }

        private void requireCapacity(int additionalBytes) {
            if (additionalBytes < 0 || bytesWritten > maximumBytes - additionalBytes) {
                throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "报表引出文件超过 64 MiB");
            }
        }

        private long bytesWritten() {
            return bytesWritten;
        }
    }
}
