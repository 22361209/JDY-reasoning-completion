#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadRegressionManifest } from "./validate-regression-manifest.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a153-6e-closure-regression.json");
const finalReportPath = "docs/验收报告/验收报告-A144-6E报表与当前错误入口-20260714.md";
const a153BrowserRunnerSha256 = "419bc5ac15c75313f41238818ebee2677681ad2d1390433231c119859301bade";
const a153PublicationConsumerRule = "VERIFY_LOCK_ABSENT_AND_MARKER_FORMAL_FAULT_JSON_SHA256_AND_BUNDLE_SHA256_BEFORE_USE";
const a153CommitMarkerClosure = "MARKER_RENAMED_VERIFIED_UNDER_LOCK__ALL_QUARANTINE_AND_TRANSACTION_RESIDUE_ZERO__LOCK_RELEASED_FOR_CONSUMPTION";
const a153FormalBundleProtocol = "PROMOTE_FORMAL_AND_22_SCREENSHOTS_AND_VERIFY_FIXED_FAULT__ATOMIC_MARKER_RENAME_AND_READBACK_UNDER_LOCK__ZERO_ALL_BACKUP_JOURNAL_CANDIDATE_RESIDUE__FINAL_BUNDLE_READBACK__RELEASE_LOCK_TO_PUBLISH";
const a153EvidenceBaseKeys = [
  "taskId", "runId", "generatedAt", "status", "ok", "gitHead", "faultInjection",
  "environment", "coverageScope", "fixture", "assertions", "catalog", "reports", "specials",
  "permissions", "tenantIsolation", "browserDiagnostics", "screenshots", "screenshotHashes",
  "cleanup", "summary", "failure", "completedAt"
];
const a153CleanupBaseKeys = [
  "attempted", "authorized", "logouts", "downloadsDeleted", "downloads", "screenshots", "redis",
  "redisGlobalGuard", "authMutations", "processes", "lockReleased", "residue", "residueTotal",
  "errors", "database", "ownershipStages", "setupOwnershipReconciliation", "profile"
];
const a153BundleKeys = [
  "transactionId", "protocol", "lockHeldThroughFormalJsonAndScreenshotVerification",
  "lockHeldThroughMarkerRenameAndReadbackVerification", "consumerRequiresMarkerAndAbsentLock",
  "rollbackOnPromotionOrLockReleaseFailure", "expectedFormalJson", "expectedFaultJson",
  "expectedFaultJsonSha256", "expectedCommitMarker", "expectedScreenshots",
  "backupsRetainedUntilMarkerReadbackVerification", "backupsRetainedThroughLockRelease",
  "expectedBackupRemainingAfterRelease"
];
const paths = {
  finalReport: finalReportPath,
  reportProtocol: "docs/guides/report-query-protocol.md",
  lifecycleProtocol: "docs/guides/bill-lifecycle-unification-protocol.md",
  deliveryStatus: "config/feature-delivery-status.json",
  roadmap: "config/remediation-roadmap.json",
  manifest: "config/regression-manifest.json",
  catalog: "frontend/src/modules/catalog.ts",
  reportRegistry: "frontend/src/modules/reports/reportRegistry.ts",
  metadataGate: "scripts/a115-metadata-definition-regression.mjs"
};
const archivedReplayControlledPaths = [...new Set([
  ...Object.values(paths),
  "docs/09-交接清单.md",
  "docs/12-当前批次验收清单.md",
  "scripts/a144-6e-contract-regression.mjs",
  "scripts/a148-inventory-movement-report-regression.mjs",
  "scripts/a149-sales-report-regression.mjs",
  "scripts/a150-finance-report-regression.mjs",
  "scripts/a152-material-scrap-ui-regression.mjs",
  "scripts/a153-6e-closure-regression.mjs"
])];
const checks = [];

function read(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  checks.push(message);
}

function contains(source, pattern, message) {
  assert(pattern.test(source), message);
}

function excludes(source, pattern, message) {
  assert(!pattern.test(source), message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trimEnd();
}

function verifyArchivedReplaySourceState() {
  let head;
  try {
    head = gitOutput(["rev-parse", "--verify", "HEAD"]);
    gitOutput(["ls-files", "--error-unmatch", "--", finalReportPath]);
    gitOutput(["ls-files", "--error-unmatch", "--", "scripts/a153-6e-closure-regression.mjs"]);
  } catch (error) {
    throw new Error(`A153 archived replay 只允许已提交且受跟踪的 closure/report: ${error.message}`);
  }
  const dirty = gitOutput([
    "status", "--porcelain=v1", "--untracked-files=all", "--", ...archivedReplayControlledPaths
  ]);
  assert(dirty === "", `A153 archived replay 只允许受控文件与 HEAD 完全一致: ${dirty}`);
  return { head, controlledPaths: archivedReplayControlledPaths.length };
}

function formalBundleHash(formalJsonSha256, faultJsonSha256, screenshotHashes) {
  const orderedHashes = Object.fromEntries(
    Object.entries(screenshotHashes).sort(([left], [right]) => left.localeCompare(right))
  );
  return sha256(JSON.stringify({ formalJsonSha256, faultJsonSha256, screenshotHashes: orderedHashes }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertExactKeys(value, expectedKeys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} 必须是 object`);
  assert(
    same(Object.keys(value).sort(), [...expectedKeys].sort()),
    `${label} 必须只包含 ${expectedKeys.join(", ")}`
  );
}

function assertAllNumericLeavesZero(value, label) {
  const nonZero = [];
  const visit = (current, currentPath) => {
    if (typeof current === "number") {
      if (current !== 0) nonZero.push({ path: currentPath, value: current });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) visit(entry, `${currentPath}.${key}`);
    }
  };
  visit(value, label);
  assert(nonZero.length === 0, `${label} 的所有数值残留必须为 0: ${JSON.stringify(nonZero)}`);
}

function collectA153RuntimeState(expectedScreenshotPaths) {
  const screenshotDirectory = path.join(verificationDir, "playwright");
  const verificationNames = existsSync(verificationDir) ? readdirSync(verificationDir) : [];
  const screenshotNames = existsSync(screenshotDirectory) ? readdirSync(screenshotDirectory) : [];
  const a153ScreenshotArtifacts = screenshotNames
    .filter((name) => /^a153-.*\.(?:png|jpe?g)$/i.test(name))
    .sort();
  const expectedScreenshotNames = expectedScreenshotPaths
    .map((relativePath) => path.basename(relativePath))
    .sort();
  return {
    lockPresent: existsSync(path.join(verificationDir, ".a153-browser-final.lock")),
    verificationTransaction: verificationNames.filter((name) =>
      /^\.a153-(?:result-stage|bundle|artifact)-|^a153-browser-.*\.json\.tmp-/.test(name)
    ).sort(),
    screenshotTransaction: screenshotNames.filter((name) =>
      /^\.a153-(?:candidate|backup|bundle)-/.test(name)
    ).sort(),
    failedEvidence: verificationNames.filter((name) =>
      /^a153-browser-(?:(?:fault-)?failed|bundle-failed|lock-release-failed)-\d+\.json$/.test(name)
    ).sort(),
    a153ScreenshotArtifacts,
    expectedScreenshotNames
  };
}

function assertA153ConsumerFence(label, expectedScreenshotPaths) {
  const state = collectA153RuntimeState(expectedScreenshotPaths);
  assert(!state.lockPresent, `${label}：A153 consumer 必须观察到 publication lock 已释放`);
  assert(state.verificationTransaction.length === 0, `${label}：verification transaction/quarantine residue 必须为 0`);
  assert(state.screenshotTransaction.length === 0, `${label}：screenshot transaction/quarantine residue 必须为 0`);
  assert(state.failedEvidence.length === 0, `${label}：failed evidence residue 必须为 0`);
  assert(
    same(state.a153ScreenshotArtifacts, state.expectedScreenshotNames),
    `${label}：必须精确观察到 22 张 A153 PNG 且无额外图片`
  );
  return state;
}

function assertRegularNonSymlinkFile(absolutePath, label) {
  const metadata = lstatSync(absolutePath);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} 必须是 regular non-symlink file`);
}

function verifyA153PngScreenshot(contents, expectedWidth, expectedHeight, label) {
  assert(Buffer.isBuffer(contents) && contents.length >= 45, `${label} 必须是非空且结构完整的 PNG`);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(contents.subarray(0, 8).equals(signature), `${label} 必须包含精确 PNG signature`);
  let offset = 8;
  let chunkIndex = 0;
  let sawIend = false;
  let width = null;
  let height = null;
  while (offset < contents.length) {
    assert(offset + 12 <= contents.length, `${label} PNG chunk header/trailer 必须完整`);
    const chunkLength = contents.readUInt32BE(offset);
    const chunkType = contents.subarray(offset + 4, offset + 8).toString("ascii");
    const nextOffset = offset + 12 + chunkLength;
    assert(nextOffset <= contents.length, `${label} PNG chunk 不得越过文件边界`);
    if (chunkIndex === 0) {
      assert(chunkType === "IHDR" && chunkLength === 13, `${label} 必须以唯一 13-byte IHDR chunk 开始`);
      width = contents.readUInt32BE(offset + 8);
      height = contents.readUInt32BE(offset + 12);
    }
    if (chunkType === "IEND") {
      assert(chunkLength === 0 && nextOffset === contents.length, `${label} 必须在 0-byte IEND chunk 精确结束`);
      sawIend = true;
      offset = nextOffset;
      break;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  assert(
    sawIend && width === expectedWidth && height === expectedHeight,
    `${label} IHDR 尺寸必须精确匹配 ${expectedWidth}x${expectedHeight}`
  );
}

function parseFinalEvidenceBlock(report) {
  const begin = "A153_FINAL_EVIDENCE_BEGIN";
  const end = "A153_FINAL_EVIDENCE_END";
  const occurrences = (source, token) => source.split(token).length - 1;
  excludes(report, /^ {0,3}(?:`{3,}|~{3,})/m, "最终报告不得包含 Markdown fenced-code 标记");
  excludes(report, /<!--|-->/, "最终报告不得包含 HTML comment token");
  excludes(report, /<\/?[A-Za-z][^>\n]*>/, "最终报告不得包含 HTML tag");
  excludes(report, /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i, "最终报告不得包含 HTML character entity");
  excludes(report, /!?\[[^\]\n]*\](?:\([^\)\n]*\)|\[[^\]\n]*\])/, "最终报告不得包含 Markdown link/image");
  excludes(report, /^ {0,3}\[[^\]\n]*\]:/m, "最终报告不得包含不可见 Markdown reference definition");
  assert(occurrences(report, begin) === 1, "最终报告必须且只能包含一个 A153 证据块起始标记");
  assert(occurrences(report, end) === 1, "最终报告必须且只能包含一个 A153 证据块结束标记");

  const escapedBegin = escapeRegExp(begin);
  const escapedEnd = escapeRegExp(end);
  const match = report.match(new RegExp(`^${escapedBegin}\\n([\\s\\S]*?)\\n${escapedEnd}$`, "m"));
  assert(Boolean(match), "A153 证据块标记必须从第 1 列独占整行且包含规范 JSON");
  const rawJson = match[1];
  let evidence;
  try {
    evidence = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`A153 证据块必须是严格 JSON: ${error.message}`);
  }
  assert(rawJson === JSON.stringify(evidence, null, 2), "A153 证据块必须使用规范 JSON，不得含重复 key、注释或隐藏值");

  const prose = report.replace(match[0], "");
  const visibleProse = prose.replace(/[`*_~]+/g, "");
  const machineKey = [
    "targets?(?:[-_ ]?(?:result|status))?", "backend(?:[-_ ]?(?:result|status))?",
    "frontend(?:[-_ ]?(?:result|status))?", "migrations?(?:[-_ ]?(?:result|status))?",
    "compatibility(?:[-_ ]?(?:result|status))?", "areas?(?:[-_ ]?(?:result|status))?",
    "smoke(?:[-_ ]?(?:result|status))?", "full(?:[-_ ]?(?:result|status))?",
    "manifest(?:[-_ ]?(?:result|status))?", "governance(?:[-_ ]?(?:result|status))?",
    "browser(?:[-_ ]?(?:result|status))?", "browser[-_ ]?artifacts?", "cleanup(?:[-_ ]?(?:result|status))?",
    "pre[-_ ]?review(?:[-_ ]?(?:result|status))?", "final[-_ ]?conclusion",
    "目标(?:门禁|测试|结果|状态)?", "后端(?:门禁|测试|全量|结果|状态)?", "前端(?:构建|门禁|结果|状态)?",
    "迁移(?:门禁|测试|结果|状态)?", "兼容(?:门禁|测试|结果|状态)?", "领域(?:门禁|测试|结果|状态)?",
    "冒烟(?:门禁|测试|结果|状态)?", "全量(?:门禁|测试|结果|状态)?", "(?:回归|门禁)?清单(?:拓扑|结果|状态)?",
    "治理(?:扫描|结果|状态)?", "浏览器(?:验收|测试|结果|状态)?", "浏览器(?:产物|证据)",
    "清理(?:结果|残留|状态)?", "预审(?:结果|状态)?", "最终(?:验收)?结论"
  ].join("|");
  const machineLabel = new RegExp(`^(?:[> ]*[-*+]\\s+|[> ]*\\d+[.)]\\s+|[> ]*#{1,6}\\s+|[> ]*)?[\\s\`'\"*_~]*(?:${machineKey})[\\s\`'\"*_~]*(?:[:=：]|\\|)`, "i");
  const machineTable = new RegExp(`^\\s*(?:>\\s*)*\\|\\s*[\`'\"*_~]*(?:${machineKey})[\`'\"*_~]*\\s*\\|`, "i");
  const machineAssignmentAnywhere = new RegExp(`(?:^|[\\s|])(?:${machineKey})\\s*(?:[:=：]|\\|)`, "i");
  const contradictoryMachineLines = visibleProse.split("\n").filter((line) =>
    line !== "最终结论：通过"
      && (machineLabel.test(line) || machineTable.test(line) || machineAssignmentAnywhere.test(line))
  );
  assert(
    contradictoryMachineLines.length === 0,
    `最终报告不得在唯一 JSON 证据块之外保留机器结果: ${contradictoryMachineLines.join(" | ")}`
  );
  return { evidence, prose, visibleProse };
}

function assertUniqueReportField(prose, field) {
  const occurrences = prose.split(field).length - 1;
  assert(occurrences === 1, `最终报告正文必须且只能包含一个 ${field} 字段`);
  contains(
    prose,
    new RegExp(`^(?:#{1,3}\\s+|[-*+]\\s*)${escapeRegExp(field)}(?:[：:]|\\s*$)`, "m"),
    `最终报告必须以标题或列表行登记 ${field}`
  );
}

function assertUniqueNoField(prose, field) {
  const occurrences = prose.split(field).length - 1;
  assert(occurrences === 1, `最终报告正文必须且只能包含一个 ${field} 字段`);
  contains(
    prose,
    new RegExp(`^(?:[-*+]\\s*)?${escapeRegExp(field)}[：:]\\s*无[\u3002.]?$`, "m"),
    `最终报告 ${field} 必须在唯一一行中精确登记为无`
  );
}

function verifyBrowserEvidenceBundle(browserArtifacts, browserClaim, cleanupClaim, expectedScreenshotPaths) {
  const runId = browserClaim.runId;
  const formalJsonPath = "verification/a153-browser-acceptance.json";
  const faultJsonPath = "verification/a153-browser-fault-after-fixture.json";
  const commitMarkerPath = "verification/a153-browser-acceptance.commit.json";
  const formalAbsolutePath = path.join(rootDir, formalJsonPath);
  const faultAbsolutePath = path.join(rootDir, faultJsonPath);
  const markerAbsolutePath = path.join(rootDir, commitMarkerPath);
  const lockAbsolutePath = path.join(verificationDir, ".a153-browser-final.lock");
  const screenshotAbsolutePaths = expectedScreenshotPaths.map((relativePath) => path.join(rootDir, relativePath));
  const initialRuntimeState = collectA153RuntimeState(expectedScreenshotPaths);
  const anyRuntimeArtifact = existsSync(formalAbsolutePath)
    || existsSync(faultAbsolutePath)
    || existsSync(markerAbsolutePath)
    || initialRuntimeState.lockPresent
    || initialRuntimeState.a153ScreenshotArtifacts.length > 0
    || initialRuntimeState.verificationTransaction.length > 0
    || initialRuntimeState.screenshotTransaction.length > 0
    || initialRuntimeState.failedEvidence.length > 0;

  const digestPattern = /^[0-9a-f]{64}$/;
  for (const [label, value] of [
    ["formalJsonSha256", browserArtifacts.formalJsonSha256],
    ["faultJsonSha256", browserArtifacts.faultJsonSha256],
    ["markerSha256", browserArtifacts.markerSha256],
    ["bundleSha256", browserArtifacts.bundleSha256]
  ]) {
    assert(digestPattern.test(value), `A153 browserArtifacts ${label} 必须是完整 SHA-256`);
  }

  if (!anyRuntimeArtifact) {
    const sourceState = verifyArchivedReplaySourceState();
    checks.push("A153 browser bundle 在干净 clone 中使用报告冻结的 archived replay 证据");
    return { mode: "ARCHIVED_REPLAY", strict: false, sourceState };
  }

  assert(existsSync(formalAbsolutePath), "A153 strict browser bundle 必须存在正式 JSON");
  assert(existsSync(faultAbsolutePath), "A153 strict browser bundle 必须存在 after-fixture 故障恢复 JSON");
  assert(existsSync(markerAbsolutePath), "A153 strict browser bundle 必须存在原子 commit marker");
  assert(screenshotAbsolutePaths.every((absolutePath) => existsSync(absolutePath)), "A153 strict browser bundle 必须存在全部 22 张截图");
  assertA153ConsumerFence("A153 full bundle 首次读取前", expectedScreenshotPaths);
  assert(!existsSync(lockAbsolutePath), "A153 strict browser bundle 必须已释放独占锁");
  assertRegularNonSymlinkFile(formalAbsolutePath, "A153 formal JSON");
  assertRegularNonSymlinkFile(faultAbsolutePath, "A153 fault JSON");
  assertRegularNonSymlinkFile(markerAbsolutePath, "A153 commit marker");
  for (const [index, absolutePath] of screenshotAbsolutePaths.entries()) {
    assertRegularNonSymlinkFile(absolutePath, `A153 screenshot ${expectedScreenshotPaths[index]}`);
  }

  const formalRaw = readFileSync(formalAbsolutePath);
  const faultRaw = readFileSync(faultAbsolutePath);
  const markerRaw = readFileSync(markerAbsolutePath);
  let formal;
  let fault;
  let marker;
  try {
    formal = JSON.parse(formalRaw.toString("utf8"));
    fault = JSON.parse(faultRaw.toString("utf8"));
    marker = JSON.parse(markerRaw.toString("utf8"));
  } catch (error) {
    throw new Error(`A153 strict browser bundle JSON 无法解析: ${error.message}`);
  }
  assert(
    formalRaw.toString("utf8") === `${JSON.stringify(formal, null, 2)}\n`,
    "A153 正式 browser JSON 必须是规范单值 JSON"
  );
  assert(
    faultRaw.toString("utf8") === `${JSON.stringify(fault, null, 2)}\n`,
    "A153 fault browser JSON 必须是规范单值 JSON"
  );
  assert(
    markerRaw.toString("utf8") === `${JSON.stringify(marker, null, 2)}\n`,
    "A153 browser commit marker 必须是规范单值 JSON"
  );
  assertExactKeys(formal, [...a153EvidenceBaseKeys, "publication"], "A153 formal evidence envelope");
  assertExactKeys(fault, a153EvidenceBaseKeys, "A153 fault evidence envelope");
  assertExactKeys(formal.cleanup, [...a153CleanupBaseKeys, "bundle"], "A153 formal cleanup envelope");
  assertExactKeys(fault.cleanup, a153CleanupBaseKeys, "A153 fault cleanup envelope");
  assertExactKeys(formal.catalog, ["expectedEntries", "viewports", "summary"], "A153 formal catalog envelope");
  assertExactKeys(fault.catalog, ["expectedEntries", "viewports", "summary"], "A153 fault catalog envelope");
  const expectedCatalogEntryContract = [...expectedCatalogEntries].map(([id, entry]) => ({
    id,
    module: entry.module,
    permission: entry.permission,
    kind: entry.kind,
    contentTestId: entry.contentTestId
  }));
  assert(
    same(formal.catalog.expectedEntries, expectedCatalogEntryContract)
      && same(fault.catalog.expectedEntries, expectedCatalogEntryContract),
    "A153 formal/fault catalog expectedEntries 必须精确绑定 id/module/permission/kind/contentTestId"
  );
  assert(
    Array.isArray(fault.catalog.viewports)
      && fault.catalog.viewports.length === 0
      && same(fault.catalog.summary, {})
      && Object.keys(fault.reports ?? {}).length === 0
      && Array.isArray(fault.permissions?.api)
      && fault.permissions.api.length === 0
      && Array.isArray(fault.permissions?.browser)
      && fault.permissions.browser.length === 0
      && Array.isArray(fault.tenantIsolation?.runs)
      && fault.tenantIsolation.runs.length === 0
      && Object.values(fault.browserDiagnostics ?? {}).every((rows) => Array.isArray(rows) && rows.length === 0)
      && Array.isArray(fault.screenshots)
      && fault.screenshots.length === 0
      && same(fault.screenshotHashes, {}),
    "A153 fault catalog 必须精确保持零 browser result"
  );
  assert(formal.runId === runId && formal.status === "PASS" && formal.ok === true, "A153 正式 browser JSON 必须绑定本轮 PASS runId");
  assert(
    fault.runId === runId
      && fault.faultInjection === "after-fixture"
      && fault.status === "EXPECTED_FAILURE"
      && fault.ok === true
      && fault.summary?.injectionReached === true
      && fault.summary?.faultRecoveryPassed === true,
    "A153 fault browser JSON 必须绑定本轮 after-fixture 预期失败与恢复成功"
  );
  assert(
    formal.taskId === "A153"
      && formal.faultInjection === null
      && formal.failure === null
      && /^[0-9a-f]{40,64}$/.test(formal.gitHead)
      && Number.isFinite(Date.parse(formal.generatedAt))
      && Number.isFinite(Date.parse(formal.completedAt))
      && Date.parse(formal.completedAt) >= Date.parse(formal.generatedAt),
    "A153 formal envelope 必须绑定完整 PASS 身份与有效时间区间"
  );
  assert(
    fault.taskId === "A153"
      && /^[0-9a-f]{40,64}$/.test(fault.gitHead)
      && Number.isFinite(Date.parse(fault.generatedAt))
      && Number.isFinite(Date.parse(fault.completedAt))
      && Date.parse(fault.completedAt) >= Date.parse(fault.generatedAt)
      && Date.parse(fault.completedAt) <= Date.parse(formal.generatedAt),
    "A153 fault envelope 必须先于 formal run 完成并绑定有效时间区间"
  );
  assertExactKeys(fault.failure, ["name", "message", "stack"], "A153 fault failure");
  assert(
    fault.failure.name === "Error"
      && fault.failure.message === "A153_BROWSER_FAIL_AT=after-fixture injected failure"
      && typeof fault.failure.stack === "string"
      && fault.failure.stack.length > 0,
    "A153 fault failure 必须是固定 after-fixture 注入错误"
  );
  assert(
    formal.environment?.runner?.sha256 === a153BrowserRunnerSha256
      && fault.environment?.runner?.sha256 === a153BrowserRunnerSha256
      && typeof formal.environment?.runner?.path === "string"
      && path.isAbsolute(formal.environment.runner.path)
      && typeof fault.environment?.runner?.path === "string"
      && path.isAbsolute(fault.environment.runner.path),
    "A153 formal/fault 必须由冻结 runner SHA 唯一生产"
  );
  assert(
    formal.gitHead === fault.gitHead
      && /^[0-9a-f]{64}$/.test(formal.environment?.sourceFingerprint?.sha256)
      && Number.isInteger(formal.environment?.sourceFingerprint?.fileCount)
      && formal.environment.sourceFingerprint.fileCount > 0
      && /^[0-9a-f]{64}$/.test(formal.environment?.expectedBackendFingerprint)
      && formal.environment?.sourceFingerprint?.sha256 === fault.environment?.sourceFingerprint?.sha256
      && formal.environment?.sourceFingerprint?.fileCount === fault.environment?.sourceFingerprint?.fileCount
      && formal.environment?.expectedBackendFingerprint === fault.environment?.expectedBackendFingerprint,
    "A153 formal/fault 必须绑定同一 git/source/backend runtime identity"
  );
  assert(formal.cleanup?.lockReleased === true, "A153 正式 browser JSON 必须声明独占锁已释放");
  assertExactKeys(formal.cleanup.bundle, a153BundleKeys, "A153 formal cleanup bundle");
  assertExactKeys(formal.cleanup.screenshots, [
    "captured", "promotedToFinal", "hashesVerified", "removed", "backupRemainingAtCommit",
    "expectedBackupRemainingAfterRelease", "unexpectedRemaining"
  ], "A153 formal screenshot cleanup");
  assert(
    formal.cleanup.attempted === true
      && formal.cleanup.authorized === true
      && formal.cleanup.residueTotal === 0
      && Array.isArray(formal.cleanup.errors)
      && formal.cleanup.errors.length === 0
      && formal.cleanup.screenshots.captured === 22
      && formal.cleanup.screenshots.promotedToFinal === 22
      && formal.cleanup.screenshots.hashesVerified === 22
      && formal.cleanup.screenshots.removed === 0
      && [0, 22].includes(formal.cleanup.screenshots.backupRemainingAtCommit)
      && formal.cleanup.screenshots.expectedBackupRemainingAfterRelease === 0
      && formal.cleanup.screenshots.unexpectedRemaining === 0,
    "A153 formal cleanup 必须精确、无错误并绑定全部 22 张截图"
  );
  assertAllNumericLeavesZero(formal.cleanup.residue, "A153 formal cleanup residue");
  assert(
    typeof formal.cleanup.bundle.transactionId === "string"
      && formal.cleanup.bundle.transactionId.length > 0
      && formal.cleanup.bundle.protocol === a153FormalBundleProtocol
      && formal.cleanup.bundle.lockHeldThroughFormalJsonAndScreenshotVerification === true
      && formal.cleanup.bundle.lockHeldThroughMarkerRenameAndReadbackVerification === true
      && formal.cleanup.bundle.consumerRequiresMarkerAndAbsentLock === true
      && formal.cleanup.bundle.rollbackOnPromotionOrLockReleaseFailure === true
      && formal.cleanup.bundle.expectedFormalJson === formalJsonPath
      && formal.cleanup.bundle.expectedFaultJson === faultJsonPath
      && formal.cleanup.bundle.expectedFaultJsonSha256 === sha256(faultRaw)
      && formal.cleanup.bundle.expectedCommitMarker === commitMarkerPath
      && same([...(formal.cleanup.bundle.expectedScreenshots ?? [])].sort(), [...expectedScreenshotPaths].sort())
      && formal.cleanup.bundle.backupsRetainedUntilMarkerReadbackVerification === true
      && formal.cleanup.bundle.backupsRetainedThroughLockRelease === false
      && formal.cleanup.bundle.expectedBackupRemainingAfterRelease === 0,
    "A153 formal JSON 必须冻结锁内 marker readback、零 quarantine/transaction residue 与释放锁发布协议"
  );
  assertExactKeys(formal.publication, [
    "stateWithoutMarker", "formalJsonAloneConsumable", "commitMarkerRequired", "commitMarkerPath", "consumerRule"
  ], "A153 formal publication");
  assert(same(formal.publication, {
    stateWithoutMarker: "PENDING_NOT_CONSUMABLE",
    formalJsonAloneConsumable: false,
    commitMarkerRequired: true,
    commitMarkerPath,
    consumerRule: a153PublicationConsumerRule
  }), "A153 正式 browser JSON 单独存在时必须明确不可消费");
  assert(
    formal.environment?.health?.testInventoryAdjustmentApi === false
      && formal.summary?.forbiddenInventoryAdjustmentRequests === 0,
    "A153 strict browser bundle 必须证明库存调整接口关闭且零调用"
  );
  assertExactKeys(formal.catalog.summary, ["passed", "total", "coverageKind", "specialCoverageBoundary"],
    "A153 formal catalog summary");
  assertExactKeys(formal.catalog.summary.specialCoverageBoundary, ["F042", "F061", "F093"],
    "A153 formal catalog specialCoverageBoundary");
  assert(
    formal.catalog?.summary?.passed === browserClaim.routes.passed
      && formal.catalog?.summary?.total === browserClaim.routes.total
      && formal.catalog.summary.coverageKind === "22_ROUTE_SMOKE_PLUS_DUAL_VIEWPORT_MONETARY_FUNCTIONAL_MATRIX"
      && Object.values(formal.catalog.summary.specialCoverageBoundary)
        .every((value) => typeof value === "string" && value.length > 0),
    "A153 报告 browser routes 必须与正式 bundle 交叉一致"
  );
  const viewportSpecs = [
    { viewport: "1366x768", width: 1366, height: 768 },
    { viewport: "1920x1080", width: 1920, height: 1080 }
  ];
  assert(
    Array.isArray(formal.catalog?.viewports) && formal.catalog.viewports.length === viewportSpecs.length,
    "A153 正式 browser JSON 必须包含精确两个 viewport 结果"
  );
  for (const viewportSpec of viewportSpecs) {
    const matches = formal.catalog.viewports.filter((viewport) => viewport.viewport === viewportSpec.viewport);
    assert(matches.length === 1, `A153 browser viewport 必须精确出现一次: ${viewportSpec.viewport}`);
    const [viewport] = matches;
    assert(
      viewport.width === viewportSpec.width
        && viewport.height === viewportSpec.height
        && viewport.passed === expectedCatalogEntries.size
        && viewport.total === expectedCatalogEntries.size,
      `A153 browser viewport 必须冻结尺寸与 11/11 结果: ${viewportSpec.viewport}`
    );
    assertExactKeys(viewport, ["viewport", "width", "height", "entries", "passed", "total"],
      `A153 browser viewport schema ${viewportSpec.viewport}`);
    assert(Array.isArray(viewport.entries) && viewport.entries.length === expectedCatalogEntries.size,
      `A153 browser viewport 必须包含 11 个逐项 route record: ${viewportSpec.viewport}`);
    const entryIds = viewport.entries.map((entry) => entry.entryId);
    assert(
      same([...entryIds].sort(), [...expectedCatalogEntries.keys()].sort())
        && new Set(entryIds).size === expectedCatalogEntries.size,
      `A153 browser viewport 必须逐项绑定 11 个唯一 catalog entry: ${viewportSpec.viewport}`
    );
    for (const entry of viewport.entries) {
      const catalogEntry = expectedCatalogEntries.get(entry.entryId);
      const screenshotPath = `verification/playwright/a153-${entry.entryId}-${viewportSpec.viewport}.png`;
      assertExactKeys(entry, ["entryId", "module", "permission", "kind", "contentTestId", "initialResponse", "overflow", "screenshot"],
        `A153 browser route record schema ${entry.entryId}/${viewportSpec.viewport}`);
      assert(
        entry.module === catalogEntry.module
          && entry.permission === catalogEntry.permission
          && entry.kind === catalogEntry.kind
          && entry.contentTestId === catalogEntry.contentTestId
          && entry.screenshot === screenshotPath,
        `A153 browser route record 必须绑定 module/permission/kind/content/screenshot: ${entry.entryId}/${viewportSpec.viewport}`
      );
      assertExactKeys(entry.overflow, ["viewport", "activeEntry", "html", "body", "content", "tableFrame"],
        `A153 browser overflow schema ${entry.entryId}/${viewportSpec.viewport}`);
      assertExactKeys(entry.overflow.viewport, ["width", "height"],
        `A153 browser overflow viewport schema ${entry.entryId}/${viewportSpec.viewport}`);
      assertExactKeys(entry.overflow.activeEntry, ["testId", "visible", "scrollWidth", "clientWidth"],
        `A153 browser active entry schema ${entry.entryId}/${viewportSpec.viewport}`);
      for (const rootName of ["html", "body"]) {
        assertExactKeys(entry.overflow[rootName], ["scrollWidth", "clientWidth", "overflow"],
          `A153 browser ${rootName} overflow schema ${entry.entryId}/${viewportSpec.viewport}`);
        assert(
          ["scrollWidth", "clientWidth", "overflow"].every((key) =>
            Number.isFinite(entry.overflow[rootName][key]) && entry.overflow[rootName][key] >= 0
          ),
          `A153 browser ${rootName} overflow 数值必须 finite 且非负: ${entry.entryId}/${viewportSpec.viewport}`
        );
      }
      assert(
        entry.overflow?.viewport?.width === viewportSpec.width
          && entry.overflow?.viewport?.height === viewportSpec.height
          && entry.overflow?.activeEntry?.visible === true
          && entry.overflow?.activeEntry?.testId === catalogEntry.contentTestId
          && Number.isFinite(entry.overflow?.activeEntry?.scrollWidth)
          && entry.overflow.activeEntry.scrollWidth >= 0
          && Number.isFinite(entry.overflow?.activeEntry?.clientWidth)
          && entry.overflow.activeEntry.clientWidth >= 0
          && entry.overflow.html.overflow === entry.overflow.html.scrollWidth - entry.overflow.html.clientWidth
          && entry.overflow.body.overflow === entry.overflow.body.scrollWidth - entry.overflow.body.clientWidth
          && Number(entry.overflow?.html?.overflow) <= 1
          && Number(entry.overflow?.body?.overflow) <= 1,
        `A153 browser route record 必须绑定实测 viewport 与零根级溢出: ${entry.entryId}/${viewportSpec.viewport}`
      );
      if (entry.overflow.content !== null) {
        assertExactKeys(entry.overflow.content, ["scrollWidth", "clientWidth"],
          `A153 browser content overflow schema ${entry.entryId}/${viewportSpec.viewport}`);
        assert(
          Number.isFinite(entry.overflow.content.scrollWidth) && entry.overflow.content.scrollWidth >= 0
            && Number.isFinite(entry.overflow.content.clientWidth) && entry.overflow.content.clientWidth >= 0,
          `A153 browser content width 必须 finite 且非负: ${entry.entryId}/${viewportSpec.viewport}`
        );
      }
      if (entry.overflow.tableFrame !== null) {
        assertExactKeys(entry.overflow.tableFrame, [
          "belongsToActiveEntry", "scrollWidth", "clientWidth", "overflow", "overflowX"
        ], `A153 browser table frame schema ${entry.entryId}/${viewportSpec.viewport}`);
        assert(
          entry.overflow.tableFrame.belongsToActiveEntry === true
            && ["scrollWidth", "clientWidth", "overflow"].every((key) =>
              Number.isFinite(entry.overflow.tableFrame[key]) && entry.overflow.tableFrame[key] >= 0
            )
            && entry.overflow.tableFrame.overflow
              === entry.overflow.tableFrame.scrollWidth - entry.overflow.tableFrame.clientWidth
            && typeof entry.overflow.tableFrame.overflowX === "string"
            && (entry.overflow.tableFrame.overflow <= 1
              || ["auto", "scroll"].includes(entry.overflow.tableFrame.overflowX)),
          `A153 browser table frame 必须绑定 active entry 且尺寸 finite 非负: ${entry.entryId}/${viewportSpec.viewport}`
        );
      }
      if (catalogEntry.kind === "report") {
        assertExactKeys(entry.initialResponse, ["status", "total", "query"],
          `A153 report initial response schema ${entry.entryId}/${viewportSpec.viewport}`);
        assert(
          entry.initialResponse?.status === 200
            && Number.isInteger(entry.initialResponse?.total) && entry.initialResponse.total >= 0
            && entry.initialResponse?.query && typeof entry.initialResponse.query === "object"
            && !Array.isArray(entry.initialResponse.query),
          `A153 report route 必须绑定 JSON 200/query/total: ${entry.entryId}/${viewportSpec.viewport}`
        );
      } else if (catalogEntry.kind === "numbering") {
        assertExactKeys(entry.initialResponse, ["status", "ruleCount"],
          `A153 numbering initial response schema ${viewportSpec.viewport}`);
        assert(entry.initialResponse?.status === 200 && entry.initialResponse?.ruleCount === 27,
          `A153 numbering route 必须绑定 27 条规则: ${viewportSpec.viewport}`);
      } else {
        assert(entry.initialResponse === null, `A153 form route 不得伪造初始 API 响应: ${viewportSpec.viewport}`);
      }
    }
  }
  assert(
    formal.browserDiagnostics?.consoleErrors?.length === browserClaim.consoleErrors
      && formal.browserDiagnostics?.pageErrors?.length === browserClaim.pageErrors,
    "A153 报告 console/page errors 必须与正式 bundle 交叉一致"
  );
  const viewportEntries = (formal.catalog?.viewports ?? []).flatMap((viewport) => viewport.entries ?? []);
  const overflowCount = viewportEntries.filter((entry) =>
    Number(entry.overflow?.html?.overflow ?? 0) > 1 || Number(entry.overflow?.body?.overflow ?? 0) > 1
  ).length;
  assert(overflowCount === browserClaim.overflow, "A153 报告 overflow 必须与 22 路由 bundle 交叉一致");
  assert(
    formal.summary?.cnyNonZero === browserClaim.cnyNonZero
      && formal.summary?.usdNonZero === browserClaim.usdNonZero,
    "A153 报告 CNY/USD 非零结论必须与正式 bundle 交叉一致"
  );
  assert(formal.summary?.permission === browserClaim.permission, "A153 报告 permission 必须与正式 bundle 交叉一致");
  assert(
    browserClaim.tenant === "PASS" && formal.summary?.tenant === "SALES_DETAIL_CNY_USD_BOTH_VIEWPORTS_PASS",
    "A153 报告 tenant PASS 必须绑定正式 sales-detail 双视口 tenant 矩阵"
  );
  assert(
    browserClaim.csv === "PASS"
      && formal.summary?.csv === "PUBLIC_MONETARY_MATRIX_EXACT_PASS_WITH_SALES_DETAIL_TENANT_SWITCH_EXACT_PASS",
    "A153 报告 CSV PASS 必须与正式 bundle 交叉一致"
  );
  assert(same(cleanupClaim, { fixture: 0, database: 0, redis: 0, processes: 0, residue: 0 }), "A153 报告 cleanup claim 必须全部为 0");
  assert(
    formal.cleanup?.residueTotal === 0
      && formal.summary?.cleanup === "PASS"
      && formal.summary?.residue === 0
      && Array.isArray(formal.cleanup?.errors) && formal.cleanup.errors.length === 0
      && formal.cleanup?.redis?.remainingOwnedKeys === 0
      && formal.cleanup?.redis?.remainingSharedMembers === 0
      && formal.cleanup?.redis?.exactCapturedKeysRemaining === 0
      && formal.cleanup?.redis?.exactCapturedSharedMembersRemaining === 0
      && formal.cleanup?.redisGlobalGuard?.remainingOwnedKeys === 0
      && formal.cleanup?.redisGlobalGuard?.remainingSharedMembers === 0
      && formal.cleanup?.downloads?.remaining === 0
      && formal.cleanup?.screenshots?.unexpectedRemaining === 0
      && formal.cleanup?.processes?.remaining === 0
      && formal.cleanup?.profile?.remaining === 0,
    "A153 报告 cleanup 零残留必须与正式 bundle 所有 DB/Redis/文件/进程闭包交叉一致"
  );
  assertExactKeys(fault.cleanup.screenshots, [
    "captured", "preserved", "removed", "missing", "hashMismatches", "backupRemaining",
    "unexpectedA153Screenshots", "unexpectedRemaining"
  ], "A153 fault screenshot cleanup");
  assertAllNumericLeavesZero(fault.cleanup.residue, "A153 fault cleanup residue");
  assert(
    fault.cleanup?.attempted === true
      && fault.cleanup?.authorized === true
      && fault.cleanup?.lockReleased === true
      && fault.cleanup?.residueTotal === 0
      && fault.summary?.cleanup === "PASS"
      && fault.summary?.residue === 0
      && Array.isArray(fault.cleanup?.errors) && fault.cleanup.errors.length === 0
      && fault.cleanup?.redis?.remainingOwnedKeys === 0
      && fault.cleanup?.redis?.remainingSharedMembers === 0
      && fault.cleanup?.redis?.exactCapturedKeysRemaining === 0
      && fault.cleanup?.redis?.exactCapturedSharedMembersRemaining === 0
      && fault.cleanup?.redisGlobalGuard?.remainingOwnedKeys === 0
      && fault.cleanup?.redisGlobalGuard?.remainingSharedMembers === 0
      && fault.cleanup?.downloads?.remaining === 0
      && fault.cleanup?.screenshots?.unexpectedRemaining === 0
      && Array.isArray(fault.cleanup?.screenshots?.unexpectedA153Screenshots)
      && fault.cleanup.screenshots.unexpectedA153Screenshots.length === 0
      && fault.cleanup?.processes?.remaining === 0
      && fault.cleanup?.profile?.remaining === 0,
    "A153 fault browser JSON 必须证明故障注入后的 DB/Redis/文件/进程闭包全部为零"
  );
  const sortedExpectedPaths = [...expectedScreenshotPaths].sort();
  assert(
    same([...(formal.screenshots ?? [])].sort(), sortedExpectedPaths)
      && same(Object.keys(formal.screenshotHashes ?? {}).sort(), sortedExpectedPaths),
    "A153 正式 browser JSON 必须精确绑定 22 张截图路径和 hash"
  );
  const firstScreenshotByteHashes = {};
  for (const relativePath of sortedExpectedPaths) {
    const screenshot = readFileSync(path.join(rootDir, relativePath));
    const expectedViewport = relativePath.endsWith("-1366x768.png")
      ? { width: 1366, height: 768 }
      : { width: 1920, height: 1080 };
    verifyA153PngScreenshot(screenshot, expectedViewport.width, expectedViewport.height, relativePath);
    const actualHash = sha256(screenshot);
    firstScreenshotByteHashes[relativePath] = actualHash;
    assert(actualHash === formal.screenshotHashes[relativePath], `A153 strict browser screenshot hash 必须匹配: ${relativePath}`);
  }
  const formalJsonSha256 = sha256(formalRaw);
  const faultJsonSha256 = sha256(faultRaw);
  const bundleSha256 = formalBundleHash(formalJsonSha256, faultJsonSha256, formal.screenshotHashes);
  assertExactKeys(marker, [
    "version", "state", "consumable", "runId", "formalJsonPath", "formalJsonSha256",
    "faultJsonPath", "faultJsonSha256", "screenshotCount", "bundleSha256", "committedAt", "closure"
  ], "A153 browser commit marker");
  assert(marker.version === 1 && marker.state === "COMMITTED" && marker.consumable === true, "A153 browser marker 必须处于可消费 COMMITTED 状态");
  assert(
    marker.runId === runId
      && marker.formalJsonPath === formalJsonPath
      && marker.faultJsonPath === faultJsonPath,
    "A153 browser marker 必须绑定本轮 runId 与固定 formal/fault JSON"
  );
  assert(
    marker.formalJsonSha256 === formalJsonSha256
      && marker.faultJsonSha256 === faultJsonSha256
      && marker.bundleSha256 === bundleSha256,
    "A153 browser marker 必须绑定重算的 formal/fault/bundle SHA-256"
  );
  assert(marker.screenshotCount === 22, "A153 browser marker 必须绑定 22 张截图");
  assert(
    Number.isFinite(Date.parse(marker.committedAt))
      && Date.parse(marker.committedAt) >= Date.parse(formal.completedAt),
    "A153 browser marker committedAt 必须有效且不早于 formal.completedAt"
  );
  assert(
    marker.closure === a153CommitMarkerClosure,
    "A153 browser marker 必须冻结 crash-safe 关闭协议"
  );
  assertA153ConsumerFence("A153 full bundle 首次完整读取后", expectedScreenshotPaths);
  const secondFormalJsonSha256 = sha256(readFileSync(formalAbsolutePath));
  const secondFaultJsonSha256 = sha256(readFileSync(faultAbsolutePath));
  const secondMarkerSha256 = sha256(readFileSync(markerAbsolutePath));
  assert(
    secondFormalJsonSha256 === formalJsonSha256
      && secondFaultJsonSha256 === faultJsonSha256
      && secondMarkerSha256 === sha256(markerRaw),
    "A153 strict consumer 二次读取 formal/fault/marker 必须与首次 byte hash 一致"
  );
  const secondScreenshotByteHashes = {};
  for (const relativePath of sortedExpectedPaths) {
    const secondScreenshotHash = sha256(readFileSync(path.join(rootDir, relativePath)));
    secondScreenshotByteHashes[relativePath] = secondScreenshotHash;
    assert(
      secondScreenshotHash === firstScreenshotByteHashes[relativePath]
        && secondScreenshotHash === formal.screenshotHashes[relativePath],
      `A153 strict consumer 二次读取截图必须与首次 byte hash 一致: ${relativePath}`
    );
  }
  assert(
    formalBundleHash(secondFormalJsonSha256, secondFaultJsonSha256, secondScreenshotByteHashes) === bundleSha256,
    "A153 strict consumer 二次读取后必须重算得到同一 bundle SHA-256"
  );
  assertA153ConsumerFence("A153 full bundle 二次完整读取后", expectedScreenshotPaths);
  assert(browserArtifacts.formalJsonSha256 === formalJsonSha256, "A153 报告必须冻结实测 formal JSON SHA-256");
  assert(browserArtifacts.faultJsonSha256 === faultJsonSha256, "A153 报告必须冻结实测 fault JSON SHA-256");
  assert(browserArtifacts.markerSha256 === sha256(markerRaw), "A153 报告必须冻结实测 marker SHA-256");
  assert(browserArtifacts.bundleSha256 === bundleSha256, "A153 报告必须冻结实测 browser bundle SHA-256");
  return {
    mode: "STRICT_LOCAL_BUNDLE",
    strict: true,
    formalJsonSha256,
    faultJsonSha256,
    markerSha256: sha256(markerRaw),
    bundleSha256
  };
}

assert(existsSync(path.join(rootDir, finalReportPath)), "A153 必须归档唯一 6E 最终验收报告");

const sources = Object.fromEntries(Object.entries(paths).map(([key, relativePath]) => [key, read(relativePath)]));
const deliveryStatus = JSON.parse(sources.deliveryStatus);
const roadmap = JSON.parse(sources.roadmap);
const manifest = JSON.parse(sources.manifest);

const expectedFeatures = new Map([
  ["F029", {
    minimumLevel: "A3",
    requiredCatalogEntryIds: ["sales-detail", "sales-summary", "sales-order-tracking"],
    requiredEvidence: [finalReportPath]
  }],
  ["F042", {
    minimumLevel: "A3",
    requiredCatalogEntryIds: ["inventory-movement-detail"],
    requiredEvidence: [
      "docs/验收报告/验收报告-F-库存流水与余额闭环-20260623.md",
      finalReportPath
    ]
  }],
  ["F061", {
    minimumLevel: "A4",
    requiredCatalogEntryIds: ["material-scrap-form", "material-scrap-summary"],
    requiredEvidence: [finalReportPath]
  }],
  ["F091", {
    minimumLevel: "A3",
    requiredCatalogEntryIds: ["receivable-detail", "receivable-summary", "payable-detail", "payable-summary"],
    requiredEvidence: [
      "docs/验收报告/验收报告-A85-财务过账接审核-20260625.md",
      "docs/验收报告/验收报告-A119-完整多账套架构迁移-20260630.md",
      finalReportPath
    ]
  }],
  ["F093", {
    minimumLevel: "A3",
    requiredCatalogEntryIds: ["numbering-rule-settings"],
    requiredEvidence: [
      "docs/验收报告/验收报告-A90-单据编号-20260626.md",
      finalReportPath
    ]
  }]
]);
const capabilityKeys = ["entry", "backend", "permission", "auditLog", "automation", "browser"];
const levelRank = { A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 };

for (const [featureId, expected] of expectedFeatures) {
  const feature = deliveryStatus.features?.find((candidate) => candidate.id === featureId);
  assert(Boolean(feature), `delivery status 必须保留 ${featureId}`);
  assert(feature.state === "verified", `${featureId} 必须 verified`);
  assert(
    Number.isInteger(levelRank[feature.level]) && levelRank[feature.level] >= levelRank[expected.minimumLevel],
    `${featureId} 验收等级不得低于 A153 基线 ${expected.minimumLevel}`
  );
  assert(feature.exposure === "published" && feature.surface === "catalog", `${featureId} 必须以 catalog 正式发布`);
  assert(Array.isArray(feature.catalogEntryIds), `${featureId} catalog owner 必须是数组`);
  assert(
    expected.requiredCatalogEntryIds.every((entryId) => feature.catalogEntryIds.includes(entryId)),
    `${featureId} 不得移除 A153 已发布的 catalog owner 基线`
  );
  assert(Array.isArray(feature.evidence), `${featureId} evidence 必须是数组`);
  assert(
    expected.requiredEvidence.every((evidencePath) => feature.evidence.includes(evidencePath)),
    `${featureId} 不得移除 A153 及其前置历史证据`
  );
  assert(Array.isArray(feature.knownGaps), `${featureId} knownGaps 必须继续由当前 delivery status 显式登记`);
  assert(same(Object.keys(feature.capabilityChecks ?? {}), capabilityKeys), `${featureId} 必须保留六项 capability checks`);
  assert(capabilityKeys.every((key) => feature.capabilityChecks[key] === "verified"), `${featureId} 六项 capability checks 必须全部 verified`);
}

const item6e = roadmap.items?.find((item) => item.id === "6E");
assert(Boolean(item6e), "roadmap 必须保留 6E 关单记录");
assert(same(item6e.scopeIds, [...expectedFeatures.keys()]), "6E scopeIds 必须精确保留五个有效范围");
assert(item6e.targetAcceptance === "A3", "6E targetAcceptance 必须为 A3");
assert(same(item6e.predecessorIds, ["6D"]), "6E 必须只以 6D 为前置");
assert(same(item6e.historyRefs, [finalReportPath]), "6E historyRefs 必须只指向最终验收报告");

const expectedCatalogEntries = new Map([
  ["sales-detail", { label: "销售明细", module: "销售管理", mode: "report", kind: "report", permission: "sales.order.audit", contentTestId: "report-page-sales-detail" }],
  ["sales-summary", { label: "销售汇总", module: "销售管理", mode: "report", kind: "report", permission: "sales.order.audit", contentTestId: "report-page-sales-summary" }],
  ["sales-order-tracking", { label: "销售订单跟踪", module: "销售管理", mode: "report", kind: "report", permission: "sales.order.audit", contentTestId: "report-page-sales-order-tracking" }],
  ["inventory-movement-detail", { label: "商品收发明细", module: "库存管理", mode: "report", kind: "report", permission: "inventory.stock.view", contentTestId: "report-page-inventory-movement-detail" }],
  ["material-scrap-form", { label: "材料报废单", module: "生产管理", mode: "form", kind: "form", permission: "production.document.audit", contentTestId: "material-scrap-form", dirty: true }],
  ["material-scrap-summary", { label: "材料报废统计", module: "生产管理", mode: "report", kind: "report", permission: "production.document.audit", contentTestId: "report-page-material-scrap-summary" }],
  ["receivable-detail", { label: "应收明细", module: "应收应付", mode: "report", kind: "report", permission: "finance.report.view", contentTestId: "report-page-receivable-detail" }],
  ["receivable-summary", { label: "应收汇总", module: "应收应付", mode: "report", kind: "report", permission: "finance.report.view", contentTestId: "report-page-receivable-summary" }],
  ["payable-detail", { label: "应付明细", module: "应收应付", mode: "report", kind: "report", permission: "finance.report.view", contentTestId: "report-page-payable-detail" }],
  ["payable-summary", { label: "应付汇总", module: "应收应付", mode: "report", kind: "report", permission: "finance.report.view", contentTestId: "report-page-payable-summary" }],
  ["numbering-rule-settings", { label: "单据编号规则", module: "系统设置", mode: "shell", kind: "numbering", permission: "system.numbering_rule.manage", contentTestId: "numbering-rule-settings-page" }]
]);

for (const [entryId, expected] of expectedCatalogEntries) {
  const matches = [...sources.catalog.matchAll(new RegExp(`\\{[^\\n{}]*id: "${escapeRegExp(entryId)}"[^\\n{}]*\\}`, "g"))];
  assert(matches.length === 1, `${entryId} 必须在 catalog 精确发布一次`);
  const entry = matches[0][0];
  contains(entry, new RegExp(`label: "${escapeRegExp(expected.label)}"`), `${entryId} 必须保留最终用户文案`);
  contains(entry, new RegExp(`module: "${escapeRegExp(expected.module)}"`), `${entryId} 必须归属正确模块`);
  contains(entry, new RegExp(`mode: "${expected.mode}"`), `${entryId} 必须使用 ${expected.mode} 模式`);
  contains(entry, new RegExp(`permission: "${escapeRegExp(expected.permission)}"`), `${entryId} 必须使用精确已有权限`);
  if (expected.mode !== "shell") contains(entry, /queryable: true/, `${entryId} 必须为可查询真实入口`);
  if (expected.dirty) contains(entry, /dirty: true/, `${entryId} 必须接入未保存保护`);
}
for (const retiredEntryId of ["scrap-report", "receivable-list", "payable-list", "numbering-rule-list"]) {
  excludes(sources.catalog, new RegExp(`id: ["']${escapeRegExp(retiredEntryId)}["']`), `已退役入口 ${retiredEntryId} 不得恢复`);
}

for (const [owner, moduleName] of [
  ["financeReportDefinitions", "financeReports"],
  ["inventoryMovementReport", "inventoryMovementReport"],
  ["materialScrapReport", "materialScrapReport"],
  ["salesReportDefinitions", "salesReports"]
]) {
  contains(sources.reportRegistry, new RegExp(`^import \\{ ${owner} \\} from "\\./${moduleName}";$`, "m"), `reportRegistry 必须静态冻结 ${moduleName} owner`);
}
contains(
  sources.reportRegistry,
  /const definitions:[\s\S]*inventoryMovementReport,[\s\S]*\.\.\.salesReportDefinitions,[\s\S]*\.\.\.financeReportDefinitions,[\s\S]*materialScrapReport[\s\S]*Object\.freeze\(definitions\.map/,
  "reportRegistry 必须按固定 owner 装配并导出冻结 entry id 集合"
);
contains(sources.metadataGate, /registeredReportIds\.has\(catalogEntry\.id\)[\s\S]*catalogEntry\.mode === "form" \? `\$\{catalogEntry\.id\}-list` : catalogEntry\.id/, "A115 必须区分正式 report registry 与普通 list\/form contract");
for (const featureId of expectedFeatures.keys()) {
  contains(sources.metadataGate, new RegExp(`\\["${featureId}",`), `A115 必须冻结 ${featureId} 最终 catalog owner`);
}

const reportPermissions = new Map([
  ["sales-detail", "sales.order.audit"],
  ["sales-summary", "sales.order.audit"],
  ["sales-order-tracking", "sales.order.audit"],
  ["inventory-movement-detail", "inventory.stock.view"],
  ["receivable-detail", "finance.report.view"],
  ["receivable-summary", "finance.report.view"],
  ["payable-detail", "finance.report.view"],
  ["payable-summary", "finance.report.view"],
  ["material-scrap-summary", "production.document.audit"]
]);
for (const [reportKey, permission] of reportPermissions) {
  const row = sources.reportProtocol.split("\n").find((line) => line.includes(`| \`${reportKey}\` |`));
  assert(Boolean(row?.includes(`| \`${permission}\` |`)), `${reportKey} 必须在稳定报表协议中绑定 ${permission}`);
}
contains(sources.reportProtocol, /CNY 与 USD 在行、合计和汇总中按 `currency` 分组/, "金额报表必须冻结 CNY\/USD 分币种口径");
contains(sources.reportProtocol, /纯数量报表不伪造 currency[\s\S]*无跨单位合计/, "F042\/F061 必须冻结纯数量与不跨单位边界");
contains(sources.lifecycleProtocol, /`materialScrap`[\s\S]*`production_material_scrap`[\s\S]*反审核固定回 `DRAFT`/, "F061 必须保留正式材料报废生命周期协议");

const a144Script = "scripts/a144-6e-contract-regression.mjs";
const a153Script = "scripts/a153-6e-closure-regression.mjs";
const a152Script = "scripts/a152-material-scrap-ui-regression.mjs";
const manifestLists = [manifest.full, manifest.smoke, ...Object.values(manifest.areas), manifest.exemptions.map((entry) => entry.script)];
assert(manifestLists.every((list) => !list.includes(a144Script)), "A144 临时合同门禁必须从 manifest 完全移除");
assert(!existsSync(path.join(rootDir, a144Script)), "A144 临时合同门禁脚本必须从仓库删除");
const a153SmokeBaseline = [
  "scripts/a59-formal-login-regression.mjs",
  "scripts/a90-numbering-regression.mjs",
  "scripts/a85-finance-posting-regression.mjs",
  "scripts/a86-other-stock-in-regression.mjs",
  "scripts/a87-other-stock-out-regression.mjs",
  "scripts/a93-sales-out-source-selection-regression.mjs",
  "scripts/a94-tax-amount-regression.mjs",
  "scripts/a105-bill-lifecycle-regression.mjs",
  "scripts/a108-delivery-notice-reservation-regression.mjs",
  "scripts/a110-table-display-brand-regression.mjs"
];
assert(
  a153SmokeBaseline.every((script) => manifest.smoke.includes(script)),
  "smoke 不得移除 A153 已验证的 10 个核心成员"
);
assert(!manifest.smoke.includes(a153Script), "A153 closure 不得进入 smoke");
const a153FullBaseline = [
  "scripts/a115-metadata-definition-regression.mjs",
  "scripts/a145-report-query-foundation-regression.mjs",
  "scripts/a146-numbering-rule-closure-regression.mjs",
  "scripts/a146-numbering-rule-migration-regression.mjs",
  "scripts/a147-inventory-source-trace-regression.mjs",
  "scripts/a147-inventory-source-trace-migration-regression.mjs",
  "scripts/a148-inventory-movement-report-regression.mjs",
  "scripts/a149-sales-report-regression.mjs",
  "scripts/a150-finance-report-regression.mjs",
  "scripts/a151-material-scrap-backend-regression.mjs",
  "scripts/a151-material-scrap-migration-regression.mjs",
  a152Script,
  a153Script
];
assert(
  a153FullBaseline.every((script) => manifest.full.includes(script)),
  "full 不得移除 A153 治理及 A145-A152 交付门禁基线"
);
const a153AreaBaselines = {
  reports: [
    "scripts/a145-report-query-foundation-regression.mjs",
    "scripts/a148-inventory-movement-report-regression.mjs",
    "scripts/a149-sales-report-regression.mjs",
    "scripts/a150-finance-report-regression.mjs",
    a152Script,
    a153Script
  ],
  security: [
    "scripts/a146-numbering-rule-closure-regression.mjs",
    "scripts/a147-inventory-source-trace-regression.mjs",
    "scripts/a148-inventory-movement-report-regression.mjs",
    "scripts/a151-material-scrap-backend-regression.mjs",
    a152Script,
    a153Script
  ],
  system: [
    "scripts/a146-numbering-rule-closure-regression.mjs",
    "scripts/a146-numbering-rule-migration-regression.mjs",
    "scripts/a147-inventory-source-trace-regression.mjs",
    "scripts/a147-inventory-source-trace-migration-regression.mjs",
    "scripts/a151-material-scrap-backend-regression.mjs",
    "scripts/a151-material-scrap-migration-regression.mjs",
    a153Script
  ]
};
for (const [area, baselineScripts] of Object.entries(a153AreaBaselines)) {
  assert(
    baselineScripts.every((script) => manifest.areas[area]?.includes(script)),
    `area:${area} 不得移除 A153 已验证的领域门禁基线`
  );
}
const a153Areas = Object.entries(manifest.areas).filter(([, scripts]) => scripts.includes(a153Script)).map(([area]) => area).sort();
assert(["reports", "security", "system"].every((area) => a153Areas.includes(area)), "A153 closure gate 必须至少登记 reports/security/system");
const a152Areas = Object.entries(manifest.areas).filter(([, scripts]) => scripts.includes(a152Script)).map(([area]) => area).sort();
assert(["lifecycle", "production", "reports", "security", "table"].every((area) => a152Areas.includes(area)), "A152 必须至少保留 lifecycle/production/reports/security/table 门禁归属");

const { summary } = await loadRegressionManifest(rootDir);
assert(summary.discoveredCount >= 155, "regression manifest 不得低于 A153 的 155 个 discovered 基线");
assert(summary.fullCount >= 134, "regression manifest full 不得低于 A153 的 134 项基线");
assert(summary.smokeCount >= 10, "regression manifest smoke 不得低于 A153 的 10 项核心基线");
assert(
  summary.discoveredCount === summary.fullCount + summary.exemptionCount,
  "每个 discovered regression 必须精确归入 full 或 exemption"
);
assert(summary.areaCounts.security >= 23, "area:security 不得低于 A153 的 23 项基线");
assert(summary.areaCounts.system >= 20, "area:system 不得低于 A153 的 20 项基线");
assert(summary.areaCounts.reports >= 6, "area:reports 不得低于 A153 的 6 项基线");

const { evidence, prose: reportProse, visibleProse: visibleReportProse } = parseFinalEvidenceBlock(sources.finalReport);
contains(reportProse, /^# 验收报告：A144-6E 报表与当前错误入口$/m, "最终验收报告必须使用固定标题");
for (const featureId of expectedFeatures.keys()) {
  contains(reportProse, new RegExp(`\\b${featureId}\\b`), `最终验收报告必须覆盖 ${featureId}`);
}
contains(
  reportProse,
  /F029=`verified\/A3`、F042=`verified\/A3`、F061=`verified\/A4`、F091=`verified\/A3`、F093=`verified\/A3`/,
  "最终报告必须冻结 A153 当次五项 delivery level 精确快照"
);
for (const [featureId, boundary] of [
  ["F029", "不含销售排行、销售利润及无可信成本/毛利口径的分析"],
  ["F042", "不含库存成本或金额；无法定位真实来源的 LEGACY 历史流水只读展示且不可钻取"],
  ["F061", "`knownGaps=[]`；统计不能替代正式单据，重发数量首版只记录"],
  ["F091", "不含预警、实际退款、预收/预付、其他应收/其他应付或汇率/折算"],
  ["F093", "不开放自定义 document type 或删除规则"]
]) {
  contains(reportProse, new RegExp(escapeRegExp(boundary)), `最终报告必须冻结 ${featureId} 的 A153 当次交付边界`);
}
for (const currency of ["CNY", "USD"]) {
  contains(reportProse, new RegExp(`\\b${currency}\\b`), `最终验收报告必须保留 ${currency} 验收证据`);
}
contains(reportProse, /纯数量/, "最终报告必须记录 F042\/F061 纯数量口径");
contains(reportProse, /不跨币种/, "最终报告必须记录金额不跨币种汇总");
contains(reportProse, /不跨单位/, "最终报告必须记录数量不跨单位汇总");
contains(reportProse, /1366\s*[x×]\s*768/i, "最终报告必须归档 1366x768 视口证据");
contains(reportProse, /1920\s*[x×]\s*1080/i, "最终报告必须归档 1920x1080 视口证据");
excludes(
  visibleReportProse,
  /待回填|草案|待汇总|待补充|待验证|待处理|待复验|待确认|待执行|待清理|待验收|等待(?:回填|验证|处理|复验|确认|执行|清理|验收)|尚待|尚未(?:验证|验收|关单|执行|取得|完成|通过)|未关单|未执行|未取得|未验收|未完成|未通过|进行中|占位|尚无证据|无证据|计划执行|TODO|TBD|PENDING|不是[“\"]?已通过|不构成\s*6E\s*最终通过|最终结论：通过(?:不成立|无效|尚未生效)|不能[^\n]*(?:最终)?通过/i,
  "最终验收报告不得保留任何未完成语义"
);
for (const requiredField of [
  "验收日期", "验收范围", "测试账号", "测试数据", "通过项", "截图路径", "剩余风险", "下一步"
]) {
  assertUniqueReportField(reportProse, requiredField);
}
assertUniqueNoField(reportProse, "失败项");
assertUniqueNoField(reportProse, "阻塞项");
excludes(reportProse, /(?:^|\n)(?:#{1,3}\s+截图路径\s*\n+无[。.]?|[-*+]\s*截图路径[：:]\s*无[。.]?)(?:\n|$)/m, "最终报告截图路径不得为空或写无");
contains(reportProse, /改动归类[：:]\s*共享核心逻辑/, "最终报告必须登记本批改动归类为共享核心逻辑");
contains(reportProse, /所选档位[：:](?=[^\n]*full)(?=[^\n]*后端快测)[^\n]+/, "最终报告必须登记 full 与后端快测档位");
const expectedScreenshotPaths = [...expectedCatalogEntries.keys()].flatMap((entryId) => [
  `verification/playwright/a153-${entryId}-1366x768.png`,
  `verification/playwright/a153-${entryId}-1920x1080.png`
]);
assertExactKeys(evidence, [
  "schemaVersion", "taskId", "targets", "backend", "frontend", "migrations", "compatibility",
  "areas", "smoke", "full", "manifest", "governance", "browser", "browserArtifacts",
  "cleanup", "preReview", "finalConclusion"
], "A153 证据块");
assert(evidence.schemaVersion === 1 && evidence.taskId === "A153", "A153 证据块必须使用 schemaVersion=1 与 taskId=A153");
assert(same(evidence.targets, {
  A145: 185, A146: 124, A147: "PASS", A148: 126, A149: 74,
  A150: 69, A151: 115, A152: 182, A153: "PASS"
}), "A153 证据块必须冻结 A145-A153 目标门禁精确结果");
assert(same(evidence.backend, { passed: 393, total: 393, failures: 0, errors: 0, skipped: 0 }), "A153 证据块必须冻结 backend 393/393 零失败结果");
assert(same(evidence.frontend, { status: "PASS", modules: 228, warning: "existing-chunk-size" }), "A153 证据块必须冻结 frontend build 结果");
assert(same(evidence.migrations, {
  A146: "PASS", A147: "PASS", A151: "PASS", A137: "PASS",
  A141: "PASS", A142: "PASS", A143: "PASS", residue: 0
}), "A153 证据块必须冻结 migration 与零残留结果");
assert(same(evidence.compatibility, {
  A115: "PASS", A119UI: "PASS", A119Isolation: "PASS", A128: "PASS", A137: "PASS",
  A140: "PASS", A141: "PASS", A142: "PASS", A143: "PASS", residue: 0
}), "A153 证据块必须冻结兼容门禁与零残留结果");
assert(same(evidence.areas, {
  sales: "21/21", purchase: "17/17", inventory: "22/22", finance: "17/17",
  production: "23/23", lifecycle: "19/19", reports: "16/16", system: "30/30",
  security: "32/32", table: "25/25", bad: 0, skipped: 0
}), "A153 证据块必须冻结 10 个 area 的精确结果");
assert(same(evidence.smoke, { passed: 10, total: 10, bad: 0, skipped: 0 }), "A153 证据块必须冻结 smoke 10/10 结果");
assert(same(evidence.full, { passed: 134, total: 134, bad: 0, skipped: 0 }), "A153 证据块必须冻结 full 134/134 结果");
assert(same(evidence.manifest, { discovered: 155, full: 134, smoke: 10, exemptions: 21 }), "A153 证据块必须冻结 manifest 155/134/10/21 当次快照");
assert(same(evidence.governance, {
  effectiveScope: "PASS", featureDelivery: "PASS", manifest: "PASS", diffCheck: "PASS"
}), "A153 证据块必须冻结三份真相源与 diff check 结果");
assertExactKeys(evidence.browser, [
  "runId", "routes", "consoleErrors", "pageErrors", "overflow", "cnyNonZero", "usdNonZero",
  "permission", "tenant", "csv"
], "A153 browser 证据");
assert(evidence.browser.runId === "A153-FINAL-20260715-01", "A153 browser 证据必须绑定冻结 runId");
assert(same(evidence.browser.routes, { passed: 22, total: 22 }), "A153 browser 必须完成 22/22 双视口路由");
for (const zeroField of ["consoleErrors", "pageErrors", "overflow"]) {
  assert(evidence.browser[zeroField] === 0, `A153 browser ${zeroField} 必须为 0`);
}
assert(evidence.browser.cnyNonZero === true && evidence.browser.usdNonZero === true, "A153 browser 必须冻结 CNY/USD 非零样本");
assert(evidence.browser.permission === "PASS" && evidence.browser.tenant === "PASS" && evidence.browser.csv === "PASS", "A153 browser 权限、tenant 与 CSV 必须全部 PASS");
assertExactKeys(evidence.browserArtifacts, [
  "json", "faultJson", "commitMarker", "formalJsonSha256", "faultJsonSha256", "markerSha256", "bundleSha256", "screenshots"
], "A153 browserArtifacts 证据");
assert(evidence.browserArtifacts.json === "verification/a153-browser-acceptance.json", "A153 browserArtifacts 必须指向固定 JSON");
assert(evidence.browserArtifacts.faultJson === "verification/a153-browser-fault-after-fixture.json", "A153 browserArtifacts 必须指向固定 fault JSON");
assert(evidence.browserArtifacts.commitMarker === "verification/a153-browser-acceptance.commit.json", "A153 browserArtifacts 必须指向固定 commit marker");
assert(same(evidence.browserArtifacts.screenshots, expectedScreenshotPaths), "A153 browserArtifacts 必须按固定顺序逐项归档 22 张截图");
const browserBundleVerification = verifyBrowserEvidenceBundle(
  evidence.browserArtifacts,
  evidence.browser,
  evidence.cleanup,
  expectedScreenshotPaths
);
assert(same(evidence.cleanup, { fixture: 0, database: 0, redis: 0, processes: 0, residue: 0 }), "A153 证据块必须冻结精确清理结果");
assert(same(evidence.preReview, { result: "CLEAN", screenshotsStaged: 0, pushed: false }), "A153 证据块必须冻结 closure 前独立预审与提交边界");
assert(evidence.finalConclusion === "通过", "A153 证据块最终结论必须为通过");
const reportedScreenshotPaths = sources.finalReport.match(/verification\/playwright\/a153-[a-z0-9-]+-(?:1366x768|1920x1080)\.png/g) ?? [];
assert(
  same([...reportedScreenshotPaths].sort(), [...expectedScreenshotPaths].sort()),
  "最终报告必须逐项且不重复归档 11 个入口 × 2 个视口的 22 张截图路径"
);
contains(reportProse, /USD\s*非零样本/, "最终报告必须记录 F029/F091 的 USD 非零样本证据");
assert(reportProse.split("最终结论").length - 1 === 1, "最终验收报告正文必须且只能出现一次最终结论");
const finalConclusionLines = reportProse.split("\n").filter((line) => line.includes("最终结论"));
assert(same(finalConclusionLines, ["最终结论：通过"]), "最终验收报告必须且只能包含唯一裸行最终结论：通过");

mkdirSync(verificationDir, { recursive: true });
writeFileSync(
  resultPath,
  `${JSON.stringify({
    taskId: "A153",
    generatedAt: new Date().toISOString(),
    status: "PASS",
    assertions: checks.length,
    checks,
    files: Object.values(paths),
    manifestSummary: summary,
    browserBundleVerification
  }, null, 2)}\n`,
  "utf8"
);

console.log(`A153 6E closure regression PASS (${checks.length} assertions)`);
console.log(`evidence: ${path.relative(rootDir, resultPath)}`);
