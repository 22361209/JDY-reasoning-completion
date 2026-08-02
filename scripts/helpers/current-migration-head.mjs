import { readdir } from "node:fs/promises";

const VERSIONED_MIGRATION = /^V([1-9]\d*)__.+\.sql$/;

export async function currentMigrationHead(migrationDir) {
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

  const head = migrations.at(-1);
  return Object.freeze({
    version: String(head.version),
    versionNumber: head.version,
    script: head.script,
    sourceScripts: Object.freeze(migrations.map((migration) => migration.script))
  });
}
