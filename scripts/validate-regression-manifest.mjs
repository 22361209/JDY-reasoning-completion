import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestRelativePath = "config/regression-manifest.json";

export async function loadRegressionManifest(rootDir) {
  const manifestPath = path.join(rootDir, manifestRelativePath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const errors = [];

  if (manifest.version !== 1) {
    errors.push(`version must be 1, got ${JSON.stringify(manifest.version)}`);
  }

  const full = validateScriptList("full", manifest.full, errors);
  const smoke = validateScriptList("smoke", manifest.smoke, errors);
  const areas = validateAreas(manifest.areas, errors);
  const exemptions = validateExemptions(manifest.exemptions, errors);

  const discovered = (await readdir(path.join(rootDir, "scripts"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith("-regression.mjs"))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
  const discoveredSet = new Set(discovered);
  const fullSet = new Set(full);
  const exemptionSet = new Set(exemptions.map((entry) => entry.script));

  for (const script of full) {
    if (!discoveredSet.has(script)) {
      errors.push(`full references missing regression script: ${script}`);
    }
    if (exemptionSet.has(script)) {
      errors.push(`script cannot be both full and exempt: ${script}`);
    }
  }

  for (const script of smoke) {
    if (!fullSet.has(script)) {
      errors.push(`smoke script must also be registered in full: ${script}`);
    }
  }

  for (const [area, scripts] of Object.entries(areas)) {
    for (const script of scripts) {
      if (!fullSet.has(script)) {
        errors.push(`area:${area} script must also be registered in full: ${script}`);
      }
    }
  }

  for (const exemption of exemptions) {
    if (!discoveredSet.has(exemption.script)) {
      errors.push(`exemption references missing regression script: ${exemption.script}`);
    }
  }

  for (const script of discovered) {
    if (!fullSet.has(script) && !exemptionSet.has(script)) {
      errors.push(`unregistered regression script: ${script}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Regression manifest validation failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    manifest,
    summary: {
      manifest: manifestRelativePath,
      discoveredCount: discovered.length,
      fullCount: full.length,
      smokeCount: smoke.length,
      areaCounts: Object.fromEntries(Object.entries(areas).map(([area, scripts]) => [area, scripts.length])),
      exemptionCount: exemptions.length
    }
  };
}

function validateAreas(value, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("areas must be an object of script arrays");
    return {};
  }
  const areas = {};
  for (const [area, scripts] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(area)) {
      errors.push(`invalid area name: ${JSON.stringify(area)}`);
    }
    areas[area] = validateScriptList(`areas.${area}`, scripts, errors);
  }
  return areas;
}

function validateScriptList(label, value, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  const scripts = [];
  const seen = new Set();
  for (const script of value) {
    if (typeof script !== "string" || !/^scripts\/[A-Za-z0-9._-]+-regression\.mjs$/.test(script)) {
      errors.push(`${label} contains an invalid regression script path: ${JSON.stringify(script)}`);
      continue;
    }
    if (seen.has(script)) {
      errors.push(`${label} contains duplicate script: ${script}`);
      continue;
    }
    seen.add(script);
    scripts.push(script);
  }
  return scripts;
}

function validateExemptions(value, errors) {
  if (!Array.isArray(value)) {
    errors.push("exemptions must be an array");
    return [];
  }
  const exemptions = [];
  const seen = new Set();
  for (const exemption of value) {
    if (!exemption || typeof exemption !== "object" || Array.isArray(exemption)) {
      errors.push(`invalid exemption: ${JSON.stringify(exemption)}`);
      continue;
    }
    const script = exemption.script;
    const reason = exemption.reason;
    if (typeof script !== "string" || !/^scripts\/[A-Za-z0-9._-]+-regression\.mjs$/.test(script)) {
      errors.push(`exemption has an invalid regression script path: ${JSON.stringify(script)}`);
      continue;
    }
    if (seen.has(script)) {
      errors.push(`duplicate exemption: ${script}`);
      continue;
    }
    if (typeof reason !== "string" || reason.trim().length < 12) {
      errors.push(`exemption reason is missing or too short: ${script}`);
      continue;
    }
    seen.add(script);
    exemptions.push({ script, reason: reason.trim() });
  }
  return exemptions;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(import.meta.dirname, "..");
  try {
    const { summary } = await loadRegressionManifest(rootDir);
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
