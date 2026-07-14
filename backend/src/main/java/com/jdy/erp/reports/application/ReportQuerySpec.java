package com.jdy.erp.reports.application;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Trusted, code-owned SQL definition for one report key.
 *
 * <p>The source SQL is fixed by a business-domain bean. Every client-selectable
 * filter, sort and export column is represented by a validated output-column
 * alias, so request data can never become a table, schema, column or SQL
 * direction.</p>
 */
public final class ReportQuerySpec {
    private static final Pattern REPORT_KEY = Pattern.compile("[a-z][a-z0-9-]{1,63}");
    private static final Pattern PERMISSION = Pattern.compile("[a-z][a-z0-9_.-]{1,119}");
    private static final Pattern PARAMETER = Pattern.compile("[a-z][A-Za-z0-9]{0,63}");
    private static final Pattern DATA_SCOPE_NAMESPACE = Pattern.compile("[a-z][a-z0-9_-]{0,63}");
    private static final Pattern COLUMN = Pattern.compile("[A-Za-z_][A-Za-z0-9_]{0,62}");
    private static final Set<String> FROM_CLAUSE_TERMINATORS = Set.of(
        "where", "group", "having", "window", "order", "limit", "offset", "fetch",
        "for", "union", "intersect", "except", "returning"
    );
    private static final Set<String> FORBIDDEN_SQL_KEYWORDS = Set.of(
        "insert", "update", "delete", "merge", "copy", "call", "do", "create", "alter",
        "drop", "truncate", "grant", "revoke", "into"
    );
    private static final Set<String> RESERVED_PARAMETERS = Set.of(
        "dateFrom", "dateTo", "page", "pageSize", "sortField", "sortOrder", "keyword",
        "scope", "scopeId", "dataScope", "dataScopeId", "schema",
        "accountSetId", "accountSet", "tenantId", "tenant"
    );

    private final String reportKey;
    private final String requiredPermission;
    private final String sourceSql;
    private final List<SourceParameterBinding> sourceParameters;
    private final String resultSql;
    private final List<SourceParameterBinding> resultParameters;
    private final List<String> dataScopeNamespaces;
    private final boolean dateRangeRequired;
    private final String dateColumn;
    private final PredicatePlacement datePredicatePlacement;
    private final List<String> keywordColumns;
    private final PredicatePlacement keywordPredicatePlacement;
    private final Map<String, FilterDefinition> filters;
    private final Map<String, String> sortColumns;
    private final List<SortTerm> defaultSort;
    private final List<SortTerm> stableSort;
    private final SortTerm uniqueNonNullStableSort;
    private final List<String> totalGroupColumns;
    private final List<AggregateColumn> totalColumns;
    private final List<CsvColumn> csvColumns;

    private ReportQuerySpec(Builder builder) {
        this.reportKey = requiredMatch(builder.reportKey, REPORT_KEY, "report key");
        this.requiredPermission = requiredMatch(builder.requiredPermission, PERMISSION, "report permission");
        this.sourceSql = validatedSourceSql(builder.sourceSql);
        this.resultSql = validatedResultSql(builder.resultSql);
        if (resultSql == null && !builder.resultParameters.isEmpty()) {
            throw new IllegalArgumentException("report result parameters require result SQL");
        }
        this.dateRangeRequired = builder.dateRangeRequired;
        this.dateColumn = optionalColumn(builder.dateColumn, "date column");
        this.datePredicatePlacement = Objects.requireNonNull(
            builder.datePredicatePlacement,
            "date predicate placement must not be null"
        );
        if (datePredicatePlacement == PredicatePlacement.BOUND_ONLY && dateColumn != null) {
            throw new IllegalArgumentException("outer date predicate cannot use BOUND_ONLY placement");
        }
        if (dateColumn != null && !dateRangeRequired) {
            throw new IllegalArgumentException("report outer date predicate requires a date range");
        }
        this.keywordColumns = validatedColumns(builder.keywordColumns, "keyword column", false);
        this.keywordPredicatePlacement = Objects.requireNonNull(
            builder.keywordPredicatePlacement,
            "keyword predicate placement must not be null"
        );
        if (keywordPredicatePlacement == PredicatePlacement.BOUND_ONLY) {
            throw new IllegalArgumentException("keyword predicate cannot use BOUND_ONLY placement");
        }
        this.filters = validatedFilters(builder.filters);
        this.sourceParameters = validatedParameterBindings(
            builder.sourceParameters,
            dateRangeRequired,
            filters,
            "source"
        );
        this.resultParameters = validatedParameterBindings(
            builder.resultParameters,
            dateRangeRequired,
            filters,
            "result"
        );
        var scopeNamespaces = new LinkedHashSet<String>();
        java.util.stream.Stream.concat(sourceParameters.stream(), resultParameters.stream())
            .filter(binding -> binding.kind() == SourceParameterKind.DATA_SCOPE)
            .map(SourceParameterBinding::dataScopeNamespace)
            .forEach(scopeNamespaces::add);
        this.dataScopeNamespaces = List.copyOf(scopeNamespaces);
        for (var namespace : dataScopeNamespaces) {
            if (RESERVED_PARAMETERS.contains(namespace) || filters.containsKey(namespace)) {
                throw new IllegalArgumentException(
                    "data-scope namespace must not overlap a client parameter: " + namespace
                );
            }
        }
        if (dateRangeRequired && dateColumn == null) {
            var allBindings = new ArrayList<SourceParameterBinding>(sourceParameters);
            allBindings.addAll(resultParameters);
            var hasDateFrom = allBindings.stream()
                .anyMatch(parameter -> parameter.kind() == SourceParameterKind.DATE_FROM);
            var hasDateTo = allBindings.stream()
                .anyMatch(parameter -> parameter.kind() == SourceParameterKind.DATE_TO);
            if (!hasDateFrom || !hasDateTo) {
                throw new IllegalArgumentException(
                    "required date range needs an outer date column or both DATE_FROM and DATE_TO source bindings"
                );
            }
        }
        validateBoundOnlyFilters(filters, sourceParameters, resultParameters);
        this.sortColumns = validatedSortColumns(builder.sortColumns);
        this.defaultSort = validatedSortTerms(builder.defaultSort, sortColumns, "default sort");
        this.stableSort = validatedSortTerms(builder.stableSort, sortColumns, "stable sort");
        if (defaultSort.isEmpty()) {
            throw new IllegalArgumentException("report default sort must not be empty");
        }
        if (defaultSort.size() != 1) {
            throw new IllegalArgumentException("report default sort must contain exactly one primary field");
        }
        if (stableSort.isEmpty()) {
            throw new IllegalArgumentException("report stable sort must not be empty");
        }
        this.uniqueNonNullStableSort = builder.uniqueNonNullStableSort;
        if (uniqueNonNullStableSort == null || !stableSort.getLast().equals(uniqueNonNullStableSort)) {
            throw new IllegalArgumentException(
                "report stable sort must end with one explicitly unique and non-null field"
            );
        }
        this.totalGroupColumns = validatedColumns(builder.totalGroupColumns, "total group column", false);
        this.totalColumns = validatedAggregateColumns(builder.totalColumns);
        if (!totalGroupColumns.isEmpty() && totalColumns.isEmpty()) {
            throw new IllegalArgumentException("report total groups require at least one aggregate column");
        }
        this.csvColumns = validatedCsvColumns(builder.csvColumns);
        if (csvColumns.isEmpty()) {
            throw new IllegalArgumentException("report CSV columns must not be empty");
        }
    }

    public static Builder builder(String reportKey, String requiredPermission, String sourceSql) {
        return new Builder(reportKey, requiredPermission, sourceSql);
    }

    public String reportKey() {
        return reportKey;
    }

    public String requiredPermission() {
        return requiredPermission;
    }

    public String sourceSql() {
        return sourceSql;
    }

    public List<SourceParameterBinding> sourceParameters() {
        return sourceParameters;
    }

    public String resultSql() {
        return resultSql;
    }

    public boolean hasResultSql() {
        return resultSql != null;
    }

    public List<SourceParameterBinding> resultParameters() {
        return resultParameters;
    }

    public List<String> dataScopeNamespaces() {
        return dataScopeNamespaces;
    }

    public String dateColumn() {
        return dateColumn;
    }

    public boolean requiresDateRange() {
        return dateRangeRequired;
    }

    public boolean hasOuterDatePredicate() {
        return dateColumn != null;
    }

    public PredicatePlacement datePredicatePlacement() {
        return datePredicatePlacement;
    }

    public List<String> keywordColumns() {
        return keywordColumns;
    }

    public PredicatePlacement keywordPredicatePlacement() {
        return keywordPredicatePlacement;
    }

    public Map<String, FilterDefinition> filters() {
        return filters;
    }

    public Map<String, String> sortColumns() {
        return sortColumns;
    }

    public List<SortTerm> defaultSort() {
        return defaultSort;
    }

    public List<SortTerm> stableSort() {
        return stableSort;
    }

    /** The definition author guarantees this final output alias is both unique and non-null. */
    public SortTerm uniqueNonNullStableSort() {
        return uniqueNonNullStableSort;
    }

    public List<String> totalGroupColumns() {
        return totalGroupColumns;
    }

    public List<AggregateColumn> totalColumns() {
        return totalColumns;
    }

    public List<CsvColumn> csvColumns() {
        return csvColumns;
    }

    public enum ValueType {
        TEXT,
        UUID,
        ENUM,
        BOOLEAN,
        INTEGER,
        LONG,
        DECIMAL,
        DATE
    }

    public enum FilterOperator {
        EQUALS,
        CONTAINS
    }

    public enum SortDirection {
        ASC,
        DESC
    }

    public enum PredicatePlacement {
        FACT,
        RESULT,
        BOTH,
        BOUND_ONLY
    }

    public enum SourceParameterKind {
        FIXED,
        DATE_FROM,
        DATE_TO,
        FILTER,
        DATA_SCOPE
    }

    public record SourceParameterBinding(
        SourceParameterKind kind,
        Object fixedValue,
        String filterParameter,
        String dataScopeNamespace
    ) {
        public SourceParameterBinding {
            kind = Objects.requireNonNull(kind, "source parameter kind must not be null");
            switch (kind) {
                case FIXED -> {
                    if (filterParameter != null || dataScopeNamespace != null) {
                        throw new IllegalArgumentException("fixed source parameter cannot name a filter");
                    }
                }
                case DATE_FROM, DATE_TO -> {
                    if (fixedValue != null || filterParameter != null || dataScopeNamespace != null) {
                        throw new IllegalArgumentException("date source parameter cannot carry arbitrary data");
                    }
                }
                case FILTER -> {
                    if (fixedValue != null || dataScopeNamespace != null) {
                        throw new IllegalArgumentException("filter source parameter cannot carry a fixed value");
                    }
                    filterParameter = requiredMatch(filterParameter, PARAMETER, "source filter parameter");
                }
                case DATA_SCOPE -> {
                    if (fixedValue != null || filterParameter != null) {
                        throw new IllegalArgumentException("data-scope parameter cannot carry client or fixed data");
                    }
                    dataScopeNamespace = requiredMatch(
                        dataScopeNamespace,
                        DATA_SCOPE_NAMESPACE,
                        "data-scope namespace"
                    );
                }
            }
        }

        public static SourceParameterBinding fixed(Object value) {
            return new SourceParameterBinding(SourceParameterKind.FIXED, value, null, null);
        }

        public static SourceParameterBinding dateFrom() {
            return new SourceParameterBinding(SourceParameterKind.DATE_FROM, null, null, null);
        }

        public static SourceParameterBinding dateTo() {
            return new SourceParameterBinding(SourceParameterKind.DATE_TO, null, null, null);
        }

        public static SourceParameterBinding filter(String parameter) {
            return new SourceParameterBinding(SourceParameterKind.FILTER, null, parameter, null);
        }

        public static SourceParameterBinding dataScope(String namespace) {
            return new SourceParameterBinding(SourceParameterKind.DATA_SCOPE, null, null, namespace);
        }
    }

    public record FilterDefinition(
        String parameter,
        String column,
        ValueType valueType,
        FilterOperator operator,
        Set<String> allowedValues,
        PredicatePlacement placement,
        String defaultValue,
        boolean required
    ) {
        public FilterDefinition {
            parameter = requiredMatch(parameter, PARAMETER, "filter parameter");
            if (RESERVED_PARAMETERS.contains(parameter)) {
                throw new IllegalArgumentException("report filter parameter is reserved: " + parameter);
            }
            column = requiredColumn(column, "filter column");
            valueType = Objects.requireNonNull(valueType, "filter value type must not be null");
            operator = Objects.requireNonNull(operator, "filter operator must not be null");
            placement = Objects.requireNonNull(placement, "filter predicate placement must not be null");
            allowedValues = allowedValues == null ? Set.of() : Set.copyOf(allowedValues);
            if (valueType == ValueType.ENUM && allowedValues.isEmpty()) {
                throw new IllegalArgumentException("enum report filter must declare allowed values: " + parameter);
            }
            if (valueType != ValueType.ENUM && !allowedValues.isEmpty()) {
                throw new IllegalArgumentException("only enum report filters may declare allowed values: " + parameter);
            }
            if (operator == FilterOperator.CONTAINS && valueType != ValueType.TEXT) {
                throw new IllegalArgumentException("contains report filter must use TEXT: " + parameter);
            }
            if (placement == PredicatePlacement.BOUND_ONLY && operator == FilterOperator.CONTAINS) {
                throw new IllegalArgumentException("bound-only filter cannot use contains: " + parameter);
            }
            if (defaultValue != null && valueType != ValueType.ENUM) {
                throw new IllegalArgumentException("only enum report filters may declare defaults: " + parameter);
            }
            if (defaultValue != null && !allowedValues.contains(defaultValue)) {
                throw new IllegalArgumentException("enum report filter default is not allowed: " + parameter);
            }
            if (required && defaultValue != null) {
                throw new IllegalArgumentException("required report filter cannot also declare a default: " + parameter);
            }
        }

        public static FilterDefinition equals(String parameter, String column, ValueType valueType) {
            return equals(parameter, column, valueType, PredicatePlacement.RESULT);
        }

        public static FilterDefinition equals(
            String parameter,
            String column,
            ValueType valueType,
            PredicatePlacement placement
        ) {
            return new FilterDefinition(
                parameter,
                column,
                valueType,
                FilterOperator.EQUALS,
                Set.of(),
                placement,
                null,
                false
            );
        }

        public static FilterDefinition enumEquals(String parameter, String column, String... allowedValues) {
            return enumEquals(parameter, column, PredicatePlacement.RESULT, allowedValues);
        }

        public static FilterDefinition enumEquals(
            String parameter,
            String column,
            PredicatePlacement placement,
            String... allowedValues
        ) {
            return new FilterDefinition(
                parameter,
                column,
                ValueType.ENUM,
                FilterOperator.EQUALS,
                new LinkedHashSet<>(List.of(allowedValues)),
                placement,
                null,
                false
            );
        }

        public static FilterDefinition enumEqualsDefault(
            String parameter,
            String column,
            PredicatePlacement placement,
            String defaultValue,
            String... allowedValues
        ) {
            return new FilterDefinition(
                parameter,
                column,
                ValueType.ENUM,
                FilterOperator.EQUALS,
                new LinkedHashSet<>(List.of(allowedValues)),
                placement,
                defaultValue,
                false
            );
        }

        public static FilterDefinition requiredEnumEquals(
            String parameter,
            String column,
            PredicatePlacement placement,
            String... allowedValues
        ) {
            return new FilterDefinition(
                parameter,
                column,
                ValueType.ENUM,
                FilterOperator.EQUALS,
                new LinkedHashSet<>(List.of(allowedValues)),
                placement,
                null,
                true
            );
        }

        public static FilterDefinition contains(String parameter, String column) {
            return contains(parameter, column, PredicatePlacement.RESULT);
        }

        public static FilterDefinition contains(
            String parameter,
            String column,
            PredicatePlacement placement
        ) {
            return new FilterDefinition(
                parameter,
                column,
                ValueType.TEXT,
                FilterOperator.CONTAINS,
                Set.of(),
                placement,
                null,
                false
            );
        }
    }

    public record SortTerm(String field, SortDirection direction) {
        public SortTerm {
            field = requiredMatch(field, PARAMETER, "sort field");
            direction = Objects.requireNonNull(direction, "sort direction must not be null");
        }
    }

    public record AggregateColumn(String outputField, String sourceColumn) {
        public AggregateColumn {
            outputField = requiredColumn(outputField, "aggregate output field");
            sourceColumn = requiredColumn(sourceColumn, "aggregate source column");
        }
    }

    public record CsvColumn(String title, String sourceColumn, boolean forceText) {
        public CsvColumn {
            if (title == null || title.isBlank() || title.length() > 80 || title.contains("\r") || title.contains("\n")) {
                throw new IllegalArgumentException("CSV column title is invalid");
            }
            title = title.trim();
            sourceColumn = requiredColumn(sourceColumn, "CSV source column");
        }
    }

    public static final class Builder {
        private final String reportKey;
        private final String requiredPermission;
        private final String sourceSql;
        private final List<SourceParameterBinding> sourceParameters = new ArrayList<>();
        private String resultSql;
        private final List<SourceParameterBinding> resultParameters = new ArrayList<>();
        private boolean dateRangeRequired;
        private String dateColumn;
        private PredicatePlacement datePredicatePlacement = PredicatePlacement.RESULT;
        private final List<String> keywordColumns = new ArrayList<>();
        private PredicatePlacement keywordPredicatePlacement = PredicatePlacement.RESULT;
        private final Map<String, FilterDefinition> filters = new LinkedHashMap<>();
        private final Map<String, String> sortColumns = new LinkedHashMap<>();
        private final List<SortTerm> defaultSort = new ArrayList<>();
        private final List<SortTerm> stableSort = new ArrayList<>();
        private SortTerm uniqueNonNullStableSort;
        private final List<String> totalGroupColumns = new ArrayList<>();
        private final List<AggregateColumn> totalColumns = new ArrayList<>();
        private final List<CsvColumn> csvColumns = new ArrayList<>();

        private Builder(String reportKey, String requiredPermission, String sourceSql) {
            this.reportKey = reportKey;
            this.requiredPermission = requiredPermission;
            this.sourceSql = sourceSql;
        }

        public Builder sourceParameters(Object... values) {
            if (values != null) {
                for (var value : values) {
                    sourceParameters.add(SourceParameterBinding.fixed(value));
                }
            }
            return this;
        }

        public Builder bindSourceDateFrom() {
            sourceParameters.add(SourceParameterBinding.dateFrom());
            return this;
        }

        public Builder bindSourceDateTo() {
            sourceParameters.add(SourceParameterBinding.dateTo());
            return this;
        }

        public Builder bindSourceFilter(String parameter) {
            sourceParameters.add(SourceParameterBinding.filter(parameter));
            return this;
        }

        public Builder bindSourceDataScope(String namespace) {
            sourceParameters.add(SourceParameterBinding.dataScope(namespace));
            return this;
        }

        public Builder resultSql(String sql) {
            this.resultSql = sql;
            return this;
        }

        public Builder resultParameters(Object... values) {
            if (values != null) {
                for (var value : values) {
                    resultParameters.add(SourceParameterBinding.fixed(value));
                }
            }
            return this;
        }

        public Builder bindResultDateFrom() {
            resultParameters.add(SourceParameterBinding.dateFrom());
            return this;
        }

        public Builder bindResultDateTo() {
            resultParameters.add(SourceParameterBinding.dateTo());
            return this;
        }

        public Builder bindResultFilter(String parameter) {
            resultParameters.add(SourceParameterBinding.filter(parameter));
            return this;
        }

        public Builder bindResultDataScope(String namespace) {
            resultParameters.add(SourceParameterBinding.dataScope(namespace));
            return this;
        }

        public Builder requiredDateRange() {
            this.dateRangeRequired = true;
            return this;
        }

        public Builder requiredDateRange(String column) {
            return requiredDateRange(column, PredicatePlacement.RESULT);
        }

        public Builder requiredDateRange(String column, PredicatePlacement placement) {
            this.dateRangeRequired = true;
            this.dateColumn = column;
            this.datePredicatePlacement = placement;
            return this;
        }

        public Builder keywordColumns(String... columns) {
            return keywordColumns(PredicatePlacement.RESULT, columns);
        }

        public Builder keywordColumns(PredicatePlacement placement, String... columns) {
            this.keywordPredicatePlacement = placement;
            if (columns != null) {
                keywordColumns.addAll(List.of(columns));
            }
            return this;
        }

        public Builder filter(FilterDefinition definition) {
            Objects.requireNonNull(definition, "filter definition must not be null");
            if (filters.putIfAbsent(definition.parameter(), definition) != null) {
                throw new IllegalArgumentException("duplicate report filter: " + definition.parameter());
            }
            return this;
        }

        public Builder sortField(String field, String column) {
            field = requiredMatch(field, PARAMETER, "sort field");
            column = requiredColumn(column, "sort column");
            if (sortColumns.putIfAbsent(field, column) != null) {
                throw new IllegalArgumentException("duplicate report sort field: " + field);
            }
            return this;
        }

        public Builder defaultSort(String field, SortDirection direction) {
            defaultSort.add(new SortTerm(field, direction));
            return this;
        }

        public Builder stableSort(String field, SortDirection direction) {
            if (uniqueNonNullStableSort != null) {
                throw new IllegalArgumentException("unique non-null stable sort must remain the final term");
            }
            stableSort.add(new SortTerm(field, direction));
            return this;
        }

        /** Declares that the final stable sort output alias is unique and never null. */
        public Builder uniqueNonNullStableSort(String field, SortDirection direction) {
            if (uniqueNonNullStableSort != null) {
                throw new IllegalArgumentException("report unique non-null stable sort may only be declared once");
            }
            uniqueNonNullStableSort = new SortTerm(field, direction);
            stableSort.add(uniqueNonNullStableSort);
            return this;
        }

        public Builder totalGroupColumns(String... columns) {
            if (columns != null) {
                totalGroupColumns.addAll(List.of(columns));
            }
            return this;
        }

        public Builder totalSum(String outputField, String sourceColumn) {
            totalColumns.add(new AggregateColumn(outputField, sourceColumn));
            return this;
        }

        public Builder csvColumn(String title, String sourceColumn, boolean forceText) {
            csvColumns.add(new CsvColumn(title, sourceColumn, forceText));
            return this;
        }

        public ReportQuerySpec build() {
            return new ReportQuerySpec(this);
        }
    }

    private static String validatedSourceSql(String sourceSql) {
        var normalized = validatedFixedSql(sourceSql, "source");
        validateUnqualifiedRelations(normalized);
        return normalized;
    }

    private static String validatedResultSql(String resultSql) {
        if (resultSql == null) {
            return null;
        }
        var normalized = validatedFixedSql(resultSql, "result");
        var relations = validateUnqualifiedRelations(normalized);
        if (relations.isEmpty() || !relations.equals(Set.of("report_fact"))) {
            throw new IllegalArgumentException("report result SQL may only read the controlled report_fact relation");
        }
        return normalized;
    }

    private static String validatedFixedSql(String sql, String stage) {
        if (sql == null || sql.isBlank()) {
            throw new IllegalArgumentException("report " + stage + " SQL must not be blank");
        }
        var normalized = sql.strip();
        var upper = normalized.toUpperCase(java.util.Locale.ROOT);
        if (!(upper.startsWith("SELECT ") || upper.startsWith("SELECT\n") || upper.startsWith("WITH ") || upper.startsWith("WITH\n"))) {
            throw new IllegalArgumentException("report " + stage + " SQL must start with SELECT or WITH");
        }
        if (normalized.indexOf(';') >= 0 || normalized.contains("--") || normalized.contains("/*") || normalized.contains("*/")) {
            throw new IllegalArgumentException("report " + stage + " SQL must be one comment-free statement");
        }
        return normalized;
    }

    private static Set<String> validateUnqualifiedRelations(String sql) {
        var tokens = tokenizeSql(sql);
        var depths = tokenDepths(tokens);
        var relations = new LinkedHashSet<String>();
        for (var index = 0; index < tokens.size(); index++) {
            if (tokens.get(index).isWord()
                && FORBIDDEN_SQL_KEYWORDS.contains(tokens.get(index).normalized())) {
                throw new IllegalArgumentException("report SQL must remain read-only SELECT");
            }
            if (tokens.get(index).keyword("select")) {
                validateSelectFromClause(tokens, depths, index, relations);
            }
            if (tokens.get(index).keyword("table")) {
                validateRelation(tokens, depths, index + 1, relations);
            }
        }
        return Set.copyOf(relations);
    }

    private static void validateSelectFromClause(
        List<SqlToken> tokens,
        int[] depths,
        int selectIndex,
        Set<String> relations
    ) {
        var selectDepth = depths[selectIndex];
        for (var index = selectIndex + 1; index < tokens.size(); index++) {
            if (depths[index] < selectDepth) {
                return;
            }
            if (depths[index] != selectDepth) {
                continue;
            }
            var token = tokens.get(index);
            if (token.keyword("union") || token.keyword("intersect") || token.keyword("except")) {
                return;
            }
            if (token.keyword("from")) {
                validateFromClause(tokens, depths, index, relations);
                return;
            }
        }
    }

    private static void validateFromClause(
        List<SqlToken> tokens,
        int[] depths,
        int fromIndex,
        Set<String> relations
    ) {
        var clauseDepth = depths[fromIndex];
        validateRelation(tokens, depths, fromIndex + 1, relations);
        for (var index = fromIndex + 1; index < tokens.size(); index++) {
            if (depths[index] < clauseDepth) {
                return;
            }
            if (depths[index] != clauseDepth) {
                continue;
            }
            var token = tokens.get(index);
            if (token.isWord() && FROM_CLAUSE_TERMINATORS.contains(token.normalized())) {
                return;
            }
            if (token.keyword("join") || token.type() == SqlTokenType.COMMA) {
                validateRelation(tokens, depths, index + 1, relations);
            }
        }
    }

    private static void validateRelation(
        List<SqlToken> tokens,
        int[] depths,
        int startIndex,
        Set<String> relations
    ) {
        var index = startIndex;
        while (index < tokens.size()
            && (tokens.get(index).keyword("only") || tokens.get(index).keyword("lateral"))) {
            index++;
        }
        if (index < tokens.size() && tokens.get(index).type() == SqlTokenType.LEFT_PAREN) {
            validateParenthesizedRelation(tokens, depths, index, relations);
            return;
        }
        if (index >= tokens.size() || !tokens.get(index).isIdentifier()) {
            return;
        }
        if (tokens.get(index).keyword("rows")
            && index + 1 < tokens.size()
            && tokens.get(index + 1).keyword("from")) {
            throw new IllegalArgumentException("report source SQL ROWS FROM relations are not supported");
        }
        if (index + 2 < tokens.size()
            && tokens.get(index + 1).type() == SqlTokenType.DOT
            && tokens.get(index + 2).isIdentifier()) {
            throw new IllegalArgumentException(
                "report source SQL relations must be unqualified for tenant routing"
            );
        }
        relations.add(tokens.get(index).normalizedIdentifier());
    }

    private static void validateParenthesizedRelation(
        List<SqlToken> tokens,
        int[] depths,
        int openingIndex,
        Set<String> relations
    ) {
        var openingDepth = depths[openingIndex];
        var closingIndex = -1;
        for (var index = openingIndex + 1; index < tokens.size(); index++) {
            if (tokens.get(index).type() == SqlTokenType.RIGHT_PAREN && depths[index] == openingDepth) {
                closingIndex = index;
                break;
            }
        }
        if (closingIndex < 0 || openingIndex + 1 >= closingIndex) {
            return;
        }

        var first = tokens.get(openingIndex + 1);
        if (first.keyword("select") || first.keyword("with")
            || first.keyword("values") || first.keyword("table")) {
            // Nested queries are validated by the global SELECT/TABLE walk. Do
            // not interpret SELECT-list commas as relation separators here.
            return;
        }

        validateRelation(tokens, depths, openingIndex + 1, relations);
        var relationDepth = openingDepth + 1;
        for (var index = openingIndex + 1; index < closingIndex; index++) {
            if (depths[index] != relationDepth) {
                continue;
            }
            var token = tokens.get(index);
            if (token.keyword("join") || token.type() == SqlTokenType.COMMA) {
                validateRelation(tokens, depths, index + 1, relations);
            }
        }
    }

    private static int[] tokenDepths(List<SqlToken> tokens) {
        var depths = new int[tokens.size()];
        var depth = 0;
        for (var index = 0; index < tokens.size(); index++) {
            var token = tokens.get(index);
            if (token.type() == SqlTokenType.RIGHT_PAREN) {
                depth--;
                if (depth < 0) {
                    throw new IllegalArgumentException("report source SQL has unbalanced parentheses");
                }
            }
            depths[index] = depth;
            if (token.type() == SqlTokenType.LEFT_PAREN) {
                depth++;
            }
        }
        if (depth != 0) {
            throw new IllegalArgumentException("report source SQL has unbalanced parentheses");
        }
        return depths;
    }

    private static List<SqlToken> tokenizeSql(String sql) {
        var tokens = new ArrayList<SqlToken>();
        for (var offset = 0; offset < sql.length();) {
            var current = sql.charAt(offset);
            if (Character.isWhitespace(current)) {
                offset++;
                continue;
            }
            if (current == '\'') {
                offset = skipQuoted(sql, offset, '\'');
                tokens.add(new SqlToken(SqlTokenType.STRING, ""));
                continue;
            }
            if (current == '"') {
                var end = skipQuoted(sql, offset, '"');
                tokens.add(new SqlToken(SqlTokenType.QUOTED_IDENTIFIER, sql.substring(offset, end)));
                offset = end;
                continue;
            }
            if (current == '$') {
                throw new IllegalArgumentException("report source SQL dollar quoting is not supported");
            }
            if ((current == 'U' || current == 'u')
                && offset + 2 < sql.length()
                && sql.charAt(offset + 1) == '&'
                && (sql.charAt(offset + 2) == '"' || sql.charAt(offset + 2) == '\'')) {
                throw new IllegalArgumentException("report source SQL Unicode escape quoting is not supported");
            }
            if (Character.isLetter(current) || current == '_') {
                var end = offset + 1;
                while (end < sql.length()) {
                    var next = sql.charAt(end);
                    if (!Character.isLetterOrDigit(next) && next != '_' && next != '$') {
                        break;
                    }
                    end++;
                }
                tokens.add(new SqlToken(SqlTokenType.WORD, sql.substring(offset, end)));
                offset = end;
                continue;
            }
            var type = switch (current) {
                case '.' -> SqlTokenType.DOT;
                case ',' -> SqlTokenType.COMMA;
                case '(' -> SqlTokenType.LEFT_PAREN;
                case ')' -> SqlTokenType.RIGHT_PAREN;
                default -> SqlTokenType.OTHER;
            };
            tokens.add(new SqlToken(type, String.valueOf(current)));
            offset++;
        }
        return List.copyOf(tokens);
    }

    private static int skipQuoted(String sql, int start, char quote) {
        var offset = start + 1;
        while (offset < sql.length()) {
            if (sql.charAt(offset) != quote) {
                offset++;
                continue;
            }
            if (offset + 1 < sql.length() && sql.charAt(offset + 1) == quote) {
                offset += 2;
                continue;
            }
            return offset + 1;
        }
        throw new IllegalArgumentException("report source SQL has an unterminated quoted value");
    }

    private enum SqlTokenType {
        WORD,
        QUOTED_IDENTIFIER,
        STRING,
        DOT,
        COMMA,
        LEFT_PAREN,
        RIGHT_PAREN,
        OTHER
    }

    private record SqlToken(SqlTokenType type, String value) {
        private boolean isWord() {
            return type == SqlTokenType.WORD;
        }

        private boolean isIdentifier() {
            return type == SqlTokenType.WORD || type == SqlTokenType.QUOTED_IDENTIFIER;
        }

        private String normalized() {
            return value.toLowerCase(Locale.ROOT);
        }

        private boolean keyword(String keyword) {
            return isWord() && normalized().equals(keyword);
        }

        private String normalizedIdentifier() {
            if (type == SqlTokenType.WORD) {
                return normalized();
            }
            if (type == SqlTokenType.QUOTED_IDENTIFIER) {
                return value.substring(1, value.length() - 1).replace("\"\"", "\"");
            }
            throw new IllegalStateException("SQL token is not an identifier");
        }
    }

    private static Map<String, FilterDefinition> validatedFilters(Map<String, FilterDefinition> filters) {
        var validated = new LinkedHashMap<String, FilterDefinition>();
        filters.forEach((key, definition) -> {
            if (!Objects.equals(key, definition.parameter())) {
                throw new IllegalArgumentException("report filter map key mismatch: " + key);
            }
            if (validated.putIfAbsent(key, definition) != null) {
                throw new IllegalArgumentException("duplicate report filter: " + key);
            }
        });
        return java.util.Collections.unmodifiableMap(validated);
    }

    private static List<SourceParameterBinding> validatedParameterBindings(
        List<SourceParameterBinding> parameters,
        boolean dateRangeRequired,
        Map<String, FilterDefinition> filters,
        String stage
    ) {
        for (var parameter : parameters) {
            if ((parameter.kind() == SourceParameterKind.DATE_FROM || parameter.kind() == SourceParameterKind.DATE_TO)
                && !dateRangeRequired) {
                throw new IllegalArgumentException("date " + stage + " parameter requires a required date range");
            }
            if (parameter.kind() == SourceParameterKind.FILTER
                && !filters.containsKey(parameter.filterParameter())) {
                throw new IllegalArgumentException(
                    stage + " parameter references unknown filter: " + parameter.filterParameter()
                );
            }
        }
        return List.copyOf(parameters);
    }

    private static void validateBoundOnlyFilters(
        Map<String, FilterDefinition> filters,
        List<SourceParameterBinding> sourceParameters,
        List<SourceParameterBinding> resultParameters
    ) {
        var boundFilters = new LinkedHashSet<String>();
        java.util.stream.Stream.concat(sourceParameters.stream(), resultParameters.stream())
            .filter(binding -> binding.kind() == SourceParameterKind.FILTER)
            .map(SourceParameterBinding::filterParameter)
            .forEach(boundFilters::add);
        filters.forEach((parameter, definition) -> {
            if (definition.placement() == PredicatePlacement.BOUND_ONLY && !boundFilters.contains(parameter)) {
                throw new IllegalArgumentException("BOUND_ONLY report filter must have a source or result binding: " + parameter);
            }
            if (boundFilters.contains(parameter)
                && (definition.placement() == PredicatePlacement.RESULT
                    || definition.placement() == PredicatePlacement.BOTH)) {
                throw new IllegalArgumentException(
                    "bound report filter must not be repeated as a result predicate: " + parameter
                );
            }
        });
    }

    private static Map<String, String> validatedSortColumns(Map<String, String> sortColumns) {
        var validated = new LinkedHashMap<String, String>();
        sortColumns.forEach((field, column) -> validated.put(
            requiredMatch(field, PARAMETER, "sort field"),
            requiredColumn(column, "sort column")
        ));
        return java.util.Collections.unmodifiableMap(validated);
    }

    private static List<SortTerm> validatedSortTerms(
        List<SortTerm> terms,
        Map<String, String> sortColumns,
        String label
    ) {
        var validated = new ArrayList<SortTerm>();
        var fields = new LinkedHashSet<String>();
        for (var term : terms) {
            if (!sortColumns.containsKey(term.field())) {
                throw new IllegalArgumentException(label + " references unknown field: " + term.field());
            }
            if (!fields.add(term.field())) {
                throw new IllegalArgumentException(label + " repeats field: " + term.field());
            }
            validated.add(term);
        }
        return List.copyOf(validated);
    }

    private static List<String> validatedColumns(List<String> columns, String label, boolean requireOne) {
        var validated = new ArrayList<String>();
        var unique = new LinkedHashSet<String>();
        for (var column : columns) {
            var normalized = requiredColumn(column, label);
            if (!unique.add(normalized)) {
                throw new IllegalArgumentException("duplicate " + label + ": " + normalized);
            }
            validated.add(normalized);
        }
        if (requireOne && validated.isEmpty()) {
            throw new IllegalArgumentException(label + " must not be empty");
        }
        return List.copyOf(validated);
    }

    private static List<AggregateColumn> validatedAggregateColumns(List<AggregateColumn> columns) {
        var outputFields = new LinkedHashSet<String>();
        for (var column : columns) {
            if (!outputFields.add(column.outputField())) {
                throw new IllegalArgumentException("duplicate aggregate output field: " + column.outputField());
            }
        }
        return List.copyOf(columns);
    }

    private static List<CsvColumn> validatedCsvColumns(List<CsvColumn> columns) {
        var sourceColumns = new LinkedHashSet<String>();
        for (var column : columns) {
            if (!sourceColumns.add(column.sourceColumn())) {
                throw new IllegalArgumentException("duplicate CSV source column: " + column.sourceColumn());
            }
        }
        return List.copyOf(columns);
    }

    private static String optionalColumn(String value, String label) {
        return value == null ? null : requiredColumn(value, label);
    }

    private static String requiredColumn(String value, String label) {
        return requiredMatch(value, COLUMN, label);
    }

    private static String requiredMatch(String value, Pattern pattern, String label) {
        if (value == null || !pattern.matcher(value).matches()) {
            throw new IllegalArgumentException(label + " is invalid: " + value);
        }
        return value;
    }
}
