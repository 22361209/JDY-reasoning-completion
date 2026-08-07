import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const VERSIONED_MIGRATION = /^V([1-9]\d*)__.+\.sql$/;
const PUBLISHED_MIGRATIONS = Object.freeze([
  Object.freeze({ version: "105", script: "V105__numbering_rule_reliability.sql", checksum: -848130561 }),
  Object.freeze({ version: "106", script: "V106__inventory_source_trace.sql", checksum: 1207842815 }),
  Object.freeze({ version: "107", script: "V107__inventory_source_trace_reaudit_fix.sql", checksum: 1245463618 }),
  Object.freeze({ version: "108", script: "V108__production_material_scrap.sql", checksum: 32021494 }),
  Object.freeze({ version: "109", script: "V109__cash_transfer_document.sql", checksum: -1955046012 }),
  Object.freeze({ version: "110", script: "V110__production_plan_multi_line.sql", checksum: 1117782105 }),
  Object.freeze({ version: "111", script: "V111__multilevel_production_purchase_planning.sql", checksum: 1195966262 }),
  Object.freeze({ version: "112", script: "V112__recalculate_purchase_plan_reservations.sql", checksum: -1613216154 }),
  Object.freeze({ version: "113", script: "V113__recalculate_backup_purchase_plan_reservations.sql", checksum: -1592974444 })
]);
const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
}));

export async function currentMigrationHead(migrationDir) {
  const migrations = await versionedMigrations(migrationDir);
  await assertPublishedMigrationSourcesFromManifest(migrationDir, migrations);

  const head = migrations.at(-1);
  return Object.freeze({
    version: String(head.version),
    versionNumber: head.version,
    script: head.script,
    sourceScripts: Object.freeze(migrations.map((migration) => migration.script))
  });
}

export async function assertPublishedMigrationSources(migrationDir) {
  const migrations = await versionedMigrations(migrationDir);
  return assertPublishedMigrationSourcesFromManifest(migrationDir, migrations);
}

export function assertPublishedMigrationHistory(history, label = "migration history") {
  if (!Array.isArray(history)) {
    throw new Error(`${label} must be an array`);
  }

  const verified = {};
  for (const published of PUBLISHED_MIGRATIONS) {
    const rows = history.filter((row) => String(row?.version) === published.version);
    if (rows.length !== 1) {
      throw new Error(`${label} must contain published V${published.version} exactly once: ${JSON.stringify(rows)}`);
    }
    const [row] = rows;
    if (row.success !== true) {
      throw new Error(`${label} published V${published.version} is not successful: ${JSON.stringify(row)}`);
    }
    if (row.script !== published.script) {
      throw new Error(`${label} published V${published.version} script changed: expected=${published.script} actual=${row.script}`);
    }
    if (!Number.isInteger(Number(row.checksum)) || Number(row.checksum) !== published.checksum) {
      throw new Error(`${label} published V${published.version} checksum changed: expected=${published.checksum} actual=${row.checksum}`);
    }
    verified[`v${published.version}`] = row;
  }
  return Object.freeze(verified);
}

async function versionedMigrations(migrationDir) {
  const migrations = (await readdir(migrationDir))
    .map((script) => {
      const match = script.match(VERSIONED_MIGRATION);
      return match ? { script, version: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.version - right.version || left.script.localeCompare(right.script));

  if (migrations.length === 0) {
    throw new Error(`no versioned migrations found in ${migrationDir}`);
  }

  const duplicate = migrations.find((migration, index) => index > 0 && migrations[index - 1].version === migration.version);
  if (duplicate) {
    throw new Error(`duplicate migration version V${duplicate.version} in ${migrationDir}`);
  }

  return migrations;
}

async function assertPublishedMigrationSourcesFromManifest(migrationDir, migrations) {
  const verified = [];
  for (const published of PUBLISHED_MIGRATIONS) {
    const migration = migrations.find((candidate) => String(candidate.version) === published.version);
    if (!migration) {
      throw new Error(`published migration V${published.version} is missing from ${migrationDir}`);
    }
    if (migration.script !== published.script) {
      throw new Error(`published migration V${published.version} script changed: expected=${published.script} actual=${migration.script}`);
    }
    const source = await readFile(path.join(migrationDir, migration.script), "utf8");
    const checksum = flywayChecksum(source);
    if (checksum !== published.checksum) {
      throw new Error(`published migration V${published.version} source checksum changed: expected=${published.checksum} actual=${checksum}`);
    }
    verified.push(Object.freeze({ ...published, sourceChecksum: checksum }));
  }
  return Object.freeze(verified);
}

function flywayChecksum(source) {
  let crc = 0xffffffff;
  const normalized = source.replace(/^\uFEFF/, "");
  for (const line of normalized.split(/\r?\n/)) {
    for (const byte of Buffer.from(line, "utf8")) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    }
  }
  return (crc ^ 0xffffffff) | 0;
}
