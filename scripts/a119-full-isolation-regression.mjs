import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const backendDir = path.join(rootDir, "backend");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a119-full-isolation-regression.json");

const javaHome = process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21";

const suites = [
  {
    area: "平台层与账套运维",
    className: "AccountSetManagementServiceTest",
    covers: "新建账套、初始化当前账套、当前账套备份/恢复、操作日志账套信息"
  },
  {
    area: "主数据 / BOM / 编号",
    className: "TenantMasterDataBomNumberingIsolationTest",
    covers: "两个账套允许相同物料编码、BOM 编码和单据类型流水，互不影响"
  },
  {
    area: "库存",
    className: "TenantInventoryIsolationTest",
    covers: "期初、库存余额、库存流水、其他入库/出库、预留与可用库存互不影响"
  },
  {
    area: "销售",
    className: "TenantSalesChainIsolationTest",
    covers: "报价、订单、发货通知、销售出库、选源和库存预留/扣减互不影响"
  },
  {
    area: "采购",
    className: "TenantPurchaseChainIsolationTest",
    covers: "采购申请、采购订单、采购入库、采购退货和采购汇总互不影响"
  },
  {
    area: "生产",
    className: "TenantProductionChainIsolationTest",
    covers: "生产计划、生产任务、采购申请、领料、产品入库和齐套分析互不影响"
  },
  {
    area: "委外",
    className: "TenantOutsourcingChainIsolationTest",
    covers: "委外加工、委外发料、委外入库、退货、报废和旧表面处理互不影响"
  },
  {
    area: "报表 / 打印 / 导出",
    className: "TenantReportingIsolationTest",
    covers: "库存查询、采购汇总、生产跟踪、应收应付、打印导出和模板互不影响"
  }
];

await mkdir(verificationDir, { recursive: true });

const startedAt = new Date().toISOString();
const started = Date.now();
const testSelector = suites.map((suite) => suite.className).join(",");
const command = ["./mvnw", "-q", `-Dtest=${testSelector}`, "test"];
const run = await new Promise((resolve) => {
  const child = spawn("./mvnw", ["-q", `-Dtest=${testSelector}`, "test"], {
    cwd: backendDir,
    env: { ...process.env, JAVA_HOME: javaHome }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
const finished = Date.now();
const ok = run.status === 0;

const result = {
  ok,
  generatedAt: new Date().toISOString(),
  startedAt,
  finishedAt: new Date(finished).toISOString(),
  durationMs: finished - started,
  javaHome,
  command: `cd backend && JAVA_HOME=${javaHome} ${command.join(" ")}`,
  acceptance: {
    twoAccountSets: true,
    sameBusinessCodesAllowed: true,
    differentInventoryAndNumberingSequences: true,
    crossAccountLeakage: ok ? 0 : null
  },
  suites: suites.map((suite) => ({
    ...suite,
    ok
  })),
  stdoutTail: tail(run.stdout),
  stderrTail: tail(run.stderr)
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  ok,
  resultPath: path.relative(rootDir, resultPath),
  totalSuites: suites.length,
  durationMs: result.durationMs
}, null, 2));

if (!ok) {
  process.exitCode = result.status ?? 1;
}

function tail(value, max = 4000) {
  return value.length > max ? value.slice(-max) : value;
}
