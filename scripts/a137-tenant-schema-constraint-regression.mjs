import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a137-tenant-schema-constraint-regression.json");
const migrationPath = path.join(
  rootDir,
  "backend/src/main/resources/db/migration/V98__tenant_schema_constraint_parity.sql"
);
const runtimeGuardMigrationPath = path.join(
  rootDir,
  "backend/src/main/resources/db/migration/V99__tenant_schema_exemption_runtime_guard.sql"
);
const employeeAccountMigrationPath = path.join(
  rootDir,
  "backend/src/main/resources/db/migration/V100__employee_financial_account_master_data.sql"
);
const sessionScopeMigrationPath = path.join(
  rootDir,
  "backend/src/main/resources/db/migration/V101__session_account_scope_authority.sql"
);
const formalSettlementMigrationPath = path.join(
  rootDir,
  "backend/src/main/resources/db/migration/V102__formal_receipt_payment_documents.sql"
);
const salesReturnMigrationPath = path.join(
  rootDir,
  "backend/src/main/resources/db/migration/V103__sales_return_document.sql"
);
const masterDataImportMigrationPath = path.join(
  rootDir,
  "backend/src/main/resources/db/migration/V104__master_data_excel_import.sql"
);
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const database = process.env.JDY_DATABASE || "jdy_erp";
const databaseUser = process.env.JDY_DATABASE_USER || "jdy";
const expectedSchemas = ["tenant_a119ops_49f5546b", "tenant_a119ui"];
const expectedMetrics = {
  baseTables: 82,
  managedTables: 82,
  primaryKeys: 82,
  uniqueConstraints: 76,
  foreignKeys: 170,
  checkConstraints: 76,
  unvalidatedForeignKeys: 0,
  columnMismatchCount: 0,
  referenceConstraintMismatchCount: 0,
  referenceForeignKeyCount: 170,
  referenceForeignKeyMismatchCount: 0,
  retiredTaxColumns: 0,
  forbiddenAccountSetForeignKeys: 0
};
const tenantScopeAccountSetChildren = [
  "document_number_sequence",
  "inv_stock_balance",
  "inv_stock_opening",
  "inv_stock_txn"
];
const quarantinedActorMarkers = [
  "A136_ACTOR_20260713005422_92a8c216bd",
  "A136_ACTOR_20260713004744_42b0b1841a",
  "A136_ACTOR_20260713010433_d9a3c1fec3",
  "A136_ACTOR_20260713011750_c92416b00b",
  "A136_ACTOR_20260713003821_18addb5df7",
  "A136_ACTOR_20260713010936_d3ae85cc07",
  "A136_ACTOR_20260713013041_569a349279"
];
const token = randomBytes(5).toString("hex");
const tokenNumber = Number.parseInt(token.slice(0, 7), 16) + 1;
const fixtureCode = `A137-${token.toUpperCase()}`;
const topology = {
  schema: `tenant_a137_${token}`,
  missingSchema: `tenant_a137_missing_${token}`,
  unregisteredSchema: `tenant_a137_unregistered_${token}`,
  unsafeSchema: `tenant-a137-${token}`,
  accountCode: `A137-TOPOLOGY-${token.toUpperCase()}`,
  missingAccountCode: `A137-MISSING-${token.toUpperCase()}`,
  unsafeAccountCode: `A137-UNSAFE-${token.toUpperCase()}`,
  accountId: randomUUID(),
  missingAccountId: randomUUID(),
  unsafeAccountId: randomUUID(),
  categoryId: randomUUID(),
  unitId: randomUUID(),
  productId: randomUUID(),
  missingSupplierId: randomUUID()
};
const enforcement = {
  customerOneId: randomUUID(),
  customerTwoId: randomUUID(),
  duplicateCustomerId: randomUUID(),
  invalidLineId: randomUUID(),
  invalidLogId: randomUUID(),
  missingBillId: randomUUID(),
  missingProductId: randomUUID(),
  missingWarehouseId: randomUUID()
};
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

await mkdir(verificationDir, { recursive: true });

const result = {
  ok: false,
  generatedAt: new Date().toISOString(),
  container,
  database,
  token,
  expectedSchemas,
  expectedMetrics,
  migration: {},
  existingTenants: {},
  enforcement: {},
  topologies: {},
  cleanup: {}
};

let primaryError = null;
try {
  const migrationSource = await readFile(migrationPath, "utf8");
  const runtimeGuardMigrationSource = await readFile(runtimeGuardMigrationPath, "utf8");
  const employeeAccountMigrationSource = await readFile(employeeAccountMigrationPath, "utf8");
  const sessionScopeMigrationSource = await readFile(sessionScopeMigrationPath, "utf8");
  const formalSettlementMigrationSource = await readFile(formalSettlementMigrationPath, "utf8");
  const salesReturnMigrationSource = await readFile(salesReturnMigrationPath, "utf8");
  const masterDataImportMigrationSource = await readFile(masterDataImportMigrationPath, "utf8");
  result.migrationGuards = {
    exactQuarantinedRows:
      quarantinedActorMarkers.every((marker) => migrationSource.includes(marker))
      && migrationSource.includes("JOIN expected ON expected.id = line.id")
      && migrationSource.includes("line.bill_id IS DISTINCT FROM expected.bill_id")
      && migrationSource.includes("line.product_id IS NOT DISTINCT FROM expected.product_id")
      && !migrationSource.includes("line_remark LIKE 'A136_ACTOR_%'"),
    migrationTimeReservedNameGuard:
      migrationSource.includes("reserved_name_count <> 4")
      && migrationSource.includes("V98 tenant scope FK reserved-name drifted"),
    runtimeExemptionGuard:
      runtimeGuardMigrationSource.includes("reserved_name_count <> 4 OR exact_exemption_count <> 4")
      && runtimeGuardMigrationSource.includes("jdy_sync_tenant_schema_v98"),
    employeeAccountManagedGuard:
      employeeAccountMigrationSource.includes("CREATE TABLE md_employee")
      && employeeAccountMigrationSource.includes("CREATE TABLE md_financial_account")
      && employeeAccountMigrationSource.includes("('md_employee', 135)")
      && employeeAccountMigrationSource.includes("('md_financial_account', 136)")
      && employeeAccountMigrationSource.includes("currency IN ('CNY', 'USD')")
      && employeeAccountMigrationSource.includes("expected=74/66/153/16"),
    sessionScopeAuthorityGuard:
      sessionScopeMigrationSource.includes("CREATE TABLE sys_session_account_scope")
      && sessionScopeMigrationSource.includes("session_token UUID PRIMARY KEY")
      && sessionScopeMigrationSource.includes("scope_token UUID NOT NULL")
      && sessionScopeMigrationSource.includes("REFERENCES sys_user(id) ON DELETE CASCADE")
      && sessionScopeMigrationSource.includes("REFERENCES sys_account_set(id) ON DELETE CASCADE")
      && !sessionScopeMigrationSource.includes("sys_tenant_managed_table"),
    formalSettlementManagedGuard:
      formalSettlementMigrationSource.includes("CREATE TABLE ar_receipt_fund_line")
      && formalSettlementMigrationSource.includes("CREATE TABLE ar_receipt_allocation")
      && formalSettlementMigrationSource.includes("CREATE TABLE ap_payment_fund_line")
      && formalSettlementMigrationSource.includes("CREATE TABLE ap_payment_allocation")
      && formalSettlementMigrationSource.includes("('ar_receipt_fund_line', 701)")
      && formalSettlementMigrationSource.includes("('ar_receipt_allocation', 702)")
      && formalSettlementMigrationSource.includes("('ap_payment_fund_line', 721)")
      && formalSettlementMigrationSource.includes("('ap_payment_allocation', 722)")
      && formalSettlementMigrationSource.includes("expected=78/72/163/43")
      && formalSettlementMigrationSource.includes("expected=78/78/72/167/43")
      && formalSettlementMigrationSource.includes("legacy_imported BOOLEAN NOT NULL DEFAULT FALSE")
      && formalSettlementMigrationSource.includes("No statement in this migration changes an AR/AP settled total."),
    salesReturnManagedGuard:
      salesReturnMigrationSource.includes("CREATE TABLE sales_return")
      && salesReturnMigrationSource.includes("CREATE TABLE sales_return_line")
      && salesReturnMigrationSource.includes("CREATE TABLE sales_return_finance_allocation")
      && salesReturnMigrationSource.includes("ADD COLUMN return_offset_amount")
      && salesReturnMigrationSource.includes("('sales_return', 391)")
      && salesReturnMigrationSource.includes("('sales_return_line', 392)")
      && salesReturnMigrationSource.includes("('sales_return_finance_allocation', 699)")
      && salesReturnMigrationSource.includes("expected=81/76/170/64")
      && salesReturnMigrationSource.includes("expected=81/81/76/174/64")
      && salesReturnMigrationSource.includes("amount <= 0 AND return_offset_amount = 0"),
    masterDataImportManagedGuard:
      masterDataImportMigrationSource.includes("CREATE TABLE md_import_batch")
      && masterDataImportMigrationSource.includes("('md_import_batch', 75)")
      && masterDataImportMigrationSource.includes("jsonb_typeof(rows_payload) = 'array'")
      && masterDataImportMigrationSource.includes("file_size_bytes <= 10485760")
      && masterDataImportMigrationSource.includes("expected=82/76/170/76")
      && masterDataImportMigrationSource.includes("expected=82/82/76/174/76/0")
      && !masterDataImportMigrationSource.includes("FOREIGN KEY (account_set_id)")
  };
  assert(result.migrationGuards.exactQuarantinedRows, "V98 must bind deletion to every quarantined row tuple");
  assert(result.migrationGuards.migrationTimeReservedNameGuard, "V98 must reject extra reserved FK names");
  assert(result.migrationGuards.runtimeExemptionGuard, "V99 must guard the four FK exemptions on every sync");
  assert(
    result.migrationGuards.employeeAccountManagedGuard,
    "V100 must register both masters and retain the exact 74-table constraint topology"
  );
  assert(
    result.migrationGuards.sessionScopeAuthorityGuard,
    "V101 must keep the session scope authority platform-owned and keyed by session token"
  );
  assert(
    result.migrationGuards.formalSettlementManagedGuard,
    "V102 must preserve legacy settlements and retain the exact 78-table topology"
  );
  assert(
    result.migrationGuards.salesReturnManagedGuard,
    "V103 must register sales returns and retain the exact 81-table topology"
  );
  assert(
    result.migrationGuards.masterDataImportManagedGuard,
    "V104 must register the bounded import batch without adding an account-set FK exemption"
  );
  const sourceChecksum = flywayChecksum(migrationSource);
  const runtimeGuardSourceChecksum = flywayChecksum(runtimeGuardMigrationSource);
  const employeeAccountSourceChecksum = flywayChecksum(employeeAccountMigrationSource);
  const sessionScopeSourceChecksum = flywayChecksum(sessionScopeMigrationSource);
  const formalSettlementSourceChecksum = flywayChecksum(formalSettlementMigrationSource);
  const salesReturnSourceChecksum = flywayChecksum(salesReturnMigrationSource);
  const masterDataImportSourceChecksum = flywayChecksum(masterDataImportMigrationSource);
  const migrationRows = sqlJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'installedRank', installed_rank,
      'version', version,
      'description', description,
      'script', script,
      'checksum', checksum,
      'success', success
    ) ORDER BY installed_rank), '[]'::jsonb)::text
    FROM public.flyway_schema_history
    WHERE version IN ('98', '99', '100', '101', '102', '103', '104')
  `);
  assert(migrationRows.length === 7, `expected installed V98 through V104 rows, found ${migrationRows.length}`);
  const migration = migrationRows.find((row) => row.version === "98");
  const runtimeGuardMigration = migrationRows.find((row) => row.version === "99");
  const employeeAccountMigration = migrationRows.find((row) => row.version === "100");
  const sessionScopeMigration = migrationRows.find((row) => row.version === "101");
  const formalSettlementMigration = migrationRows.find((row) => row.version === "102");
  const salesReturnMigration = migrationRows.find((row) => row.version === "103");
  const masterDataImportMigration = migrationRows.find((row) => row.version === "104");
  assert(migration, "installed V98 row is missing");
  assert(runtimeGuardMigration, "installed V99 row is missing");
  assert(employeeAccountMigration, "installed V100 row is missing");
  assert(sessionScopeMigration, "installed V101 row is missing");
  assert(formalSettlementMigration, "installed V102 row is missing");
  assert(salesReturnMigration, "installed V103 row is missing");
  assert(masterDataImportMigration, "installed V104 row is missing");
  assert(migration.success === true, "V98 is not marked successful");
  assert(runtimeGuardMigration.success === true, "V99 is not marked successful");
  assert(employeeAccountMigration.success === true, "V100 is not marked successful");
  assert(sessionScopeMigration.success === true, "V101 is not marked successful");
  assert(formalSettlementMigration.success === true, "V102 is not marked successful");
  assert(salesReturnMigration.success === true, "V103 is not marked successful");
  assert(masterDataImportMigration.success === true, "V104 is not marked successful");
  assert(Number.isInteger(migration.checksum), "V98 installed checksum is missing");
  assert(Number.isInteger(runtimeGuardMigration.checksum), "V99 installed checksum is missing");
  assert(Number.isInteger(employeeAccountMigration.checksum), "V100 installed checksum is missing");
  assert(Number.isInteger(sessionScopeMigration.checksum), "V101 installed checksum is missing");
  assert(Number.isInteger(formalSettlementMigration.checksum), "V102 installed checksum is missing");
  assert(Number.isInteger(salesReturnMigration.checksum), "V103 installed checksum is missing");
  assert(Number.isInteger(masterDataImportMigration.checksum), "V104 installed checksum is missing");
  assert(
    migration.checksum === sourceChecksum,
    `V98 checksum drift: installed=${migration.checksum} source=${sourceChecksum}`
  );
  result.migration = {
    ...migration,
    sourceChecksum,
    sourceSha256: createHash("sha256").update(migrationSource).digest("hex")
  };
  assert(
    runtimeGuardMigration.checksum === runtimeGuardSourceChecksum,
    `V99 checksum drift: installed=${runtimeGuardMigration.checksum} source=${runtimeGuardSourceChecksum}`
  );
  result.runtimeGuardMigration = {
    ...runtimeGuardMigration,
    sourceChecksum: runtimeGuardSourceChecksum,
    sourceSha256: createHash("sha256").update(runtimeGuardMigrationSource).digest("hex")
  };
  assert(
    employeeAccountMigration.checksum === employeeAccountSourceChecksum,
    `V100 checksum drift: installed=${employeeAccountMigration.checksum} source=${employeeAccountSourceChecksum}`
  );
  result.employeeAccountMigration = {
    ...employeeAccountMigration,
    sourceChecksum: employeeAccountSourceChecksum,
    sourceSha256: createHash("sha256").update(employeeAccountMigrationSource).digest("hex")
  };
  assert(
    sessionScopeMigration.checksum === sessionScopeSourceChecksum,
    `V101 checksum drift: installed=${sessionScopeMigration.checksum} source=${sessionScopeSourceChecksum}`
  );
  result.sessionScopeMigration = {
    ...sessionScopeMigration,
    sourceChecksum: sessionScopeSourceChecksum,
    sourceSha256: createHash("sha256").update(sessionScopeMigrationSource).digest("hex")
  };
  assert(
    formalSettlementMigration.checksum === formalSettlementSourceChecksum,
    `V102 checksum drift: installed=${formalSettlementMigration.checksum} source=${formalSettlementSourceChecksum}`
  );
  result.formalSettlementMigration = {
    ...formalSettlementMigration,
    sourceChecksum: formalSettlementSourceChecksum,
    sourceSha256: createHash("sha256").update(formalSettlementMigrationSource).digest("hex")
  };
  assert(
    salesReturnMigration.checksum === salesReturnSourceChecksum,
    `V103 checksum drift: installed=${salesReturnMigration.checksum} source=${salesReturnSourceChecksum}`
  );
  result.salesReturnMigration = {
    ...salesReturnMigration,
    sourceChecksum: salesReturnSourceChecksum,
    sourceSha256: createHash("sha256").update(salesReturnMigrationSource).digest("hex")
  };
  assert(
    masterDataImportMigration.checksum === masterDataImportSourceChecksum,
    `V104 checksum drift: installed=${masterDataImportMigration.checksum} source=${masterDataImportSourceChecksum}`
  );
  result.masterDataImportMigration = {
    ...masterDataImportMigration,
    sourceChecksum: masterDataImportSourceChecksum,
    sourceSha256: createHash("sha256").update(masterDataImportMigrationSource).digest("hex")
  };

  const registeredSchemas = sqlJson(`
    SELECT COALESCE(jsonb_agg(schema_name ORDER BY schema_name), '[]'::jsonb)::text
    FROM (
      SELECT DISTINCT btrim(schema_name) AS schema_name
      FROM public.sys_account_set
      WHERE nullif(btrim(schema_name), '') IS NOT NULL
        AND lower(btrim(schema_name)) <> 'public'
    ) registered
  `);
  assert(
    same(registeredSchemas, expectedSchemas),
    `registered tenant schemas changed: expected=${JSON.stringify(expectedSchemas)} actual=${JSON.stringify(registeredSchemas)}`
  );

  for (const schema of registeredSchemas) {
    const beforeMetrics = sqlJson(schemaMetricsSql(schema));
    assertMetrics(schema, beforeMetrics);
    const before = tenantFingerprints(schema);

    const firstManagedCount = Number(sqlScalar(
      `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(schema)}, FALSE)`
    ));
    assert(firstManagedCount === 82, `${schema} first sync returned ${firstManagedCount}, expected 82`);
    const afterFirstMetrics = sqlJson(schemaMetricsSql(schema));
    assertMetrics(`${schema} after first sync`, afterFirstMetrics);
    const afterFirst = tenantFingerprints(schema);

    const secondManagedCount = Number(sqlScalar(
      `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(schema)}, FALSE)`
    ));
    assert(secondManagedCount === 82, `${schema} second sync returned ${secondManagedCount}, expected 82`);
    const afterSecondMetrics = sqlJson(schemaMetricsSql(schema));
    assertMetrics(`${schema} after second sync`, afterSecondMetrics);
    const afterSecond = tenantFingerprints(schema);

    assertFingerprints(schema, before, afterFirst, "first sync");
    assertFingerprints(schema, afterFirst, afterSecond, "second sync");
    result.existingTenants[schema] = {
      metrics: afterSecondMetrics,
      syncManagedCounts: [firstManagedCount, secondManagedCount],
      fingerprints: { before, afterFirst, afterSecond },
      idempotent: true
    };
  }

  result.enforcement = runEnforcementChecks();
  assert(result.enforcement.crossTenantSameCodeAllowed === true, "cross-tenant same code was not proven");
  assert(result.enforcement.sameTenantDuplicateRejected === true, "same-tenant duplicate was not rejected");
  assert(result.enforcement.invalidForeignKeyRejected === true, "invalid FK write was not rejected");
  assert(result.enforcement.invalidUniqueKeyRejected === true, "invalid UK write was not rejected");
  assert(result.enforcement.invalidCheckRejected === true, "invalid CHECK write was not rejected");

  result.topologies = runTopologyChecks();
  const requiredTopologyChecks = [
    "unregisteredSchema",
    "unsafeSchema",
    "missingSchema",
    "duplicateSchemaRegistration",
    "repeatCreateMissing",
    "repeatFalseSync",
    "missingTable",
    "unknownExtraColumn",
    "extraConstraint",
    "spoofedExemptionName",
    "typeDrift",
    "orphan"
  ];
  for (const check of requiredTopologyChecks) {
    assert(result.topologies[check]?.ok === true, `topology ${check} was not rejected as required`);
  }
  assertMetrics("fresh temporary tenant", result.topologies.freshProvision.metrics);
  assertMetrics("repaired temporary tenant", result.topologies.repairedTopology.metrics);

  result.cleanup = verifyCleanup();
  assertCleanup(result.cleanup);
  result.ok = true;
} catch (error) {
  primaryError = error;
  result.error = errorText(error);
  try {
    result.cleanup = verifyCleanup();
    assertCleanup(result.cleanup);
  } catch (cleanupError) {
    result.cleanupError = errorText(cleanupError);
  }
}

result.finishedAt = new Date().toISOString();
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  ok: result.ok,
  resultPath: path.relative(rootDir, resultPath),
  schemas: Object.keys(result.existingTenants),
  topologyChecks: Object.values(result.topologies).filter((entry) => entry?.ok === true).length,
  cleanup: result.cleanup
}, null, 2));

if (primaryError) {
  console.error(errorText(primaryError));
  process.exit(1);
}

function runEnforcementChecks() {
  const firstSchema = expectedSchemas[0];
  const secondSchema = expectedSchemas[1];
  const sql = `
    BEGIN;
    CREATE TEMP TABLE a137_enforcement_result (
      check_name TEXT PRIMARY KEY,
      ok BOOLEAN NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb
    ) ON COMMIT DROP;

    INSERT INTO ${quoteIdentifier(firstSchema)}.md_customer (id, code, name, system_no)
    VALUES (${uuidLiteral(enforcement.customerOneId)}, ${sqlLiteral(fixtureCode)}, 'A137 same-code tenant one', ${-tokenNumber});
    INSERT INTO ${quoteIdentifier(secondSchema)}.md_customer (id, code, name, system_no)
    VALUES (${uuidLiteral(enforcement.customerTwoId)}, ${sqlLiteral(fixtureCode)}, 'A137 same-code tenant two', ${-tokenNumber});

    DO $a137_enforcement$
    DECLARE
      rejected BOOLEAN;
    BEGIN
      rejected := FALSE;
      BEGIN
        INSERT INTO ${quoteIdentifier(firstSchema)}.md_customer (id, code, name, system_no)
        VALUES (${uuidLiteral(enforcement.duplicateCustomerId)}, ${sqlLiteral(fixtureCode)}, 'A137 duplicate', ${-(tokenNumber + 1)});
      EXCEPTION WHEN unique_violation THEN
        rejected := TRUE;
      END;
      IF NOT rejected THEN
        RAISE EXCEPTION 'A137 expected same-tenant duplicate code to be rejected';
      END IF;
      INSERT INTO a137_enforcement_result VALUES (
        'sameTenantDuplicateRejected', TRUE, jsonb_build_object('constraintClass', 'UNIQUE', 'code', ${sqlLiteral(fixtureCode)})
      );
      INSERT INTO a137_enforcement_result VALUES (
        'invalidUniqueKeyRejected', TRUE, jsonb_build_object('constraintClass', 'UNIQUE', 'code', ${sqlLiteral(fixtureCode)})
      );

      rejected := FALSE;
      BEGIN
        INSERT INTO ${quoteIdentifier(firstSchema)}.stock_count_line (
          id, bill_id, line_no, product_id, warehouse_id, counted_qty, diff_qty
        ) VALUES (
          ${uuidLiteral(enforcement.invalidLineId)},
          ${uuidLiteral(enforcement.missingBillId)},
          1,
          ${uuidLiteral(enforcement.missingProductId)},
          ${uuidLiteral(enforcement.missingWarehouseId)},
          0,
          0
        );
      EXCEPTION WHEN foreign_key_violation THEN
        rejected := TRUE;
      END;
      IF NOT rejected THEN
        RAISE EXCEPTION 'A137 expected invalid business FK to be rejected';
      END IF;
      INSERT INTO a137_enforcement_result VALUES (
        'invalidForeignKeyRejected', TRUE, jsonb_build_object('constraintClass', 'FOREIGN KEY')
      );

      rejected := FALSE;
      BEGIN
        INSERT INTO ${quoteIdentifier(firstSchema)}.sys_operation_log (
          id, module_code, action_code, target_type, success, actor_type
        ) VALUES (
          ${uuidLiteral(enforcement.invalidLogId)}, 'A137', 'INVALID_CHECK', 'A137_FIXTURE', TRUE, 'BROKEN_ACTOR'
        );
      EXCEPTION WHEN check_violation THEN
        rejected := TRUE;
      END;
      IF NOT rejected THEN
        RAISE EXCEPTION 'A137 expected invalid actor CHECK to be rejected';
      END IF;
      INSERT INTO a137_enforcement_result VALUES (
        'invalidCheckRejected', TRUE, jsonb_build_object('constraintClass', 'CHECK')
      );
    END $a137_enforcement$;

    INSERT INTO a137_enforcement_result
    SELECT 'crossTenantSameCodeAllowed',
           count_one = 1 AND count_two = 1,
           jsonb_build_object('code', ${sqlLiteral(fixtureCode)}, 'tenantOneRows', count_one, 'tenantTwoRows', count_two)
    FROM (
      SELECT
        (SELECT count(*) FROM ${quoteIdentifier(firstSchema)}.md_customer WHERE code = ${sqlLiteral(fixtureCode)}) AS count_one,
        (SELECT count(*) FROM ${quoteIdentifier(secondSchema)}.md_customer WHERE code = ${sqlLiteral(fixtureCode)}) AS count_two
    ) counts;

    SELECT jsonb_object_agg(check_name, jsonb_build_object('ok', ok, 'detail', detail) ORDER BY check_name)::text
    FROM a137_enforcement_result;
    ROLLBACK;
  `;
  const checks = sqlJson(sql);
  return Object.fromEntries(Object.entries(checks).map(([name, value]) => [name, value.ok === true ? true : value]));
}

function runTopologyChecks() {
  const sql = `
    BEGIN;
    CREATE TEMP TABLE a137_topology_result (
      check_name TEXT PRIMARY KEY,
      ok BOOLEAN NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb
    ) ON COMMIT DROP;

    INSERT INTO public.sys_account_set (id, code, name, database_name, schema_name)
    VALUES
      (${uuidLiteral(topology.accountId)}, ${sqlLiteral(topology.accountCode)}, 'A137 topology tenant', ${sqlLiteral(database)}, ${sqlLiteral(topology.schema)}),
      (${uuidLiteral(topology.missingAccountId)}, ${sqlLiteral(topology.missingAccountCode)}, 'A137 missing-schema tenant', ${sqlLiteral(database)}, ${sqlLiteral(topology.missingSchema)}),
      (${uuidLiteral(topology.unsafeAccountId)}, ${sqlLiteral(topology.unsafeAccountCode)}, 'A137 unsafe-schema tenant', ${sqlLiteral(database)}, ${sqlLiteral(topology.unsafeSchema)});

    DO $a137_initial_topologies$
    DECLARE
      rejected BOOLEAN;
      failure TEXT;
    BEGIN
      rejected := FALSE;
      EXECUTE format('CREATE SCHEMA %I', ${sqlLiteral(topology.unregisteredSchema)});
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.unregisteredSchema)}, TRUE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('tenant schema registration count must equal one' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected unregistered-schema error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN
        RAISE EXCEPTION 'A137 unregistered schema unexpectedly synchronized';
      END IF;
      INSERT INTO a137_topology_result VALUES (
        'unregisteredSchema', TRUE, jsonb_build_object('error', failure)
      );
      EXECUTE format('DROP SCHEMA %I', ${sqlLiteral(topology.unregisteredSchema)});

      rejected := FALSE;
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.unsafeSchema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('unsafe or platform-scoped' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected unsafe-schema error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN
        RAISE EXCEPTION 'A137 unsafe schema unexpectedly synchronized';
      END IF;
      INSERT INTO a137_topology_result VALUES (
        'unsafeSchema', TRUE, jsonb_build_object('error', failure)
      );

      rejected := FALSE;
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.missingSchema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('registered tenant schema does not exist' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected missing-schema error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN
        RAISE EXCEPTION 'A137 missing schema unexpectedly synchronized';
      END IF;
      INSERT INTO a137_topology_result VALUES (
        'missingSchema', TRUE, jsonb_build_object('error', failure)
      );

      rejected := FALSE;
      BEGIN
        INSERT INTO public.sys_account_set (id, code, name, database_name, schema_name)
        VALUES (
          gen_random_uuid(),
          ${sqlLiteral(`${topology.accountCode}-DUP`)},
          'A137 duplicate-schema registration',
          ${sqlLiteral(database)},
          ${sqlLiteral(topology.schema)}
        );
      EXCEPTION WHEN unique_violation THEN
        failure := SQLERRM;
        rejected := TRUE;
      END;
      IF NOT rejected THEN
        RAISE EXCEPTION 'A137 duplicate tenant schema registration unexpectedly succeeded';
      END IF;
      INSERT INTO a137_topology_result VALUES (
        'duplicateSchemaRegistration', TRUE, jsonb_build_object('error', failure)
      );

      PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, TRUE);
    END $a137_initial_topologies$;

    INSERT INTO a137_topology_result
    SELECT 'freshProvision', TRUE, jsonb_build_object('metrics', metrics.metric)
    FROM (SELECT (${schemaMetricsSql(topology.schema)})::jsonb AS metric) metrics;

    DO $a137_repeat_create$
    DECLARE
      rejected BOOLEAN := FALSE;
      failure TEXT;
    BEGIN
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, TRUE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('new tenant schema already exists and cannot be adopted' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected repeated-create error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'A137 repeated create_missing=TRUE unexpectedly succeeded'; END IF;
      INSERT INTO a137_topology_result VALUES ('repeatCreateMissing', TRUE, jsonb_build_object('error', failure));
    END $a137_repeat_create$;

    DO $a137_repeat_false$
    DECLARE
      first_count INTEGER;
      second_count INTEGER;
    BEGIN
      first_count := public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      second_count := public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      IF first_count <> 82 OR second_count <> 82 THEN
        RAISE EXCEPTION 'A137 repeated create_missing=FALSE returned unexpected counts: first=% second=%',
          first_count, second_count;
      END IF;
      INSERT INTO a137_topology_result VALUES (
        'repeatFalseSync', TRUE, jsonb_build_object('managedCounts', jsonb_build_array(first_count, second_count))
      );
    END $a137_repeat_false$;

    DROP TABLE ${quoteIdentifier(topology.schema)}.ap_payment_allocation;
    DO $a137_missing_table$
    DECLARE
      rejected BOOLEAN := FALSE;
      failure TEXT;
    BEGIN
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('registered tenant table does not exist' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected missing-table error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'A137 missing table unexpectedly synchronized'; END IF;
      INSERT INTO a137_topology_result VALUES ('missingTable', TRUE, jsonb_build_object('error', failure));
    END $a137_missing_table$;
    CREATE TABLE ${quoteIdentifier(topology.schema)}.ap_payment_allocation
      (LIKE public.ap_payment_allocation INCLUDING ALL);
    DO $a137_repair_missing_table$
    BEGIN
      PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
    END $a137_repair_missing_table$;

    ALTER TABLE ${quoteIdentifier(topology.schema)}.md_customer ADD COLUMN a137_unknown_data TEXT;
    DO $a137_unknown_column$
    DECLARE
      rejected BOOLEAN := FALSE;
      failure TEXT;
    BEGIN
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('tenant has unknown extra columns' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected unknown-column error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'A137 unknown extra column unexpectedly synchronized'; END IF;
      INSERT INTO a137_topology_result VALUES ('unknownExtraColumn', TRUE, jsonb_build_object('error', failure));
    END $a137_unknown_column$;
    ALTER TABLE ${quoteIdentifier(topology.schema)}.md_customer DROP COLUMN a137_unknown_data;

    ALTER TABLE ${quoteIdentifier(topology.schema)}.md_customer
      ADD CONSTRAINT a137_unknown_extra_check CHECK (TRUE);
    DO $a137_extra_constraint$
    DECLARE
      rejected BOOLEAN := FALSE;
      failure TEXT;
    BEGIN
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('tenant constraint count drifted' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected extra-constraint error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'A137 extra constraint unexpectedly synchronized'; END IF;
      INSERT INTO a137_topology_result VALUES ('extraConstraint', TRUE, jsonb_build_object('error', failure));
    END $a137_extra_constraint$;
    ALTER TABLE ${quoteIdentifier(topology.schema)}.md_customer
      DROP CONSTRAINT a137_unknown_extra_check;

    ALTER TABLE public.md_customer
      ADD CONSTRAINT document_number_sequence_account_set_id_fkey
      FOREIGN KEY (id) REFERENCES public.sys_account_set(id) NOT VALID;
    DO $a137_spoofed_exemption_name$
    DECLARE
      rejected BOOLEAN := FALSE;
      failure TEXT;
    BEGIN
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('tenant scope FK exemption runtime drifted' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected spoofed-exemption error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'A137 spoofed FK exemption name was silently skipped'; END IF;
      INSERT INTO a137_topology_result VALUES (
        'spoofedExemptionName', TRUE, jsonb_build_object('error', failure)
      );
    END $a137_spoofed_exemption_name$;
    ALTER TABLE public.md_customer
      DROP CONSTRAINT document_number_sequence_account_set_id_fkey;

    ALTER TABLE ${quoteIdentifier(topology.schema)}.md_customer ALTER COLUMN phone TYPE TEXT;
    DO $a137_type_drift$
    DECLARE
      rejected BOOLEAN := FALSE;
      failure TEXT;
    BEGIN
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('tenant column type drift' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected type-drift error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'A137 type drift unexpectedly synchronized'; END IF;
      INSERT INTO a137_topology_result VALUES ('typeDrift', TRUE, jsonb_build_object('error', failure));
    END $a137_type_drift$;
    ALTER TABLE ${quoteIdentifier(topology.schema)}.md_customer ALTER COLUMN phone TYPE VARCHAR(80);

    INSERT INTO ${quoteIdentifier(topology.schema)}.md_product_category (id, code, name)
    VALUES (${uuidLiteral(topology.categoryId)}, 'A137-CATEGORY', 'A137 temporary category');
    INSERT INTO ${quoteIdentifier(topology.schema)}.md_unit (id, code, name)
    VALUES (${uuidLiteral(topology.unitId)}, 'A137-UNIT', 'A137 temporary unit');
    ALTER TABLE ${quoteIdentifier(topology.schema)}.md_product
      DROP CONSTRAINT fk_md_product_default_supplier_ref;
    INSERT INTO ${quoteIdentifier(topology.schema)}.md_product (
      id, code, name, unit, category, system_no, product_category_id, unit_id, default_supplier_id
    ) VALUES (
      ${uuidLiteral(topology.productId)}, 'A137-ORPHAN', 'A137 orphan topology', 'A137-UNIT', 'A137-CATEGORY',
      ${-(tokenNumber + 20)}, ${uuidLiteral(topology.categoryId)}, ${uuidLiteral(topology.unitId)}, ${uuidLiteral(topology.missingSupplierId)}
    );
    DO $a137_orphan$
    DECLARE
      rejected BOOLEAN := FALSE;
      failure TEXT;
    BEGIN
      BEGIN
        PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      EXCEPTION WHEN OTHERS THEN
        failure := SQLERRM;
        IF position('tenant FK orphan preflight failed' IN failure) = 0 THEN
          RAISE EXCEPTION 'A137 unexpected orphan-preflight error: %', failure;
        END IF;
        rejected := TRUE;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'A137 orphan unexpectedly synchronized'; END IF;
      INSERT INTO a137_topology_result VALUES ('orphan', TRUE, jsonb_build_object('error', failure));
    END $a137_orphan$;
    DELETE FROM ${quoteIdentifier(topology.schema)}.md_product WHERE id = ${uuidLiteral(topology.productId)};
    DO $a137_repair_orphan$
    BEGIN
      PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
      PERFORM public.jdy_sync_tenant_schema(${sqlLiteral(topology.schema)}, FALSE);
    END $a137_repair_orphan$;
    DELETE FROM ${quoteIdentifier(topology.schema)}.md_product_category WHERE id = ${uuidLiteral(topology.categoryId)};
    DELETE FROM ${quoteIdentifier(topology.schema)}.md_unit WHERE id = ${uuidLiteral(topology.unitId)};

    INSERT INTO a137_topology_result
    SELECT 'repairedTopology', TRUE, jsonb_build_object('metrics', metrics.metric)
    FROM (SELECT (${schemaMetricsSql(topology.schema)})::jsonb AS metric) metrics;

    SELECT jsonb_object_agg(check_name, jsonb_build_object('ok', ok) || detail ORDER BY check_name)::text
    FROM a137_topology_result;
    ROLLBACK;
  `;
  return sqlJson(sql);
}

function schemaMetricsSql(schema) {
  const schemaName = sqlLiteral(schema);
  const tenantScopeAccountSetTables = sqlTextArray(tenantScopeAccountSetChildren);
  return `
    WITH reference_columns AS (
      SELECT managed.table_name,
             attribute.attname AS column_name,
             format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
             attribute.attnotnull AS not_null,
             pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression,
             attribute.attidentity AS identity_kind,
             attribute.attgenerated AS generated_kind
      FROM public.sys_tenant_managed_table managed
      JOIN pg_class relation ON relation.oid = to_regclass(format('public.%I', managed.table_name))
      JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
    ),
    target_columns AS (
      SELECT managed.table_name,
             attribute.attname AS column_name,
             format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
             attribute.attnotnull AS not_null,
             pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression,
             attribute.attidentity AS identity_kind,
             attribute.attgenerated AS generated_kind
      FROM public.sys_tenant_managed_table managed
      JOIN pg_class relation ON relation.oid = to_regclass(format('%I.%I', ${schemaName}, managed.table_name))
      JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
    ),
    column_mismatches AS (
      SELECT COALESCE(reference.table_name, target.table_name) AS table_name,
             COALESCE(reference.column_name, target.column_name) AS column_name,
             reference.data_type AS expected_type,
             target.data_type AS actual_type,
             reference.not_null AS expected_not_null,
             target.not_null AS actual_not_null,
             reference.default_expression AS expected_default,
             target.default_expression AS actual_default
      FROM reference_columns reference
      FULL JOIN target_columns target USING (table_name, column_name)
      WHERE reference.table_name IS NULL
         OR target.table_name IS NULL
         OR reference.data_type IS DISTINCT FROM target.data_type
         OR reference.not_null IS DISTINCT FROM target.not_null
         OR reference.default_expression IS DISTINCT FROM target.default_expression
         OR reference.identity_kind IS DISTINCT FROM target.identity_kind
         OR reference.generated_kind IS DISTINCT FROM target.generated_kind
    ),
    reference_constraints AS (
      SELECT child.relname AS child_table,
             constraint_row.contype,
             pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN public.sys_tenant_managed_table managed ON managed.table_name = child.relname
      WHERE child_namespace.nspname = 'public'
        AND constraint_row.contype IN ('p', 'u', 'c')
    ),
    target_constraints AS (
      SELECT child.relname AS child_table,
             constraint_row.contype,
             pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN public.sys_tenant_managed_table managed ON managed.table_name = child.relname
      WHERE child_namespace.nspname = ${schemaName}
        AND constraint_row.contype IN ('p', 'u', 'c')
    ),
    reference_fk_all AS (
      SELECT constraint_row.conname AS constraint_name,
             child.relname AS child_table,
             parent.relname AS parent_table,
             parent_namespace.nspname AS source_parent_schema,
             CASE WHEN managed_parent.table_name IS NULL THEN 'public' ELSE ${schemaName} END AS expected_parent_schema,
             ARRAY(
               SELECT attribute.attname::TEXT
               FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key_column.attnum
               ORDER BY key_column.ordinality
             ) AS child_columns,
             ARRAY(
               SELECT attribute.attname::TEXT
               FROM unnest(constraint_row.confkey) WITH ORDINALITY key_column(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = constraint_row.confrelid
                AND attribute.attnum = key_column.attnum
               ORDER BY key_column.ordinality
             ) AS parent_columns,
             constraint_row.confmatchtype,
             constraint_row.confupdtype,
             constraint_row.confdeltype,
             constraint_row.condeferrable,
             constraint_row.condeferred
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = constraint_row.confrelid
      JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
      JOIN public.sys_tenant_managed_table managed_child ON managed_child.table_name = child.relname
      LEFT JOIN public.sys_tenant_managed_table managed_parent ON managed_parent.table_name = parent.relname
      WHERE child_namespace.nspname = 'public'
        AND constraint_row.contype = 'f'
    ),
    reference_fk AS (
      SELECT *
      FROM reference_fk_all
      WHERE NOT (
        (child_table, constraint_name) IN (
          ('document_number_sequence', 'document_number_sequence_account_set_id_fkey'),
          ('inv_stock_balance', 'inv_stock_balance_account_set_id_fkey'),
          ('inv_stock_opening', 'inv_stock_opening_account_set_id_fkey'),
          ('inv_stock_txn', 'inv_stock_txn_account_set_id_fkey')
        )
        AND source_parent_schema = 'public'
        AND parent_table = 'sys_account_set'
        AND child_columns = ARRAY['account_set_id']::TEXT[]
        AND parent_columns = ARRAY['id']::TEXT[]
      )
    ),
    target_fk AS (
      SELECT constraint_row.conname AS constraint_name,
             child.relname AS child_table,
             parent.relname AS parent_table,
             parent_namespace.nspname AS parent_schema,
             ARRAY(
               SELECT attribute.attname::TEXT
               FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = constraint_row.conrelid
                AND attribute.attnum = key_column.attnum
               ORDER BY key_column.ordinality
             ) AS child_columns,
             ARRAY(
               SELECT attribute.attname::TEXT
               FROM unnest(constraint_row.confkey) WITH ORDINALITY key_column(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = constraint_row.confrelid
                AND attribute.attnum = key_column.attnum
               ORDER BY key_column.ordinality
             ) AS parent_columns,
             constraint_row.confmatchtype,
             constraint_row.confupdtype,
             constraint_row.confdeltype,
             constraint_row.condeferrable,
             constraint_row.condeferred,
             constraint_row.convalidated
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = constraint_row.confrelid
      JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
      JOIN public.sys_tenant_managed_table managed_child ON managed_child.table_name = child.relname
      WHERE child_namespace.nspname = ${schemaName}
        AND constraint_row.contype = 'f'
    )
    SELECT jsonb_build_object(
      'schema', ${schemaName},
      'baseTables', (
        SELECT count(*) FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ${schemaName} AND relation.relkind IN ('r', 'p')
      ),
      'managedTables', (
        SELECT count(*) FROM public.sys_tenant_managed_table managed
        WHERE to_regclass(format('%I.%I', ${schemaName}, managed.table_name)) IS NOT NULL
      ),
      'primaryKeys', (SELECT count(*) FROM target_constraints WHERE contype = 'p'),
      'uniqueConstraints', (SELECT count(*) FROM target_constraints WHERE contype = 'u'),
      'checkConstraints', (SELECT count(*) FROM target_constraints WHERE contype = 'c'),
      'foreignKeys', (SELECT count(*) FROM target_fk),
      'unvalidatedForeignKeys', (SELECT count(*) FROM target_fk WHERE NOT convalidated),
      'columnMismatchCount', (SELECT count(*) FROM column_mismatches),
      'columnMismatchDetails', (
        SELECT COALESCE(jsonb_agg(to_jsonb(sample) ORDER BY sample.table_name, sample.column_name), '[]'::jsonb)
        FROM (SELECT * FROM column_mismatches ORDER BY table_name, column_name LIMIT 20) sample
      ),
      'referenceConstraintMismatchCount', (
        SELECT count(*) FROM reference_constraints reference
        WHERE NOT EXISTS (
          SELECT 1 FROM target_constraints target
          WHERE target.child_table = reference.child_table
            AND target.contype = reference.contype
            AND target.definition = reference.definition
        )
      ),
      'referenceForeignKeyCount', (SELECT count(*) FROM reference_fk),
      'referenceForeignKeyMismatchCount', (
        SELECT count(*) FROM reference_fk reference
        WHERE NOT EXISTS (
          SELECT 1 FROM target_fk target
          WHERE target.child_table = reference.child_table
            AND target.parent_table = reference.parent_table
            AND target.parent_schema = reference.expected_parent_schema
            AND target.child_columns = reference.child_columns
            AND target.parent_columns = reference.parent_columns
            AND target.confmatchtype = reference.confmatchtype
            AND target.confupdtype = reference.confupdtype
            AND target.confdeltype = reference.confdeltype
            AND target.condeferrable = reference.condeferrable
            AND target.condeferred = reference.condeferred
            AND target.convalidated
        )
      ),
      'retiredTaxColumns', (
        SELECT count(*) FROM target_columns
        WHERE column_name = 'is_tax_inclusive'
          AND table_name = ANY (ARRAY[
            'sales_quote', 'sales_order', 'delivery_notice', 'sales_out',
            'purchase_order', 'purchase_in', 'purchase_return'
          ]::TEXT[])
      ),
      'forbiddenAccountSetForeignKeys', (
        SELECT count(*) FROM target_fk
        WHERE child_table = ANY (${tenantScopeAccountSetTables})
          AND parent_schema = 'public'
          AND parent_table = 'sys_account_set'
          AND child_columns = ARRAY['account_set_id']::TEXT[]
      )
    )::text
  `;
}

function assertMetrics(label, metrics) {
  assert(metrics && typeof metrics === "object", `${label} metrics are missing`);
  for (const [field, expected] of Object.entries(expectedMetrics)) {
    assert(
      Number(metrics[field]) === expected,
      `${label} ${field}: expected=${expected} actual=${metrics[field]} details=${JSON.stringify(metrics.columnMismatchDetails ?? [])}`
    );
  }
}

function tenantFingerprints(schema) {
  return {
    schema: dumpFingerprint(schema, "--schema-only"),
    data: dumpFingerprint(schema, "--data-only")
  };
}

function dumpFingerprint(schema, mode) {
  const raw = execFileSync(
    "docker",
    [
      "exec", container, "pg_dump", "-U", databaseUser, "-d", database,
      `--schema=${schema}`, mode, "--no-owner", "--no-privileges"
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const normalized = raw
    .replace(/^\\restrict [^\r\n]*$/gm, "\\restrict <normalized>")
    .replace(/^\\unrestrict [^\r\n]*$/gm, "\\unrestrict <normalized>");
  return {
    sha256: createHash("sha256").update(normalized).digest("hex"),
    bytes: Buffer.byteLength(normalized)
  };
}

function assertFingerprints(schema, before, after, phase) {
  assert(
    before.schema.sha256 === after.schema.sha256,
    `${schema} schema fingerprint changed during ${phase}: ${before.schema.sha256} -> ${after.schema.sha256}`
  );
  assert(
    before.data.sha256 === after.data.sha256,
    `${schema} data fingerprint changed during ${phase}: ${before.data.sha256} -> ${after.data.sha256}`
  );
}

function verifyCleanup() {
  return sqlJson(`
    SELECT jsonb_build_object(
      'temporaryAccountSets', (
        SELECT count(*) FROM public.sys_account_set
        WHERE code = ANY (${sqlTextArray([
          topology.accountCode,
          topology.missingAccountCode,
          topology.unsafeAccountCode
        ])})
      ),
      'temporarySchemas', (
        SELECT count(*) FROM pg_namespace
        WHERE nspname = ANY (${sqlTextArray([
          topology.schema,
          topology.missingSchema,
          topology.unregisteredSchema,
          topology.unsafeSchema
        ])})
      ),
      'temporaryCustomers', (
        SELECT
          (SELECT count(*) FROM ${quoteIdentifier(expectedSchemas[0])}.md_customer WHERE code = ${sqlLiteral(fixtureCode)})
          +
          (SELECT count(*) FROM ${quoteIdentifier(expectedSchemas[1])}.md_customer WHERE code = ${sqlLiteral(fixtureCode)})
      ),
      'invalidForeignKeyRows', (
        SELECT count(*) FROM ${quoteIdentifier(expectedSchemas[0])}.stock_count_line
        WHERE id = ${uuidLiteral(enforcement.invalidLineId)}
      ),
      'invalidCheckRows', (
        SELECT count(*) FROM ${quoteIdentifier(expectedSchemas[0])}.sys_operation_log
        WHERE id = ${uuidLiteral(enforcement.invalidLogId)}
      )
    )::text
  `);
}

function assertCleanup(cleanup) {
  assert(cleanup && typeof cleanup === "object", "cleanup verification is missing");
  for (const [name, value] of Object.entries(cleanup)) {
    assert(Number(value) === 0, `A137 cleanup failed: ${name}=${value}`);
  }
}

function sqlScalar(statement) {
  return execFileSync(
    "docker",
    [
      "exec", container, "psql", "-X", "-U", databaseUser, "-d", database,
      "-v", "ON_ERROR_STOP=1", "-tAq", "-c", statement
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  ).trim();
}

function sqlJson(statement) {
  const raw = sqlScalar(statement);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  assert(lines.length > 0, "SQL query returned no JSON result");
  return JSON.parse(lines.at(-1));
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function uuidLiteral(value) {
  return `${sqlLiteral(value)}::UUID`;
}

function quoteIdentifier(value) {
  const normalized = String(value);
  assert(/^[a-z_][a-z0-9_]*$/.test(normalized), `unsafe SQL identifier: ${normalized}`);
  return `"${normalized}"`;
}

function sqlTextArray(values) {
  return `ARRAY[${values.map(sqlLiteral).join(", ")}]::TEXT[]`;
}

function flywayChecksum(source) {
  let crc = 0xffffffff;
  const normalized = source.replace(/^\uFEFF/, "");
  for (const line of normalized.split(/\r?\n/)) {
    for (const byte of Buffer.from(line, "utf8")) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    }
  }
  return (crc ^ 0xffffffff) | 0;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorText(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stdout = error.stdout ? `\nstdout:\n${String(error.stdout).slice(-8000)}` : "";
  const stderr = error.stderr ? `\nstderr:\n${String(error.stderr).slice(-8000)}` : "";
  return `${error.stack ?? error.message}${stdout}${stderr}`;
}
