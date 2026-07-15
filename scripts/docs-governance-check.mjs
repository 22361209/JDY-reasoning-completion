import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(rootDir, "docs");
const errors = [];

function expect(condition, message) {
  if (!condition) errors.push(message);
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await markdownFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(filePath);
    }
  }
  return files;
}

function parseFrontmatter(source, label) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  expect(Boolean(match), `${label} must start with YAML frontmatter`);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function integerInRange(value, key, minimum, maximum) {
  const parsed = Number(value);
  expect(Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum, `${key} must be an integer in ${minimum}..${maximum}`);
}

async function checkCurrentLinks() {
  const currentFiles = (await markdownFiles(docsDir)).filter((filePath) => (
    !filePath.includes(`${path.sep}archive${path.sep}`)
    && !filePath.includes(`${path.sep}验收报告${path.sep}`)
  ));
  const markdownLink = /\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)/g;
  for (const filePath of currentFiles) {
    const source = await readFile(filePath, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      markdownLink.lastIndex = 0;
      let match;
      while ((match = markdownLink.exec(line))) {
        const target = match[1];
        if (/^(https?:|mailto:|\/)/.test(target)) continue;
        try {
          await access(path.resolve(path.dirname(filePath), target));
        } catch {
          errors.push(`${path.relative(rootDir, filePath)}:${index + 1} links to missing ${target}`);
        }
      }
    }
  }
  return currentFiles.length;
}

async function checkTaskAndSnapshot() {
  const taskPath = path.join(docsDir, "12-当前批次验收清单.md");
  const snapshotPath = path.join(docsDir, "09-交接清单.md");
  const [taskSource, snapshotSource] = await Promise.all([readFile(taskPath, "utf8"), readFile(snapshotPath, "utf8")]);
  const task = parseFrontmatter(taskSource, "current task");
  const snapshot = parseFrontmatter(snapshotSource, "current snapshot");
  for (const key of ["taskKind", "roadmapItemIds", "roadmapGateId"]) {
    expect(task[key] === snapshot[key], `docs/09 and docs/12 must share ${key}`);
  }
  expect(["roadmap", "governance"].includes(task.taskKind), "taskKind must be roadmap or governance");
  if (task.taskKind === "governance") {
    expect(task.roadmapItemIds === "[]" && task.roadmapGateId === "null", "governance task must use an empty roadmap coordinate");
  } else {
    expect((task.roadmapItemIds !== "[]") !== (task.roadmapGateId !== "null"), "roadmap task must declare exactly one roadmap coordinate");
  }

  if (task.taskState === "idle") {
    expect(task.taskId === "null", "idle task must use taskId: null");
    return "idle";
  }

  expect(task.taskState === "in_progress", "active task must use taskState: in_progress");
  expect(task.taskId && task.taskId !== "null", "active task must declare taskId");
  expect(task.title && task.title !== "无活动任务", "active task must declare a title");
  integerInRange(task.timeBudgetMinutes, "timeBudgetMinutes", 1, 300);
  integerInRange(task.goalTokenBudget, "goalTokenBudget", 1, 15000000);
  integerInRange(task.maxCommits, "maxCommits", 1, 10);
  integerInRange(task.maxConcurrentSubagents, "maxConcurrentSubagents", 0, 3);
  integerInRange(task.maxTotalSubagents, "maxTotalSubagents", 0, 6);
  integerInRange(task.maxFullGateRuns, "maxFullGateRuns", 0, 1);
  expect(Number(task.maxTotalSubagents) >= Number(task.maxConcurrentSubagents), "maxTotalSubagents must not be smaller than maxConcurrentSubagents");
  expect(task.outOfScopePolicy === "record-and-stop", "active task must use outOfScopePolicy: record-and-stop");
  for (const heading of ["目标", "允许路径", "明确不做", "验收"]) {
    expect(new RegExp(`^## ${heading}`, "m").test(taskSource), `active task must contain ## ${heading}`);
  }
  expect(taskSource.includes("停止条件"), "active task must declare stopping conditions");
  expect(taskSource.includes("JDY"), "active task must declare whether JDY is a reference");
  expect(snapshotSource.includes(task.taskId) && snapshotSource.includes(task.title), "current snapshot must name the active task");
  return "active";
}

async function checkTopLevelNumbering() {
  const seen = new Map();
  for (const entry of await readdir(docsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const match = entry.name.match(/^(\d{2})-/);
    if (!match) continue;
    const prior = seen.get(match[1]);
    expect(!prior, `duplicate top-level document number ${match[1]}: ${prior} and ${entry.name}`);
    seen.set(match[1], entry.name);
  }
}

async function checkHistoricalMarkers() {
  for (const relativePath of [
    "docs/guides/new-project-migration-blueprint.md",
    "docs/guides/bill-metadata-roadmap.md",
  ]) {
    const source = await readFile(path.join(rootDir, relativePath), "utf8");
    const frontmatter = parseFrontmatter(source, relativePath);
    expect(frontmatter.status === "historical", `${relativePath} must be marked historical`);
    expect(frontmatter.supersededBy === "ADR-015", `${relativePath} must name ADR-015 as superseding decision`);
  }
}

async function checkReportIndex() {
  const reportDir = path.join(docsDir, "验收报告");
  const indexPath = path.join(reportDir, "README.md");
  const reportNames = (await readdir(reportDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name)
    .sort();
  const indexSource = await readFile(indexPath, "utf8");
  const index = parseFrontmatter(indexSource, "acceptance report index");
  const digest = createHash("sha256").update(reportNames.join("\n")).digest("hex");
  expect(Number(index.reportCount) === reportNames.length, `report index count must equal ${reportNames.length}`);
  expect(index.reportFileListSha256 === digest, "report index filename hash is stale");
  for (const name of [
    "验收报告-A144-6E报表与当前错误入口-20260714.md",
    "验收报告-A155-当前真相源重置-20260716.md",
    "验收报告-A156-文档导航与架构一致性-20260716.md",
  ]) {
    expect(reportNames.includes(name), `required governance report is missing: ${name}`);
    expect(indexSource.includes(name), `report index must link ${name}`);
  }
  return { reportCount: reportNames.length, reportFileListSha256: digest };
}

try {
  const [currentDocCount, taskState, reportIndex] = await Promise.all([
    checkCurrentLinks(),
    checkTaskAndSnapshot(),
    checkReportIndex(),
    checkTopLevelNumbering(),
    checkHistoricalMarkers(),
  ]);
  expect(currentDocCount > 0, "current document set cannot be empty");
  expect(await stat(path.join(docsDir, "README.md")).then(() => true, () => false), "docs/README.md is required");
  if (errors.length > 0) throw new Error(`Documentation governance check failed:\n- ${errors.join("\n- ")}`);
  console.log(JSON.stringify({ ok: true, currentDocCount, taskState, ...reportIndex }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
