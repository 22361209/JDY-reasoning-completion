import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";
import {
  assertCanonicalRegressionDockerEndpointSync,
  captureRegressionDockerOwnershipSync,
  regressionDockerExecutable,
  regressionDockerHostArgument,
  regressionDockerPostgresContainer,
  regressionDockerRedisContainer,
  regressionDockerToolPaths
} from "./regression-docker-lease.mjs";
import {
  regressionRedisDeleteOwnedPrimaryLua,
  regressionRedisValueDigestLua
} from "./regression-redis-lua.mjs";
import {
  assertRegressionExecutionBaselineSync,
  consumeRegressionExecutionBaselineCapabilitySync
} from "./regression-execution-integrity.mjs";

export const regressionChildGuardTokenEnvironment = "JDY_REGRESSION_CHILD_GUARD_TOKEN";
export const regressionDetachedSpawnLedgerFdEnvironment = "JDY_REGRESSION_DETACHED_SPAWN_LEDGER_FD";
export const regressionDetachedSpawnSigningKeyFdEnvironment = "JDY_REGRESSION_DETACHED_SPAWN_SIGNING_KEY_FD";
export const regressionExecutionBaselineFdEnvironment = "JDY_REGRESSION_EXECUTION_BASELINE_FD";
const controlEnvironmentNames = [
  regressionChildGuardTokenEnvironment,
  regressionDetachedSpawnLedgerFdEnvironment,
  regressionDetachedSpawnSigningKeyFdEnvironment,
  regressionExecutionBaselineFdEnvironment,
  "JDY_REGRESSION_RUN_ID",
  "JDY_REGRESSION_ADMIN_CREDENTIAL_FILE",
  "JDY_REGRESSION_ADMIN_CREDENTIAL_IDENTITY",
  "JDY_REGRESSION_ISOLATED_BACKEND_ONLY",
  "JDY_REGRESSION_SECRET_REPORT_FD",
  "JDY_REGRESSION_FIXTURE_LEDGER_PATH",
  "JDY_REGRESSION_FIXTURE_LEDGER_RUN_ID",
  "JDY_REGRESSION_PARENT_WATCHDOG_FD",
  "JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH",
  "JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE",
  "JDY_REGRESSION_DOCKER_WATCHDOG_PATH",
  "JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD",
  "NODE_OPTIONS"
];
const injectionEnvironmentNames = [
  "BASH_ENV",
  "BASHOPTS",
  "CDPATH",
  "CLASSPATH",
  "ENV",
  "GLOBIGNORE",
  "GRADLE_OPTS",
  "JAVA_HOME",
  "JDY_JAVA_HOME",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "M2_HOME",
  "MAVEN_ARGS",
  "MAVEN_CONFIG",
  "MAVEN_HOME",
  "MAVEN_OPTS",
  "MAVEN_PROJECTBASEDIR",
  "MAVEN_USER_HOME",
  "MVNW_PASSWORD",
  "MVNW_REPOURL",
  "MVNW_USERNAME",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "_JAVA_OPTIONS"
];
const guardStateSymbol = Symbol("jdy.regression.child-process-guard");
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const fsModule = require("node:fs");
const fsPromisesModule = require("node:fs/promises");
const eventEmitter = require("node:events").EventEmitter;
const httpModule = require("node:http");
const httpsModule = require("node:https");
const netModule = require("node:net");
const tlsModule = require("node:tls");
const workerThreadsModule = require("node:worker_threads");
const objectDefineProperty = Object.defineProperty.bind(Object);
const trustedObjectCreate = Object.create.bind(Object);
const trustedObjectFreeze = Object.freeze.bind(Object);
const trustedObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const trustedObjectGetOwnPropertyNames = Object.getOwnPropertyNames.bind(Object);
const trustedObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols.bind(Object);
const trustedObjectGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const trustedObjectHasOwn = Object.hasOwn.bind(Object);
const trustedReflectApply = Reflect.apply.bind(Reflect);
const TrustedError = Error;
const trustedArrayIsArray = Array.isArray.bind(Array);
const trustedArrayAt = Function.call.bind(Array.prototype.at);
const trustedArrayIncludes = Function.call.bind(Array.prototype.includes);
const trustedArrayPush = Function.call.bind(Array.prototype.push);
const trustedArraySlice = Function.call.bind(Array.prototype.slice);
const trustedArraySort = Array.prototype.sort;
const trustedBufferAlloc = Buffer.alloc.bind(Buffer);
const trustedBufferFrom = Buffer.from.bind(Buffer);
const trustedBufferIsBuffer = Buffer.isBuffer.bind(Buffer);
const trustedBufferToString = Function.call.bind(Buffer.prototype.toString);
const trustedCreateHash = createHash;
const trustedHashProbe = createHash("sha256");
const trustedHashUpdate = Function.call.bind(trustedHashProbe.update);
const trustedHashDigest = Function.call.bind(trustedHashProbe.digest);
const trustedRandomBytes = randomBytes;
const trustedJsonParse = JSON.parse.bind(JSON);
const trustedJsonStringify = JSON.stringify.bind(JSON);
const trustedNumber = Number;
const trustedNumberIsInteger = Number.isInteger.bind(Number);
const trustedBigInt = BigInt;
const trustedObjectEntries = Object.entries.bind(Object);
const trustedObjectFromEntries = Object.fromEntries.bind(Object);
const trustedPathBasename = path.basename.bind(path);
const trustedPathDirname = path.dirname.bind(path);
const trustedPathIsAbsolute = path.isAbsolute.bind(path);
const trustedPathJoin = path.join.bind(path);
const trustedPathResolve = path.resolve.bind(path);
const trustedPathSeparator = path.sep;
const trustedFileURLToPath = fileURLToPath;
const TrustedURL = URL;
const trustedProcessCwd = process.cwd.bind(process);
const trustedRegExpTest = Function.call.bind(RegExp.prototype.test);
const trustedRegExpExec = Function.call.bind(RegExp.prototype.exec);
const trustedSetHas = Function.call.bind(Set.prototype.has);
const trustedString = String;
const trustedStringIncludes = Function.call.bind(String.prototype.includes);
const trustedStringSlice = Function.call.bind(String.prototype.slice);
const trustedStringReplace = Function.call.bind(String.prototype.replace);
const trustedStringSplit = Function.call.bind(String.prototype.split);
const trustedStringStartsWith = Function.call.bind(String.prototype.startsWith);
const trustedStringTrim = Function.call.bind(String.prototype.trim);
const trustedSign = sign;
const trustedIsProxy = utilTypes.isProxy.bind(utilTypes);
const trustedUrlHrefGetter = trustedObjectGetOwnPropertyDescriptor(URL.prototype, "href")?.get;
const trustedStatsProbe = lstatSync(import.meta.filename, { bigint: true });
const trustedStatsIsFile = Function.call.bind(trustedStatsProbe.isFile);
const trustedStatsIsSymbolicLink = Function.call.bind(trustedStatsProbe.isSymbolicLink);
const trustedUid = typeof process.getuid === "function" ? process.getuid() : null;
const trustedProcessRawKill = process._kill.bind(process);
const trustedSignalNumberByName = Object.freeze({
  SIGKILL: Number(osConstants.signals.SIGKILL),
  SIGTERM: Number(osConstants.signals.SIGTERM)
});
const trustedProcessOnce = process.once.bind(process);
const trustedEventOnce = Function.call.bind(eventEmitter.prototype.once);
const approvedManifestChildRoots = new WeakMap();
const trustedWeakMapGet = Function.call.bind(WeakMap.prototype.get);
const trustedWeakMapSet = Function.call.bind(WeakMap.prototype.set);
const trustedMapGet = Function.call.bind(Map.prototype.get);
const trustedMapSet = Function.call.bind(Map.prototype.set);
const trustedAtomicsWait = Atomics.wait.bind(Atomics);
const trustedWatchdogWaitArray = new Int32Array(new SharedArrayBuffer(4));
const trustedLedgerWriteSync = writeSync;
const trustedLedgerFsyncSync = fsyncSync;
const trustedCloseSync = closeSync;
const trustedFstatSync = fstatSync;
const trustedLstatSync = lstatSync;
const trustedOpenSync = openSync;
const trustedReadFileSync = readFileSync;
const trustedRealpathSync = (realpathSync.native || realpathSync).bind(null);
const maximumDockerIntents = 256;
let activeDetachedSpawnSeal = null;
let regressionDockerOwnership = null;
let regressionExecutionBaseline = null;
let regressionProtectedSuiteLockDir = "";
const workspaceRoot = trustedPathResolve(import.meta.dirname, "../..");
const trustedPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const trustedJavaHome = trustedRealpathSync("/opt/homebrew/opt/openjdk@21");
const trustedNodeExecutable = trustedRealpathSync(process.execPath);
const expectedDockerWatchdogPath = trustedPathJoin(
  import.meta.dirname,
  "regression-docker-lease-watchdog.mjs"
);
const dockerTargetWrapperScript = String.raw`
umask 077
run_id="$1"
guard_token="$2"
lease_id="$3"
tool="$4"
application_name="$5"
shift 5
lease_dir="/tmp/jdy-regression-owned-exec/$run_id/$guard_token/$lease_id"
state_file="$lease_dir/state"
cancel_file="$lease_dir/cancel"
start_file="$lease_dir/start"
/usr/bin/mkdir -p "$lease_dir"
/usr/bin/chmod 700 "$lease_dir"
[ ! -e "$state_file" ] || exit 91
printf 'ARMING||||%s\n' "$lease_id" > "$state_file"
if [ -e "$cancel_file" ]; then
  printf 'CANCELLED||||%s\n' "$lease_id" > "$state_file.tmp"
  /usr/bin/mv "$state_file.tmp" "$state_file"
  /usr/bin/rm -f "$start_file"
  exit 125
fi
export JDY_REGRESSION_DOCKER_LEASE="$lease_id"
(
  gate_attempt=0
  while [ "$gate_attempt" -lt 3000 ]; do
    gate_attempt=$((gate_attempt + 1))
    [ ! -e "$cancel_file" ] || exit 125
    [ ! -e "$start_file" ] || break
    /usr/bin/sleep 0.01
  done
  [ -e "$start_file" ] || exit 124
  [ ! -e "$cancel_file" ] || exit 125
  if [ -n "$application_name" ]; then
    export PGAPPNAME="$application_name"
  fi
  exec "$tool" "$@"
) &
tool_pid=$!
tool_start=$(/usr/bin/awk '{print $22}' "/proc/$tool_pid/stat") || {
  # The gated child may exit before /proc exposes a stable identity (for
  # example because cleanup published cancel immediately after ARMING).  Never
  # erase the only durable lease receipt: reap the child and publish a terminal
  # state that cleanup can independently verify before marking CLOSED.
  set +e
  wait "$tool_pid"
  tool_status=$?
  set -e
  if [ -e "$cancel_file" ]; then
    printf 'CANCELLED||||%s\n' "$lease_id" > "$state_file.tmp"
  else
    printf 'DONE||||%s\n' "$lease_id" > "$state_file.tmp"
  fi
  /usr/bin/mv "$state_file.tmp" "$state_file"
  /usr/bin/rm -f "$start_file"
  exit "$tool_status"
}
[ -n "$tool_start" ] && printf '%s\n' "$tool_start" | /usr/bin/grep -Eq '^[0-9]+$' || {
  set +e
  wait "$tool_pid"
  tool_status=$?
  set -e
  if [ -e "$cancel_file" ]; then
    printf 'CANCELLED||||%s\n' "$lease_id" > "$state_file.tmp"
  else
    printf 'DONE||||%s\n' "$lease_id" > "$state_file.tmp"
  fi
  /usr/bin/mv "$state_file.tmp" "$state_file"
  /usr/bin/rm -f "$start_file"
  exit "$tool_status"
}
printf 'ACTIVE|%s|%s|%s|%s\n' "$tool_pid" "$tool_start" "$tool" "$lease_id" > "$state_file.tmp"
/usr/bin/mv "$state_file.tmp" "$state_file"
if [ -e "$cancel_file" ]; then
  /bin/kill -TERM -- "$tool_pid" 2>/dev/null || true
else
  : > "$start_file"
fi
set +e
wait "$tool_pid"
tool_status=$?
set -e
printf 'DONE||||%s\n' "$lease_id" > "$state_file.tmp"
/usr/bin/mv "$state_file.tmp" "$state_file"
/usr/bin/rm -f "$start_file"
exit "$tool_status"
`;
const playwrightDefaultChromiumArguments = Object.freeze([
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-edgeupdater",
  "--disable-extensions",
  "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
  "--enable-features=CDPScreenshotNewSurface",
  "--allow-pre-commit-input",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-updater-scheduler",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-service-autorun",
  "--export-tagged-pdf",
  "--disable-search-engine-choice-screen",
  "--unsafely-disable-devtools-self-xss-warnings",
  "--edge-skip-compat-layer-relaunch",
  "--disable-infobars",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--enable-unsafe-swiftshader",
  "--headless",
  "--hide-scrollbars",
  "--mute-audio",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
  "--no-sandbox"
]);

function fail(message) {
  throw new TrustedError(`regression child process guard rejected execution: ${message}`);
}

function childGuardTokenDigest(token) {
  return trustedCreateHash("sha256").update(trustedString(token)).digest("hex");
}

function descriptorIdentity(descriptor, { regular = false } = {}) {
  let metadata;
  try {
    metadata = fstatSync(descriptor);
  } catch {
    fail(`control descriptor ${descriptor} is unavailable`);
  }
  if (regular && (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid()))) {
    fail(`control descriptor ${descriptor} is not a private owned ledger`);
  }
  return Object.freeze({
    device: trustedString(metadata.dev),
    inode: trustedString(metadata.ino),
    mode: Number(metadata.mode),
    regular
  });
}

function assertDescriptorIdentity(descriptor, expected) {
  const actual = descriptorIdentity(descriptor, { regular: expected.regular });
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    fail(`control descriptor ${descriptor} identity changed`);
  }
}

function captureControlDescriptorProof() {
  if (process.env.JDY_REGRESSION_SECRET_REPORT_FD !== "3"
    || process.env[regressionDetachedSpawnLedgerFdEnvironment] !== "4") {
    fail("control descriptor metadata is unavailable");
  }
  const proof = Object.freeze({
    secret: descriptorIdentity(3),
    detachedLedger: descriptorIdentity(4, { regular: true })
  });
  delete process.env.JDY_REGRESSION_SECRET_REPORT_FD;
  return proof;
}

function captureDetachedSpawnSigner() {
  if (process.env[regressionDetachedSpawnSigningKeyFdEnvironment] !== "5") {
    fail("detached spawn signing descriptor is unavailable");
  }
  delete process.env[regressionDetachedSpawnSigningKeyFdEnvironment];
  const metadata = fstatSync(5);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 0
    || metadata.size < 1
    || metadata.size > 4096
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    fail("detached spawn signing descriptor is not one private unlinked capability");
  }
  const encodedCapability = trustedBufferAlloc(metadata.size);
  try {
    let offset = 0;
    while (offset < encodedCapability.length) {
      const count = readSync(5, encodedCapability, offset, encodedCapability.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== encodedCapability.length) fail("detached spawn signing descriptor is truncated");
    const capability = trustedJsonParse(trustedBufferToString(encodedCapability, "utf8"));
    const encoded = trustedString(capability?.privateKey || "");
    if (capability?.version !== 1
      || !trustedRegExpTest(/^[0-9a-f]{64}$/, trustedString(capability?.headerHash || ""))
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      fail("detached spawn signing capability is malformed");
    }
    const der = trustedBufferFrom(encoded, "base64");
    if (der.length === 0 || trustedBufferToString(der, "base64") !== encoded) {
      fail("detached spawn signing capability is malformed");
    }
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    der.fill(0);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      fail("detached spawn signing capability has an unexpected key type");
    }
    return {
      privateKey,
      sequence: 0,
      previousHash: capability.headerHash,
      intentCount: 0,
      dockerIntentCount: 0,
      dockerCompletedCount: 0,
      dockerAbortedCount: 0,
      spawnedCount: 0,
      failedCount: 0,
      sealed: false
    };
  } catch (error) {
    if (trustedStringStartsWith(trustedString(error?.message || error), "regression child process guard rejected")) throw error;
    fail("detached spawn signing capability is invalid");
  } finally {
    encodedCapability.fill(0);
    closeSync(5);
  }
}

function captureExecutionBaseline() {
  if (process.env[regressionExecutionBaselineFdEnvironment] !== "8") {
    fail("tracked execution baseline capability is unavailable");
  }
  delete process.env[regressionExecutionBaselineFdEnvironment];
  try {
    return consumeRegressionExecutionBaselineCapabilitySync(8, workspaceRoot);
  } catch (error) {
    fail(`tracked execution baseline capability is invalid: ${trustedString(error?.message || error)}`);
  } finally {
    closeSync(8);
  }
}

function assertControlDescriptorProof(proof) {
  assertDescriptorIdentity(3, proof.secret);
  assertDescriptorIdentity(4, proof.detachedLedger);
}

function normalizedInvocation(command, args) {
  const executable = trustedString(command || "");
  if (!executable || !trustedArrayIsArray(args)) {
    fail("command or argv is invalid");
  }
  const argv = snapshotPlainArray(args, "command argv", { stringify: true, maximumLength: 4_096 });
  return { executable, argv };
}

function snapshotPlainArray(value, label, { stringify = false, maximumLength = 4_096 } = {}) {
  if (!trustedArrayIsArray(value) || trustedIsProxy(value)) {
    fail(`${label} is not a plain array`);
  }
  const length = trustedNumber(value.length);
  if (!trustedNumberIsInteger(length) || length < 0 || length > maximumLength) {
    fail(`${label} length is invalid`);
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = trustedObjectGetOwnPropertyDescriptor(value, trustedString(index));
    if (!descriptor || !trustedObjectHasOwn(descriptor, "value")) {
      fail(`${label} contains an accessor or sparse entry`);
    }
    const item = descriptor.value;
    if (stringify) {
      if (!["string", "number", "bigint", "boolean"].includes(typeof item)) {
        fail(`${label} contains a non-primitive argument`);
      }
      trustedArrayPush(snapshot, trustedString(item));
    } else {
      trustedArrayPush(snapshot, item);
    }
  }
  return trustedObjectFreeze(snapshot);
}

function snapshotEnvironment(environment) {
  if (environment == null) return undefined;
  const snapshot = snapshotPlainRecord(environment, "child environment", 8_192);
  for (const [name, value] of trustedObjectEntries(snapshot)) {
    if (value == null) continue;
    if (!["string", "number", "bigint", "boolean"].includes(typeof value)) {
      fail(`child environment ${name} is not primitive`);
    }
    snapshot[name] = trustedString(value);
  }
  return trustedObjectFreeze(snapshot);
}

function snapshotPlainRecord(value, label, maximumKeys = 64) {
  if (!value || typeof value !== "object" || trustedArrayIsArray(value) || trustedIsProxy(value)) {
    fail(`${label} is not a plain object`);
  }
  // Only own enumerable data descriptors are copied into a null-prototype
  // record below. A library-specific prototype is therefore inert; Proxy
  // traps and accessors remain forbidden.
  trustedObjectGetPrototypeOf(value);
  if (trustedObjectGetOwnPropertySymbols(value).length !== 0) {
    fail(`${label} contains symbol properties`);
  }
  const names = trustedObjectGetOwnPropertyNames(value);
  if (names.length > maximumKeys) fail(`${label} has too many properties`);
  const snapshot = trustedObjectCreate(null);
  for (let index = 0; index < names.length; index += 1) {
    const name = trustedString(names[index]);
    const descriptor = trustedObjectGetOwnPropertyDescriptor(value, name);
    if (!descriptor || !trustedObjectHasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      fail(`${label} contains an accessor or hidden property`);
    }
    snapshot[name] = descriptor.value;
  }
  return snapshot;
}

function snapshotSpawnOptions(options) {
  if (options == null) return trustedObjectFreeze(trustedObjectCreate(null));
  const snapshot = snapshotPlainRecord(options, "child options", 16);
  const allowed = [
    "cwd", "detached", "encoding", "env", "maxBuffer", "shell", "stdio",
    "timeout", "killSignal", "windowsHide"
  ];
  for (const name of trustedObjectGetOwnPropertyNames(snapshot)) {
    if (!trustedArrayIncludes(allowed, name)) fail(`child option ${name} is forbidden`);
  }
  if (snapshot.cwd != null && typeof snapshot.cwd !== "string") fail("child cwd is invalid");
  if (snapshot.detached != null && typeof snapshot.detached !== "boolean") fail("child detached option is invalid");
  if (snapshot.shell != null && typeof snapshot.shell !== "boolean") fail("child shell option is invalid");
  if (snapshot.windowsHide != null && typeof snapshot.windowsHide !== "boolean") fail("child windowsHide option is invalid");
  if (snapshot.encoding != null && typeof snapshot.encoding !== "string") fail("child encoding option is invalid");
  if (snapshot.maxBuffer != null
    && (!trustedNumberIsInteger(snapshot.maxBuffer) || snapshot.maxBuffer <= 0)) {
    fail("child maxBuffer option is invalid");
  }
  if (snapshot.timeout != null
    && (!trustedNumberIsInteger(snapshot.timeout) || snapshot.timeout < 0)) {
    fail("child timeout option is invalid");
  }
  if (snapshot.killSignal != null
    && typeof snapshot.killSignal !== "string"
    && !trustedNumberIsInteger(snapshot.killSignal)) {
    fail("child killSignal option is invalid");
  }
  snapshot.env = snapshotEnvironment(snapshot.env);
  if (snapshot.stdio != null && typeof snapshot.stdio !== "string") {
    snapshot.stdio = snapshotPlainArray(snapshot.stdio, "child stdio", { maximumLength: 16 });
    for (let index = 0; index < snapshot.stdio.length; index += 1) {
      const item = snapshot.stdio[index];
      if (item != null && typeof item !== "string" && !trustedNumberIsInteger(item)) {
        fail("child stdio contains an unsafe entry");
      }
    }
  }
  return trustedObjectFreeze(snapshot);
}

function snapshotSpawnInvocation(command, argsOrOptions, options) {
  const executable = trustedString(command || "");
  if (!executable) fail("command or argv is invalid");
  let rawArguments;
  let rawOptions;
  if (trustedArrayIsArray(argsOrOptions)) {
    rawArguments = argsOrOptions;
    rawOptions = options;
  } else if (argsOrOptions == null || typeof argsOrOptions === "object") {
    rawArguments = [];
    rawOptions = argsOrOptions;
  } else {
    fail("spawn argv is invalid");
  }
  const argv = snapshotPlainArray(rawArguments, "command argv", { stringify: true, maximumLength: 4_096 });
  const optionSnapshot = snapshotSpawnOptions(rawOptions);
  return trustedObjectFreeze({ executable, argv, options: optionSnapshot });
}

function appendNormalizedArgument(target, ...values) {
  for (let index = 0; index < values.length; index += 1) {
    trustedArrayPush(target, values[index]);
  }
}

function safeRegressionDatabaseName(value) {
  return value === "jdy_erp"
    || value === "postgres"
    || trustedRegExpTest(/^jdy_a(?:141|142|143|146|147|151|167)_(?:mig|fresh|invalid)_[0-9a-f]{12}$/, value);
}

function normalizedPsqlArguments(argv) {
  const normalized = [];
  let userCount = 0;
  let databaseCount = 0;
  let commandCount = 0;
  let onErrorStopCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-X") continue;
    if (trustedRegExpTest(/^-[qtA]{1,3}$/, argument)) {
      normalized.push(argument);
      continue;
    }
    if (argument === "-v") {
      const setting = argv[index + 1];
      index += 1;
      if (setting !== "ON_ERROR_STOP=1") return null;
      onErrorStopCount += 1;
      continue;
    }
    if (argument === "-U") {
      const user = argv[index + 1];
      index += 1;
      if (user !== "jdy") return null;
      userCount += 1;
      normalized.push("-U", user);
      continue;
    }
    if (argument === "-d") {
      const database = argv[index + 1];
      index += 1;
      if (!safeRegressionDatabaseName(database)) return null;
      databaseCount += 1;
      normalized.push("-d", database);
      continue;
    }
    if (argument === "-c") {
      const command = argv[index + 1];
      index += 1;
      if (!command
        || trustedRegExpTest(/(^|[\r\n])\s*\\/, command)
        || trustedRegExpTest(/\bCOPY\b[\s\S]*\bPROGRAM\b/i, command)) {
        return null;
      }
      commandCount += 1;
      normalized.push("-c", command);
      continue;
    }
    return null;
  }
  if (userCount !== 1 || databaseCount !== 1 || commandCount !== 1 || onErrorStopCount > 1) return null;
  return ["-X", "-v", "ON_ERROR_STOP=1", ...normalized];
}

function normalizedPgDumpArguments(argv) {
  if (argv.length !== 8
    || argv[0] !== "-U"
    || argv[1] !== "jdy"
    || argv[2] !== "-d"
    || argv[3] !== "jdy_erp"
    || !trustedRegExpTest(/^--schema=[a-z][a-z0-9_]{0,62}$/, argv[4])
    || !trustedArrayIncludes(["--schema-only", "--data-only"], argv[5])
    || argv[6] !== "--no-owner"
    || argv[7] !== "--no-privileges") {
    return null;
  }
  return argv;
}

function normalizedCreateDatabaseArguments(argv) {
  if (argv.length !== 5
    || argv[0] !== "-U"
    || argv[1] !== "jdy"
    || argv[2] !== "-O"
    || argv[3] !== "jdy"
    || !trustedRegExpTest(/^jdy_a(?:141|142|143|146|147|151|167)_(?:mig|fresh|invalid)_[0-9a-f]{12}$/, argv[4])) {
    return null;
  }
  return argv;
}

function normalizedDropDatabaseArguments(argv) {
  if (argv.length !== 5
    || argv[0] !== "-U"
    || argv[1] !== "jdy"
    || argv[2] !== "--if-exists"
    || argv[3] !== "--force"
    || !trustedRegExpTest(/^jdy_a(?:141|142|143|146|147|151|167)_(?:mig|fresh|invalid)_[0-9a-f]{12}$/, argv[4])) {
    return null;
  }
  return argv;
}

const allowedRedisCommands = new Set([
  "DEL", "EXISTS", "GET", "HGET", "HGETALL", "LRANGE",
  "PEXPIRETIME", "PTTL", "SISMEMBER", "SMEMBERS", "SREM", "TIME",
  "TYPE", "ZRANGE"
]);

function normalizedRedisArguments(argv) {
  let index = 0;
  if (argv[index] === "-n") {
    if (argv[index + 1] !== "0") return null;
    index += 2;
  }
  if (argv[index] === "--raw") index += 1;
  const command = argv[index];
  const remaining = trustedArraySlice(argv, index);
  if (command === "BLPOP") {
    return remaining.length === 3
      && trustedRegExpTest(/^jdy:regression:docker-lease:[0-9a-f]{32}$/, remaining[1])
      && remaining[2] === "300"
      ? ["-n", "0", "--raw", ...remaining]
      : null;
  }
  if (command === "EVAL") {
    const script = remaining[1];
    const keyCount = remaining[2];
    const key = remaining[3];
    const sessionKey = trustedRegExpTest(
      /^[^\0\r\n\s]{1,1024}:sessions:[^\0\r\n\s]{1,1024}$/,
      trustedString(key || "")
    );
    if (keyCount !== "1" || !sessionKey) return null;
    if (script === regressionRedisValueDigestLua && remaining.length === 4) {
      return ["-n", "0", "--raw", ...remaining];
    }
    if (script === regressionRedisDeleteOwnedPrimaryLua
      && remaining.length === 7
      && trustedArraySlice(remaining, 4).every((digest) => (
        trustedRegExpTest(/^[0-9a-f]{40}$/, digest)
      ))) {
      return ["-n", "0", "--raw", ...remaining];
    }
    return null;
  }
  if (command === "--scan") {
    return remaining.length === 3
      && remaining[1] === "--pattern"
      && remaining[2].length > 0
      && remaining[2].length <= 1024
      ? ["-n", "0", "--raw", ...remaining]
      : null;
  }
  if (!trustedSetHas(allowedRedisCommands, command) || remaining.length > 256) return null;
  return ["-n", "0", "--raw", ...remaining];
}

function normalizedDockerInvocation(argv) {
  if (argv[0] !== "exec") return null;
  let index = 1;
  while (argv[index] === "-i") index += 1;
  let applicationName = "";
  if (argv[index] === "-e") {
    const applicationNameAssignment = argv[index + 1];
    if (!trustedRegExpTest(/^PGAPPNAME=a172_lock_[0-9]{10}$/, applicationNameAssignment)) return null;
    applicationName = trustedStringSlice(applicationNameAssignment, "PGAPPNAME=".length);
    index += 2;
  }
  const container = argv[index];
  const tool = argv[index + 1];
  const toolArguments = trustedArraySlice(argv, index + 2);
  if (!container || !tool) return null;
  let normalizedToolArguments = null;
  if (container === regressionDockerPostgresContainer && tool === "psql") {
    normalizedToolArguments = normalizedPsqlArguments(toolArguments);
  } else if (container === regressionDockerPostgresContainer && tool === "pg_dump") {
    normalizedToolArguments = normalizedPgDumpArguments(toolArguments);
  } else if (container === regressionDockerPostgresContainer && tool === "createdb") {
    normalizedToolArguments = normalizedCreateDatabaseArguments(toolArguments);
  } else if (container === regressionDockerPostgresContainer && tool === "dropdb") {
    normalizedToolArguments = normalizedDropDatabaseArguments(toolArguments);
  } else if (container === regressionDockerRedisContainer && tool === "redis-cli") {
    normalizedToolArguments = normalizedRedisArguments(toolArguments);
  }
  if (!normalizedToolArguments) return null;
  return {
    kind: "docker",
    container,
    tool,
    toolPath: regressionDockerToolPaths[tool],
    toolArguments: normalizedToolArguments,
    applicationName
  };
}

function flywayInvocationIsAllowed(argv) {
  if ((argv.length !== 5 && argv.length !== 6)
    || argv[0] !== "org.flywaydb:flyway-maven-plugin:11.7.2:migrate"
    || !trustedRegExpTest(/^-Dflyway\.url=jdbc:postgresql:\/\/(?:127\.0\.0\.1|localhost):5432\/[a-z][a-z0-9_]{0,62}$/, argv[1])
    || !trustedRegExpTest(/^-Dflyway\.user=[A-Za-z0-9_.-]{1,80}$/, argv[2])
    || !trustedStringStartsWith(argv[3], "-Dflyway.password=")
    || argv[3].length > 240
    || argv[4] !== `-Dflyway.locations=filesystem:${trustedPathJoin(workspaceRoot, "backend/src/main/resources/db/migration")}`) {
    return false;
  }
  return argv.length === 5 || trustedRegExpTest(/^-Dflyway\.target=[0-9]{1,6}$/, argv[5]);
}

function gitInvocationIsAllowed(argv) {
  if (trustedJsonStringify(argv) === trustedJsonStringify(["rev-parse", "--verify", "HEAD"])) return true;
  if (argv[0] === "ls-files" && argv[1] === "--error-unmatch" && argv[2] === "--" && argv.length === 4) {
    return !trustedPathIsAbsolute(argv[3]) && !containsParentPathSegment(argv[3]);
  }
  if (argv[0] === "status"
    && argv[1] === "--porcelain=v1"
    && argv[2] === "--untracked-files=all"
    && argv[3] === "--"
    && argv.length >= 5) {
    for (const entry of trustedArraySlice(argv, 4)) {
      if (trustedPathIsAbsolute(entry) || containsParentPathSegment(entry)) return false;
    }
    return true;
  }
  return false;
}

function containsParentPathSegment(value) {
  for (const segment of trustedStringSplit(value, /[\\/]/)) {
    if (segment === "..") return true;
  }
  return false;
}

function resolveExpectedPlaywrightExecutable() {
  const packageRoot = trustedPathDirname(require.resolve("playwright-core/package.json"));
  let browsers;
  try {
    browsers = trustedJsonParse(readFileSync(trustedPathJoin(packageRoot, "browsers.json"), "utf8"));
  } catch {
    fail("Playwright browser registry is unreadable");
  }
  const revision = trustedString(browsers?.browsers?.find(({ name }) => name === "chromium-headless-shell")?.revision || "");
  if (!trustedRegExpTest(/^\d{3,6}$/, revision)) fail("Playwright Chromium revision is invalid");
  let browserRoot;
  let relativeCandidates;
  if (process.platform === "darwin") {
    browserRoot = trustedPathJoin(homedir(), "Library/Caches/ms-playwright");
    relativeCandidates = [
      trustedPathJoin(`chromium_headless_shell-${revision}`, `chrome-headless-shell-mac-${process.arch}`, "chrome-headless-shell")
    ];
  } else if (process.platform === "linux") {
    browserRoot = trustedPathJoin(homedir(), ".cache/ms-playwright");
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    relativeCandidates = [
      trustedPathJoin(`chromium_headless_shell-${revision}`, `chrome-headless-shell-linux-${architecture}`, "chrome-headless-shell"),
      trustedPathJoin(`chromium_headless_shell-${revision}`, "chrome-headless-shell-linux64", "chrome-headless-shell")
    ];
  } else {
    fail(`Playwright Chromium is unsupported on ${process.platform}`);
  }
  for (const relative of relativeCandidates) {
    const candidate = trustedPathJoin(browserRoot, relative);
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (trustedRealpathSync(candidate) !== candidate) continue;
      return candidate;
    } catch {
      // Try the next package-defined platform layout.
    }
  }
  fail("the canonical Playwright Chromium executable is unavailable");
}

const expectedPlaywrightExecutable = resolveExpectedPlaywrightExecutable();
const trustedJavaExecutable = trustedRealpathSync(trustedPathJoin(trustedJavaHome, "bin/java"));
const trustedJavacExecutable = trustedRealpathSync(trustedPathJoin(trustedJavaHome, "bin/javac"));

function stableTrustedExecutableIdentity(executable, label, expected = null) {
  let pathMetadata;
  let descriptor = -1;
  try {
    pathMetadata = trustedLstatSync(executable, { bigint: true });
    if (!trustedStatsIsFile(pathMetadata)
      || trustedStatsIsSymbolicLink(pathMetadata)
      || pathMetadata.nlink !== 1n
      || (trustedUid !== null && pathMetadata.uid !== trustedBigInt(trustedUid))
      || (pathMetadata.mode & 0o111n) === 0n
      || trustedRealpathSync(executable) !== executable) {
      fail(`${label} is not one owned canonical executable`);
    }
    descriptor = trustedOpenSync(executable, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = trustedFstatSync(descriptor, { bigint: true });
    if (!trustedStatsIsFile(before)
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
      || before.nlink !== 1n
      || before.size < 1n
      || before.size > 1024n * 1024n * 1024n) {
      fail(`${label} changed before identity capture`);
    }
    const bytes = trustedReadFileSync(descriptor);
    const after = trustedFstatSync(descriptor, { bigint: true });
    const afterPath = trustedLstatSync(executable, { bigint: true });
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || after.nlink !== 1n
      || afterPath.dev !== before.dev
      || afterPath.ino !== before.ino
      || afterPath.size !== before.size
      || afterPath.mtimeNs !== before.mtimeNs
      || afterPath.ctimeNs !== before.ctimeNs
      || trustedBigInt(bytes.length) !== before.size) {
      fail(`${label} changed while its identity was captured`);
    }
    const identity = trustedObjectFreeze({
      device: trustedString(before.dev),
      inode: trustedString(before.ino),
      mode: trustedNumber(before.mode & 0o777n),
      size: trustedNumber(before.size),
      mtimeNs: trustedString(before.mtimeNs),
      ctimeNs: trustedString(before.ctimeNs),
      sha256: trustedHashDigest(trustedHashUpdate(trustedCreateHash("sha256"), bytes), "hex")
    });
    if (expected != null && trustedJsonStringify(identity) !== trustedJsonStringify(expected)) {
      fail(`${label} identity drifted after guard installation`);
    }
    return identity;
  } catch (error) {
    if (error instanceof TrustedError
      && trustedStringStartsWith(error.message, "regression child process guard rejected execution:")) {
      throw error;
    }
    fail(`${label} identity is unavailable`);
  } finally {
    if (descriptor >= 0) trustedCloseSync(descriptor);
  }
}

const trustedExecutableIdentities = trustedObjectFreeze({
  node: stableTrustedExecutableIdentity(trustedNodeExecutable, "Node executable"),
  java: stableTrustedExecutableIdentity(trustedJavaExecutable, "Java executable"),
  javac: stableTrustedExecutableIdentity(trustedJavacExecutable, "Javac executable"),
  chromium: stableTrustedExecutableIdentity(expectedPlaywrightExecutable, "Playwright Chromium executable")
});

function assertTrustedExecutableIdentity(executable, label, expected) {
  stableTrustedExecutableIdentity(executable, label, expected);
}

function playwrightArgumentsAreAllowed(argv) {
  if (argv.length < 3) return false;
  const userDataArgument = trustedArrayAt(argv, -3);
  if (!trustedStringStartsWith(trustedString(userDataArgument), "--user-data-dir=")
    || trustedArrayAt(argv, -2) !== "--remote-debugging-pipe"
    || trustedArrayAt(argv, -1) !== "--no-startup-window") {
    return false;
  }
  const profilePath = trustedPathResolve(trustedStringSlice(trustedString(userDataArgument), "--user-data-dir=".length));
  try {
    const metadata = lstatSync(profilePath);
    if (trustedPathDirname(profilePath) !== trustedPathResolve(tmpdir())
      || !trustedRegExpTest(/^playwright_chromiumdev_profile-[A-Za-z0-9_-]{4,32}$/, trustedPathBasename(profilePath))
      || !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (metadata.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || trustedPathDirname(trustedRealpathSync(profilePath)) !== trustedRealpathSync(trustedPathResolve(tmpdir()))) {
      return false;
    }
  } catch {
    return false;
  }
  const configured = trustedArraySlice(argv, 0, -3);
  const allowedConfigured = trustedArrayAt(configured, -1) === "--disable-gpu"
    ? trustedArraySlice(configured, 0, -1)
    : configured;
  return trustedJsonStringify(allowedConfigured) === trustedJsonStringify(playwrightDefaultChromiumArguments);
}

function playwrightBrowserLaunchIsAllowed(executable, argv, options) {
  let canonicalExecutable = "";
  try {
    canonicalExecutable = trustedRealpathSync(executable);
  } catch {
    return false;
  }
  const allowed = trustedPathIsAbsolute(executable)
    && trustedPathResolve(executable) === expectedPlaywrightExecutable
    && canonicalExecutable === expectedPlaywrightExecutable
    && playwrightArgumentsAreAllowed(argv)
    && trustedPathResolve(trustedString(options?.cwd || trustedProcessCwd())) === workspaceRoot
    && options?.detached === (process.platform !== "win32")
    && trustedJsonStringify(options?.stdio) === trustedJsonStringify(["ignore", "pipe", "pipe", "pipe", "pipe"]);
  if (allowed) {
    assertTrustedExecutableIdentity(
      expectedPlaywrightExecutable,
      "Playwright Chromium executable",
      trustedExecutableIdentities.chromium
    );
  }
  return allowed;
}

function invocationPolicy(command, args, options) {
  const { executable, argv } = normalizedInvocation(command, args);
  const cwd = trustedPathResolve(trustedString(options?.cwd || trustedProcessCwd()));
  if (playwrightBrowserLaunchIsAllowed(executable, argv, options)) {
    return {
      allowed: true,
      allowDetached: false,
      rewriteDetachedIntoOwnedGroup: true,
      executable: expectedPlaywrightExecutable
    };
  }
  if (executable === "docker") {
    const docker = normalizedDockerInvocation(argv);
    return docker
      ? { allowed: true, allowDetached: false, ...docker }
      : { allowed: false, allowDetached: false, executable };
  }
  if (executable === "./scripts/backend-test.sh") {
    assertTrustedExecutableIdentity(trustedJavaExecutable, "Java executable", trustedExecutableIdentities.java);
    assertTrustedExecutableIdentity(trustedJavacExecutable, "Javac executable", trustedExecutableIdentities.javac);
    return {
      allowed: cwd === workspaceRoot && flywayInvocationIsAllowed(argv),
      allowDetached: false
    };
  }
  if (executable === "./mvnw") {
    assertTrustedExecutableIdentity(trustedJavaExecutable, "Java executable", trustedExecutableIdentities.java);
    assertTrustedExecutableIdentity(trustedJavacExecutable, "Javac executable", trustedExecutableIdentities.javac);
    return {
      allowed: cwd === trustedPathJoin(workspaceRoot, "backend")
        && ((argv.length === 1 && argv[0] === "spring-boot:run")
          || (argv.length === 3 && argv[0] === "-q" && trustedRegExpTest(/^-Dtest=[A-Za-z0-9_,]+$/, argv[1]) && argv[2] === "test")),
      allowDetached: false
    };
  }
  if (executable === "/usr/bin/unzip") {
    return { allowed: argv[0] === "-Z1" || argv[0] === "-p", allowDetached: false };
  }
  if (executable === "git") {
    return { allowed: cwd === workspaceRoot && gitInvocationIsAllowed(argv), allowDetached: false };
  }
  if (executable === "ps") {
    const standardSnapshot = ["-ww", "-axo", "pid=,ppid=,state=,lstart=,comm="];
    const groupSnapshot = ["-ww", "-axo", "pid=,ppid=,pgid=,state=,lstart=,comm="];
    return {
      allowed: trustedJsonStringify(argv) === trustedJsonStringify(standardSnapshot)
        || trustedJsonStringify(argv) === trustedJsonStringify(groupSnapshot),
      allowDetached: false
    };
  }
  if (executable === trustedNodeExecutable && argv.length === 1) {
    assertTrustedExecutableIdentity(trustedNodeExecutable, "Node executable", trustedExecutableIdentities.node);
    const requestedProgram = trustedPathResolve(argv[0]);
    return {
      allowed: requestedProgram === trustedPathResolve(import.meta.dirname, "regression-child-guard-probe.mjs"),
      allowDetached: false
    };
  }
  return { allowed: false, allowDetached: false, executable };
}

function guardedEnvironment(environment) {
  if (environment != null && (typeof environment !== "object" || trustedArrayIsArray(environment))) {
    fail("child environment is invalid");
  }
  const guarded = { ...process.env, ...(environment || {}) };
  for (const name of controlEnvironmentNames) {
    if (trustedObjectHasOwn(process.env, name)) guarded[name] = process.env[name];
    else delete guarded[name];
  }
  delete guarded[regressionChildGuardTokenEnvironment];
  delete guarded[regressionDetachedSpawnLedgerFdEnvironment];
  for (const name of injectionEnvironmentNames) delete guarded[name];
  for (const [name] of trustedObjectEntries(guarded)) {
    if (trustedStringStartsWith(name, "DOCKER_")) delete guarded[name];
  }
  guarded.JDY_POSTGRES_CONTAINER = regressionDockerPostgresContainer;
  guarded.JDY_POSTGRES_USER = "jdy";
  guarded.JDY_POSTGRES_DATABASE = "jdy_erp";
  guarded.JDY_DATABASE = "jdy_erp";
  guarded.JDY_DATABASE_USER = "jdy";
  guarded.JDY_DATABASE_PASSWORD = "jdy_dev";
  guarded.JDY_REDIS_CONTAINER = regressionDockerRedisContainer;
  guarded.JDY_REDIS_DB = "0";
  guarded.PATH = trustedPath;
  guarded.JAVA_HOME = trustedJavaHome;
  return guarded;
}

function guardedStdio(stdio) {
  let normalized;
  if (stdio == null) normalized = ["pipe", "pipe", "pipe"];
  else if (typeof stdio === "string") normalized = [stdio, stdio, stdio];
  else if (trustedArrayIsArray(stdio)) normalized = [...stdio];
  else fail("stdio configuration is invalid");
  while (normalized.length < 3) normalized.push("pipe");
  let controlDescriptorIndex = Math.max(3, normalized.length);
  while (normalized[controlDescriptorIndex] != null) controlDescriptorIndex += 1;
  normalized[controlDescriptorIndex] = 3;
  return { stdio: normalized, controlDescriptorIndex };
}

function guardedOptions(options, { inheritControlDescriptor, allowDetached, rewriteDetachedIntoOwnedGroup = false }) {
  if (options != null && (typeof options !== "object" || trustedArrayIsArray(options))) {
    fail("child options are invalid");
  }
  const guarded = { ...(options || {}) };
  if (guarded.detached === true && !allowDetached && !rewriteDetachedIntoOwnedGroup) {
    fail("detached process creation is forbidden");
  }
  if (guarded.shell) fail("shell execution is forbidden");
  guarded.detached = allowDetached && guarded.detached === true;
  guarded.env = guardedEnvironment(guarded.env);
  if (inheritControlDescriptor) {
    const inherited = guardedStdio(guarded.stdio);
    guarded.stdio = inherited.stdio;
    guarded.env.JDY_REGRESSION_SECRET_REPORT_FD = trustedString(inherited.controlDescriptorIndex);
  }
  return guarded;
}

function captureApprovedChildProcessIdentity(pid, originalExecFileSync) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let output = "";
    try {
      output = trustedString(originalExecFileSync("/bin/ps", [
        "-ww", "-p", trustedString(pid), "-o", "pid=,state=,lstart="
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch {
      trustedAtomicsWait(trustedWatchdogWaitArray, 0, 0, 5);
      continue;
    }
    const match = trustedRegExpExec(
      /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s*$/,
      trustedStringTrim(output)
    );
    if (match && trustedNumber(match[1]) === pid && !trustedStringStartsWith(match[2], "Z")) {
      const approvedTargets = new Map();
      trustedMapSet(
        approvedTargets,
        pid,
        trustedStringReplace(trustedStringTrim(match[3]), /\s+/g, " ")
      );
      return trustedObjectFreeze({
        pid,
        lstart: trustedStringReplace(trustedStringTrim(match[3]), /\s+/g, " "),
        approvedTargets
      });
    }
    trustedAtomicsWait(trustedWatchdogWaitArray, 0, 0, 5);
  }
  fail("approved child process identity could not be proven");
}

function guardedChildHandle(child, originalExecFileSync) {
  if (!trustedNumberIsInteger(child?.pid) || child.pid <= 1) {
    fail("approved child process has no stable pid");
  }
  trustedWeakMapSet(
    approvedManifestChildRoots,
    child,
    captureApprovedChildProcessIdentity(child.pid, originalExecFileSync)
  );
  objectDefineProperty(child, "unref", {
    configurable: false,
    writable: false,
    value() {
      fail("child unref is forbidden");
    }
  });
  return child;
}

function approvedChildOwnsSignalTarget(childHandle, targetPid, originalExecFileSync) {
  const rootIdentity = trustedWeakMapGet(approvedManifestChildRoots, childHandle);
  const rootPid = trustedNumber(rootIdentity?.pid);
  if (!trustedNumberIsInteger(rootPid) || rootPid <= 1) return false;
  let output;
  try {
    output = trustedString(originalExecFileSync("/bin/ps", [
      "-ww", "-axo", "pid=,ppid=,pgid=,state=,lstart=,comm="
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return false;
  }
  const relationships = [];
  const lines = trustedStringSplit(output, "\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = trustedRegExpExec(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/,
      lines[index]
    );
    if (!match || trustedStringStartsWith(match[4], "Z")) continue;
    trustedArrayPush(relationships, {
      pid: trustedNumber(match[1]),
      parentPid: trustedNumber(match[2]),
      pgid: trustedNumber(match[3]),
      lstart: trustedStringReplace(trustedStringTrim(match[5]), /\s+/g, " ")
    });
  }
  let target = null;
  let root = null;
  for (let index = 0; index < relationships.length; index += 1) {
    const relationship = relationships[index];
    if (relationship.pid === targetPid) target = relationship;
    if (relationship.pid === rootPid) root = relationship;
  }
  if (!target) return false;
  if (trustedMapGet(rootIdentity.approvedTargets, targetPid) === target.lstart) return true;
  let ownedGroupAnchored = Boolean(root && root.lstart === rootIdentity.lstart);
  if (!ownedGroupAnchored) {
    for (let index = 0; index < relationships.length; index += 1) {
      const relationship = relationships[index];
      if (relationship.pgid === rootPid
        && trustedMapGet(rootIdentity.approvedTargets, relationship.pid) === relationship.lstart) {
        ownedGroupAnchored = true;
        break;
      }
    }
  }
  if (!ownedGroupAnchored) return false;
  let current = targetPid;
  for (let depth = 0; depth < 512; depth += 1) {
    if ((root && root.lstart === rootIdentity.lstart && current === rootPid)
      || target.pgid === rootPid) {
      trustedMapSet(rootIdentity.approvedTargets, targetPid, target.lstart);
      return true;
    }
    let parentPid = 0;
    for (let index = 0; index < relationships.length; index += 1) {
      const relationship = relationships[index];
      if (relationship.pid === current) {
        parentPid = relationship.parentPid;
        break;
      }
    }
    if (!trustedNumberIsInteger(parentPid) || parentPid <= 1 || parentPid === current) return false;
    current = parentPid;
  }
  return false;
}

function canonicalSignedPayload(record) {
  const entries = [];
  for (const entry of trustedObjectEntries(record)) {
    if (entry[0] !== "signature") entries.push(entry);
  }
  trustedArraySort.call(entries, ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return trustedBufferFrom(trustedJsonStringify(trustedObjectFromEntries(entries)));
}

function canonicalRecord(record) {
  const entries = trustedObjectEntries(record);
  trustedArraySort.call(entries, ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return trustedBufferFrom(trustedJsonStringify(trustedObjectFromEntries(entries)));
}

function appendDetachedSpawnLedgerRecord(descriptorProof, signer, record) {
  assertControlDescriptorProof(descriptorProof);
  if (signer.sealed) fail("detached spawn ledger is already sealed");
  signer.sequence += 1;
  const signedRecord = {
    ...record,
    sequence: signer.sequence,
    previousHash: signer.previousHash
  };
  signedRecord.signature = trustedBufferToString(
    trustedSign(null, canonicalSignedPayload(signedRecord), signer.privateKey),
    "base64"
  );
  const payload = trustedBufferFrom(`${trustedJsonStringify(signedRecord)}\n`);
  let offset = 0;
  while (offset < payload.length) {
    offset += trustedLedgerWriteSync(4, payload, offset, payload.length - offset, null);
  }
  trustedLedgerFsyncSync(4);
  assertControlDescriptorProof(descriptorProof);
  signer.previousHash = trustedCreateHash("sha256").update(canonicalRecord(signedRecord)).digest("hex");
  if (record.type === "intent") signer.intentCount += 1;
  else if (record.type === "docker-intent") signer.dockerIntentCount += 1;
  else if (record.type === "docker-completed") signer.dockerCompletedCount += 1;
  else if (record.type === "docker-aborted") signer.dockerAbortedCount += 1;
  else if (record.type === "spawned") signer.spawnedCount += 1;
  else if (record.type === "failed") signer.failedCount += 1;
  else if (record.type === "seal") signer.sealed = true;
}

function sealDetachedSpawnLedger(descriptorProof, signer) {
  if (signer.sealed) return;
  appendDetachedSpawnLedgerRecord(descriptorProof, signer, {
    type: "seal",
    recordCount: signer.sequence,
    intentCount: signer.intentCount,
    dockerIntentCount: signer.dockerIntentCount,
    dockerCompletedCount: signer.dockerCompletedCount,
    dockerAbortedCount: signer.dockerAbortedCount,
    spawnedCount: signer.spawnedCount,
    failedCount: signer.failedCount
  });
}

function detachedProcessIdentity(child, expectedProgram, originalExecFileSync) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let output = "";
    try {
      output = trustedString(originalExecFileSync("/bin/ps", [
        "-ww", "-p", trustedString(child.pid), "-o", "pid=,ppid=,pgid=,lstart=,command="
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch {
      continue;
    }
    const match = trustedRegExpExec(
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/,
      trustedStringTrim(output)
    );
    if (!match) continue;
    const pid = trustedNumber(match[1]);
    const parentPid = trustedNumber(match[2]);
    const pgid = trustedNumber(match[3]);
    const lstart = trustedStringReplace(trustedStringTrim(trustedString(match[4])), /\s+/g, " ");
    const command = trustedString(match[5]);
    if (pid === child.pid
      && parentPid === process.pid
      && pgid === child.pid
      && trustedStringIncludes(command, expectedProgram)) {
      return {
        pid,
        parentPid,
        pgid,
        lstart,
        commandFingerprint: trustedCreateHash("sha256").update(command).digest("hex")
      };
    }
  }
  fail("Docker lease watchdog process identity could not be proven");
}

function createPrivateUnlinkedDescriptor(secretDir, label, payload = trustedBufferAlloc(0)) {
  const directory = lstatSync(secretDir);
  if (!directory.isDirectory()
    || directory.isSymbolicLink()
    || (directory.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && directory.uid !== process.getuid())) {
    fail(`Docker lease watchdog ${label} directory is unsafe`);
  }
  const temporaryPath = trustedPathJoin(
    secretDir,
    `.docker-watchdog-${label}.${process.pid}.${trustedBufferToString(trustedRandomBytes(8), "hex")}.tmp`
  );
  let descriptor = -1;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      0o600
    );
    if (payload.length > 0) {
      const written = writeSync(descriptor, payload, 0, payload.length, 0);
      if (written !== payload.length) fail(`Docker lease watchdog ${label} capability is truncated`);
    }
    fsyncSync(descriptor);
    unlinkSync(temporaryPath);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 0
      || metadata.size !== payload.length
      || (metadata.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      fail(`Docker lease watchdog ${label} capability is unsafe`);
    }
    return descriptor;
  } catch (error) {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch { /* preserve the capability error */ }
    }
    try { unlinkSync(temporaryPath); } catch { /* the capability may already be unlinked */ }
    if (trustedStringStartsWith(trustedString(error?.message || error), "regression child process guard rejected")) throw error;
    fail(`Docker lease watchdog ${label} capability could not be created`);
  }
}

function assertDockerWatchdogReady(descriptor) {
  const marker = trustedBufferFrom("READY\n");
  const observed = trustedBufferAlloc(marker.length);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const metadata = fstatSync(descriptor);
    if (metadata.size === marker.length) {
      const count = readSync(descriptor, observed, 0, observed.length, 0);
      if (count === marker.length
        && trustedBufferToString(observed, "utf8") === trustedBufferToString(marker, "utf8")) {
        observed.fill(0);
        marker.fill(0);
        return;
      }
      break;
    }
    if (metadata.size !== 0) break;
    trustedAtomicsWait(trustedWatchdogWaitArray, 0, 0, 5);
  }
  observed.fill(0);
  marker.fill(0);
  fail("Docker lease watchdog did not consume its private ownership capability");
}

function startRegressionDockerLeaseWatchdog({
  descriptorProof,
  signer,
  originalSpawn,
  originalExecFileSync
}) {
  const ledgerPath = trustedString(process.env.JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH || "");
  const encodedReference = trustedString(process.env.JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE || "");
  const watchdogPath = trustedString(process.env.JDY_REGRESSION_DOCKER_WATCHDOG_PATH || "");
  let reference;
  try {
    reference = trustedJsonParse(encodedReference);
  } catch {
    fail("Docker lease watchdog ledger reference is invalid");
  }
  if (!trustedPathIsAbsolute(ledgerPath)
    || watchdogPath !== expectedDockerWatchdogPath
    || process.env.JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD !== "7"
    || reference?.device !== descriptorProof.detachedLedger.device
    || reference?.inode !== descriptorProof.detachedLedger.inode
    || reference?.guardToken !== trustedString(process.env[regressionChildGuardTokenEnvironment] || "")
    || !trustedRegExpTest(/^[0-9a-f]{32}$/, trustedString(reference?.runId || ""))
    || reference?.file !== trustedPathBasename(ledgerPath)
    || trustedPathJoin(trustedPathDirname(ledgerPath), reference.file) !== ledgerPath) {
    fail("Docker lease watchdog ownership capability is invalid");
  }
  const acknowledgementDescriptor = fstatSync(7);
  if (!acknowledgementDescriptor.isSocket() && !acknowledgementDescriptor.isFIFO()) {
    fail("Docker lease watchdog acknowledgement capability is not a private pipe");
  }
  const secretDir = trustedPathDirname(ledgerPath);
  const protectedSuiteLockCandidate = trustedPathBasename(secretDir) === "private"
    ? trustedPathDirname(secretDir)
    : secretDir;
  try {
    regressionProtectedSuiteLockDir = trustedRealpathSync(protectedSuiteLockCandidate);
  } catch {
    fail("suite lock filesystem boundary is unavailable");
  }
  const dockerRuntimeOwnership = captureRegressionDockerOwnershipSync({ execFileSync: originalExecFileSync });
  const intentId = trustedBufferToString(trustedRandomBytes(16), "hex");
  appendDetachedSpawnLedgerRecord(descriptorProof, signer, {
    type: "intent",
    id: intentId,
    executable: watchdogPath
  });
  let child;
  let ownershipDescriptor = -1;
  let readinessDescriptor = -1;
  try {
    const ownershipPayload = trustedBufferFrom(`${trustedJsonStringify({
      version: 1,
      secretDir,
      reference,
      expectedParentPid: process.pid
    })}\n`);
    if (ownershipPayload.length < 1 || ownershipPayload.length > 16 * 1024) {
      fail("Docker lease watchdog ownership capability is oversized");
    }
    ownershipDescriptor = createPrivateUnlinkedDescriptor(secretDir, "ownership", ownershipPayload);
    ownershipPayload.fill(0);
    readinessDescriptor = createPrivateUnlinkedDescriptor(secretDir, "readiness");
    child = originalSpawn(trustedNodeExecutable, [
      "--no-addons",
      watchdogPath
    ], {
      cwd: workspaceRoot,
      detached: process.platform !== "win32",
      env: { HOME: homedir(), PATH: trustedPath },
      stdio: [6, 7, "ignore", ownershipDescriptor, readinessDescriptor]
    });
    const identity = detachedProcessIdentity(child, watchdogPath, originalExecFileSync);
    appendDetachedSpawnLedgerRecord(descriptorProof, signer, {
      type: "spawned",
      id: intentId,
      executable: watchdogPath,
      ...identity
    });
    assertDockerWatchdogReady(readinessDescriptor);
    child.unref();
  } catch (error) {
    try {
      if (child?.pid && process.platform !== "win32") {
        trustedProcessRawKill(-child.pid, trustedSignalNumberByName.SIGKILL);
      } else if (child?.pid) {
        trustedProcessRawKill(child.pid, trustedSignalNumberByName.SIGKILL);
      }
    } catch { /* The pending ledger intent keeps the suite lock fail-closed. */ }
    if (!child?.pid) {
      try {
        appendDetachedSpawnLedgerRecord(descriptorProof, signer, {
          type: "failed",
          id: intentId
        });
      } catch { /* Preserve the original watchdog initialization failure. */ }
    }
    throw error;
  } finally {
    if (ownershipDescriptor >= 0) {
      try { closeSync(ownershipDescriptor); } catch { /* child ownership remains in the signed ledger */ }
    }
    if (readinessDescriptor >= 0) {
      try { closeSync(readinessDescriptor); } catch { /* child ownership remains in the signed ledger */ }
    }
    try { closeSync(7); } catch { /* A missing ACK capability keeps the runner fail-closed. */ }
    delete process.env.JDY_REGRESSION_DETACHED_SPAWN_LEDGER_PATH;
    delete process.env.JDY_REGRESSION_DETACHED_SPAWN_LEDGER_REFERENCE;
    delete process.env.JDY_REGRESSION_DOCKER_WATCHDOG_PATH;
    delete process.env.JDY_REGRESSION_DOCKER_WATCHDOG_ACK_FD;
  }
  regressionDockerOwnership = Object.freeze({
    runId: reference.runId,
    guardToken: reference.guardToken,
    ledgerFile: reference.file,
    secretDir,
    ...dockerRuntimeOwnership
  });
}

function normalizedFilesystemPath(value) {
  let candidate = "";
  try {
    if (value instanceof TrustedURL) candidate = trustedPathResolve(trustedFileURLToPath(value));
    else if (trustedBufferIsBuffer(value)) candidate = trustedPathResolve(trustedBufferToString(value, "utf8"));
    else if (typeof value === "string") candidate = trustedPathResolve(value);
  } catch { /* Unsafe paths are rejected by the wrapped filesystem method itself. */ }
  if (!candidate) return "";
  try {
    return trustedRealpathSync(candidate);
  } catch {
    try {
      return trustedPathJoin(trustedRealpathSync(trustedPathDirname(candidate)), trustedPathBasename(candidate));
    } catch {
      return candidate;
    }
  }
}

function filesystemMutationThreatensSuiteLock(value) {
  const candidate = normalizedFilesystemPath(value);
  if (!candidate || !regressionProtectedSuiteLockDir) return false;
  return candidate === regressionProtectedSuiteLockDir
    || trustedStringStartsWith(candidate, `${regressionProtectedSuiteLockDir}${trustedPathSeparator}`)
    || trustedStringStartsWith(regressionProtectedSuiteLockDir, `${candidate}${trustedPathSeparator}`);
}

function filesystemMutationThreatensTrustedRuntime(value) {
  const candidate = normalizedFilesystemPath(value);
  if (!candidate) return false;
  const exactTargets = [trustedNodeExecutable, expectedPlaywrightExecutable];
  for (const target of exactTargets) {
    if (candidate === target
      || trustedStringStartsWith(target, `${candidate}${trustedPathSeparator}`)) {
      return true;
    }
  }
  return candidate === trustedJavaHome
    || trustedStringStartsWith(candidate, `${trustedJavaHome}${trustedPathSeparator}`)
    || trustedStringStartsWith(trustedJavaHome, `${candidate}${trustedPathSeparator}`);
}

function filesystemDescriptorThreatensProtectedState(value) {
  if (!trustedNumberIsInteger(value) || value < 0) return false;
  const descriptorPath = process.platform === "linux"
    ? `/proc/self/fd/${value}`
    : `/dev/fd/${value}`;
  let target;
  try {
    target = trustedRealpathSync(descriptorPath);
  } catch {
    return false;
  }
  return filesystemMutationThreatensSuiteLock(target)
    || filesystemMutationThreatensTrustedRuntime(target);
}

function snapshotFilesystemPath(value, operation) {
  if (trustedIsProxy(value)) {
    fail(`filesystem ${operation} path must be an immutable string`);
  }
  if (typeof value === "string") return trustedString(value);
  try {
    if (value instanceof TrustedURL) return trustedFileURLToPath(value);
    if (trustedBufferIsBuffer(value)) return trustedBufferToString(value, "utf8");
  } catch { /* Fall through to the fail-closed type rejection. */ }
  fail(`filesystem ${operation} path must be an immutable string`);
}

function installSuiteLockFilesystemBoundary() {
  if (!trustedPathIsAbsolute(regressionProtectedSuiteLockDir)) {
    fail("suite lock filesystem boundary is unavailable");
  }
  const wrap = (target, name, pathIndexes) => {
    const original = target?.[name];
    if (typeof original !== "function") return;
    const guarded = function guardedFilesystemMutation(...args) {
      for (const index of pathIndexes) {
        const immutablePath = snapshotFilesystemPath(args[index], name);
        args[index] = immutablePath;
        if (filesystemMutationThreatensSuiteLock(immutablePath)
          || filesystemMutationThreatensTrustedRuntime(immutablePath)) {
          fail(`filesystem ${name} cannot mutate protected regression state`);
        }
      }
      return trustedReflectApply(original, target, args);
    };
    objectDefineProperty(target, name, {
      configurable: false,
      enumerable: true,
      get() { return guarded; },
      // Some reviewed dependencies patch their local `fs` reference during
      // module initialization. Accept the assignment without replacing the
      // immutable guard so compatibility cannot reopen the boundary.
      set() {}
    });
  };
  const wrapDescriptor = (name) => {
    const original = fsModule?.[name];
    if (typeof original !== "function") return;
    const guarded = function guardedFilesystemDescriptorMutation(...args) {
      if (filesystemDescriptorThreatensProtectedState(args[0])) {
        fail(`filesystem ${name} cannot mutate a protected regression descriptor`);
      }
      return trustedReflectApply(original, fsModule, args);
    };
    objectDefineProperty(fsModule, name, {
      configurable: false,
      enumerable: true,
      get() { return guarded; },
      set() {}
    });
  };
  for (const name of [
    "appendFile", "chmod", "chown", "lchmod", "lchown", "lutimes",
    "mkdir", "mkdtemp", "open", "rm", "rmdir", "truncate", "unlink",
    "utimes", "writeFile"
  ]) {
    wrap(fsModule, name, [0]);
    wrap(fsPromisesModule, name, [0]);
  }
  for (const name of [
    "appendFileSync", "chmodSync", "chownSync", "lchmodSync", "lchownSync",
    "lutimesSync", "mkdirSync", "mkdtempSync", "openSync", "rmSync",
    "rmdirSync", "truncateSync", "unlinkSync", "utimesSync", "writeFileSync"
  ]) wrap(fsModule, name, [0]);
  for (const name of ["copyFile", "cp", "link", "rename", "symlink"]) {
    wrap(fsModule, name, [0, 1]);
    wrap(fsPromisesModule, name, [0, 1]);
  }
  for (const name of ["copyFileSync", "cpSync", "linkSync", "renameSync", "symlinkSync"]) {
    wrap(fsModule, name, [0, 1]);
  }
  wrap(fsModule, "createWriteStream", [0]);
  wrap(fsModule, "mkdtempDisposableSync", [0]);
  wrap(fsPromisesModule, "mkdtempDisposable", [0]);
  for (const name of [
    "close", "closeSync", "fchmod", "fchmodSync", "fchown", "fchownSync",
    "ftruncate", "ftruncateSync", "write", "writeSync", "writev", "writevSync"
  ]) wrapDescriptor(name);
  syncBuiltinESMExports();
}

function prepareRegressionDockerInvocation(policy, descriptorProof, signer) {
  if (!regressionDockerOwnership) fail("Docker lease ownership is unavailable");
  if (signer.dockerIntentCount >= maximumDockerIntents) {
    fail("Docker lease intent limit was reached before launch");
  }
  assertCanonicalRegressionDockerEndpointSync(regressionDockerOwnership.endpoint);
  const leaseId = trustedBufferToString(trustedRandomBytes(16), "hex");
  const applicationName = policy.container === regressionDockerPostgresContainer
    ? (policy.applicationName || `jdy_regression_${leaseId}`)
    : "";
  const containerIdentity = regressionDockerOwnership.containers[policy.container];
  if (!containerIdentity) fail("Docker lease target identity is unavailable");
  appendDetachedSpawnLedgerRecord(descriptorProof, signer, {
    type: "docker-intent",
    id: leaseId,
    container: policy.container,
    containerId: containerIdentity.id,
    containerStartedAt: containerIdentity.startedAt,
    daemonId: regressionDockerOwnership.daemonId,
    endpointFingerprint: regressionDockerOwnership.endpointFingerprint,
    imageId: containerIdentity.imageId,
    tool: policy.tool,
    applicationName
  });
  return {
    dockerLeaseId: leaseId,
    executable: regressionDockerExecutable,
    argv: [
      "--host", regressionDockerHostArgument,
      "exec",
      containerIdentity.id,
      "/usr/bin/sh", "-ceu", dockerTargetWrapperScript, "jdy-regression-docker-owned",
      regressionDockerOwnership.runId,
      regressionDockerOwnership.guardToken,
      leaseId,
      policy.toolPath,
      applicationName,
      ...policy.toolArguments
    ]
  };
}

function abortRegressionDockerInvocation(invocation, descriptorProof, signer) {
  if (!invocation?.dockerLeaseId) return;
  appendDetachedSpawnLedgerRecord(descriptorProof, signer, {
    type: "docker-aborted",
    id: invocation.dockerLeaseId
  });
}

function completeRegressionDockerInvocation(invocation, descriptorProof, signer) {
  if (!invocation?.dockerLeaseId) return;
  appendDetachedSpawnLedgerRecord(descriptorProof, signer, {
    type: "docker-completed",
    id: invocation.dockerLeaseId
  });
}

function defineGuardedMethod(target, name, value) {
  objectDefineProperty(target, name, {
    configurable: false,
    enumerable: true,
    writable: false,
    value
  });
}

function installNetworkBoundary() {
  const originalHttpRequest = httpModule.request;
  const originalHttpGet = httpModule.get;
  const originalHttpsRequest = httpsModule.request;
  const originalHttpsGet = httpsModule.get;
  const originalNetConnect = netModule.connect;
  const originalNetCreateConnection = netModule.createConnection;
  const originalSocketConnect = netModule.Socket.prototype.connect;
  const originalTlsConnect = tlsModule.connect;

  const snapshotCanonicalUrl = (candidate, label) => {
    if (trustedIsProxy(candidate) || typeof trustedUrlHrefGetter !== "function") {
      fail(`${label} URL is invalid`);
    }
    try {
      return trustedString(trustedReflectApply(trustedUrlHrefGetter, candidate, []));
    } catch {
      return null;
    }
  };
  const snapshotNetworkArguments = (args, label, { allowFirstUrl = false } = {}) => {
    const snapshot = [];
    for (let index = 0; index < args.length; index += 1) {
      const candidate = args[index];
      if (trustedIsProxy(candidate)) fail(`${label} options cannot be a Proxy`);
      const canonicalUrl = candidate && typeof candidate === "object"
        ? snapshotCanonicalUrl(candidate, label)
        : null;
      if (canonicalUrl != null) {
        if (!allowFirstUrl || index !== 0) fail(`${label} URL is only valid as the first argument`);
        trustedArrayPush(snapshot, canonicalUrl);
      } else if (candidate && typeof candidate === "object") {
        trustedArrayPush(snapshot, trustedObjectFreeze(snapshotPlainRecord(
          candidate,
          `${label} options`,
          256
        )));
      } else {
        trustedArrayPush(snapshot, candidate);
      }
    }
    return snapshot;
  };
  const assertHttpTarget = (args) => {
    const snapshot = snapshotNetworkArguments(args, "HTTP", { allowFirstUrl: true });
    const candidates = trustedArraySlice(snapshot, 0, 2);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate && typeof candidate === "object"
        && (candidate.socketPath != null || typeof candidate.createConnection === "function")) {
        fail("Unix socket and custom HTTP transports are forbidden");
      }
    }
    return snapshot;
  };
  const assertTcpTarget = (args) => {
    const snapshot = snapshotNetworkArguments(args, "TCP");
    const first = snapshot[0];
    if (typeof first === "string"
      || (first && typeof first === "object" && first.path != null)) {
      fail("Unix socket connections are forbidden");
    }
    const port = typeof first === "number" ? first : trustedNumber(first?.port || 0);
    if (port === 5432 || port === 6379) {
      fail("direct database and Redis TCP connections are forbidden");
    }
    return snapshot;
  };
  const guardedHttpRequest = function guardedHttpRequest(...args) {
    return trustedReflectApply(originalHttpRequest, this, assertHttpTarget(args));
  };
  const guardedHttpGet = function guardedHttpGet(...args) {
    return trustedReflectApply(originalHttpGet, this, assertHttpTarget(args));
  };
  const guardedHttpsRequest = function guardedHttpsRequest(...args) {
    return trustedReflectApply(originalHttpsRequest, this, assertHttpTarget(args));
  };
  const guardedHttpsGet = function guardedHttpsGet(...args) {
    return trustedReflectApply(originalHttpsGet, this, assertHttpTarget(args));
  };
  const guardedNetConnect = function guardedNetConnect(...args) {
    return trustedReflectApply(originalNetConnect, this, assertTcpTarget(args));
  };
  const guardedNetCreateConnection = function guardedNetCreateConnection(...args) {
    return trustedReflectApply(originalNetCreateConnection, this, assertTcpTarget(args));
  };
  const guardedSocketConnect = function guardedSocketConnect(...args) {
    return trustedReflectApply(originalSocketConnect, this, assertTcpTarget(args));
  };
  const guardedTlsConnect = function guardedTlsConnect(...args) {
    return trustedReflectApply(originalTlsConnect, this, assertTcpTarget(args));
  };
  for (const [target, name, method] of [
    [httpModule, "request", guardedHttpRequest],
    [httpModule, "get", guardedHttpGet],
    [httpsModule, "request", guardedHttpsRequest],
    [httpsModule, "get", guardedHttpsGet],
    [netModule, "connect", guardedNetConnect],
    [netModule, "createConnection", guardedNetCreateConnection],
    [netModule.Socket.prototype, "connect", guardedSocketConnect],
    [tlsModule, "connect", guardedTlsConnect]
  ]) {
    objectDefineProperty(target, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: method
    });
  }
  syncBuiltinESMExports();
}

function installGuard() {
  const token = trustedString(process.env[regressionChildGuardTokenEnvironment] || "");
  if (!/^[0-9a-f]{32}$/.test(token)) fail("guard token is unavailable");
  if (globalThis[guardStateSymbol]) {
    if (globalThis[guardStateSymbol].tokenDigest !== childGuardTokenDigest(token)) {
      fail("guard token changed after installation");
    }
    assertControlDescriptorProof(globalThis[guardStateSymbol].descriptorProof);
    return globalThis[guardStateSymbol];
  }
  // The manifest runs in this isolate after installation. Freezing the array
  // primordial closes iterator/push poisoning for every already-captured guard
  // path; untrusted argv/options are still copied through descriptor snapshots.
  trustedObjectFreeze(Array.prototype);
  const descriptorProof = captureControlDescriptorProof();
  const detachedSpawnSigner = captureDetachedSpawnSigner();
  regressionExecutionBaseline = captureExecutionBaseline();
  const seal = () => sealDetachedSpawnLedger(descriptorProof, detachedSpawnSigner);
  activeDetachedSpawnSeal = seal;
  trustedProcessOnce("exit", () => {
    try { seal(); } catch { /* Missing seal keeps the suite lock fail-closed. */ }
  });

  const originalSpawn = childProcess.spawn.bind(childProcess);
  const originalSpawnSync = childProcess.spawnSync.bind(childProcess);
  const originalExecFileSync = childProcess.execFileSync.bind(childProcess);
  const assertExecutionIntegrity = () => assertRegressionExecutionBaselineSync({
    rootDir: workspaceRoot,
    baseline: regressionExecutionBaseline,
    execFileSync: originalExecFileSync
  });
  assertExecutionIntegrity();
  assertTrustedExecutableIdentity(trustedNodeExecutable, "Node executable", trustedExecutableIdentities.node);
  startRegressionDockerLeaseWatchdog({
    descriptorProof,
    signer: detachedSpawnSigner,
    originalSpawn,
    originalExecFileSync
  });
  installSuiteLockFilesystemBoundary();
  assertExecutionIntegrity();
  const originalPrototypeSpawn = childProcess.ChildProcess.prototype.spawn;
  let approvedPrototypeSpawnDepth = 0;
  const guardedPrototypeSpawn = function guardedPrototypeSpawn(options) {
    if (approvedPrototypeSpawnDepth <= 0) fail("direct ChildProcess.prototype.spawn is forbidden");
    return originalPrototypeSpawn.call(this, options);
  };
  childProcess.ChildProcess.prototype.spawn = guardedPrototypeSpawn;
  const guardedSpawn = (command, argsOrOptions, options) => {
    assertControlDescriptorProof(descriptorProof);
    assertExecutionIntegrity();
    const request = snapshotSpawnInvocation(command, argsOrOptions, options);
    const policy = invocationPolicy(request.executable, request.argv, request.options);
    if (!policy.allowed) fail(`unapproved executable ${request.executable}`);
    if (policy.kind === "docker" && request.options?.input != null) {
      fail("Docker stdin payloads are forbidden; use the validated tool command argument");
    }
    const guardedInvocationOptions = guardedOptions(request.options, {
      inheritControlDescriptor: true,
      allowDetached: policy.allowDetached,
      rewriteDetachedIntoOwnedGroup: policy.rewriteDetachedIntoOwnedGroup === true
    });
    const invocation = policy.kind === "docker"
      ? prepareRegressionDockerInvocation(policy, descriptorProof, detachedSpawnSigner)
      : { executable: policy.executable || request.executable, argv: request.argv };
    let child;
    approvedPrototypeSpawnDepth += 1;
    try {
      child = originalSpawn(invocation.executable, invocation.argv, guardedInvocationOptions);
      guardedChildHandle(child, originalExecFileSync);
      if (invocation.dockerLeaseId) {
        trustedEventOnce(child, "close", (status, signal) => {
          if (status !== 0 || signal != null) return;
          try {
            completeRegressionDockerInvocation(invocation, descriptorProof, detachedSpawnSigner);
          } catch {
            // An unrecorded completion remains pending and is closed by the
            // independent Docker watchdog; never guess completion on failure.
          }
        });
      }
      assertExecutionIntegrity();
    } catch (error) {
      if (invocation.dockerLeaseId && !child?.pid) {
        try { abortRegressionDockerInvocation(invocation, descriptorProof, detachedSpawnSigner); }
        catch { /* An unclosed signed intent keeps recovery fail-closed. */ }
      }
      try { if (child?.exitCode === null) child.kill("SIGKILL"); } catch { /* outer PGID cleanup remains authoritative */ }
      throw error;
    } finally {
      approvedPrototypeSpawnDepth -= 1;
    }
    return child;
  };
  const guardedSpawnSync = (command, argsOrOptions, options) => {
    assertControlDescriptorProof(descriptorProof);
    assertExecutionIntegrity();
    const request = snapshotSpawnInvocation(command, argsOrOptions, options);
    const policy = invocationPolicy(request.executable, request.argv, request.options);
    if (!policy.allowed) fail(`unapproved executable ${request.executable}`);
    if (policy.kind === "docker" && request.options?.input != null) {
      fail("Docker stdin payloads are forbidden; use the validated tool command argument");
    }
    const invocationOptions = guardedOptions(request.options, {
      inheritControlDescriptor: true,
      allowDetached: false
    });
    const invocation = policy.kind === "docker"
      ? prepareRegressionDockerInvocation(policy, descriptorProof, detachedSpawnSigner)
      : { executable: policy.executable || request.executable, argv: request.argv };
    const result = originalSpawnSync(
      invocation.executable,
      invocation.argv,
      invocationOptions
    );
    if (invocation.dockerLeaseId && result?.error && result?.status == null && result?.signal == null) {
      abortRegressionDockerInvocation(invocation, descriptorProof, detachedSpawnSigner);
    }
    if (result?.status === 0 && result?.signal == null) {
      completeRegressionDockerInvocation(invocation, descriptorProof, detachedSpawnSigner);
    }
    assertExecutionIntegrity();
    return result;
  };
  const guardedExecFileSync = (command, argsOrOptions, options) => {
    assertControlDescriptorProof(descriptorProof);
    assertExecutionIntegrity();
    const request = snapshotSpawnInvocation(command, argsOrOptions, options);
    const policy = invocationPolicy(request.executable, request.argv, request.options);
    if (!policy.allowed) fail(`unapproved executable ${request.executable}`);
    if (policy.kind === "docker" && request.options?.input != null) {
      fail("Docker stdin payloads are forbidden; use the validated tool command argument");
    }
    const invocationOptions = guardedOptions(request.options, {
      inheritControlDescriptor: true,
      allowDetached: false
    });
    const invocation = policy.kind === "docker"
      ? prepareRegressionDockerInvocation(policy, descriptorProof, detachedSpawnSigner)
      : { executable: policy.executable || request.executable, argv: request.argv };
    try {
      const result = originalExecFileSync(
        invocation.executable,
        invocation.argv,
        invocationOptions
      );
      completeRegressionDockerInvocation(invocation, descriptorProof, detachedSpawnSigner);
      return result;
    } catch (error) {
      if (invocation.dockerLeaseId
        && error?.status == null
        && error?.signal == null
        && error?.pid == null) {
        abortRegressionDockerInvocation(invocation, descriptorProof, detachedSpawnSigner);
      }
      throw error;
    } finally {
      assertExecutionIntegrity();
    }
  };
  const guardedMethods = new Map([
    ["spawn", guardedSpawn],
    ["spawnSync", guardedSpawnSync],
    ["execFileSync", guardedExecFileSync]
  ]);
  for (const name of ["exec", "execFile", "execSync", "fork", "_forkChild"]) {
    guardedMethods.set(name, () => {
      assertControlDescriptorProof(descriptorProof);
      fail(`${name} is forbidden`);
    });
  }
  for (const [name, method] of guardedMethods) {
    childProcess[name] = method;
  }
  syncBuiltinESMExports();
  for (const [name, method] of guardedMethods) defineGuardedMethod(childProcess, name, method);
  objectDefineProperty(childProcess.ChildProcess.prototype, "spawn", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: guardedPrototypeSpawn
  });
  installNetworkBoundary();
  defineGuardedMethod(workerThreadsModule, "Worker", function GuardedWorker() {
    fail("worker threads are forbidden");
  });

  const originalBinding = process.binding.bind(process);
  objectDefineProperty(process, "binding", {
    configurable: false,
    writable: false,
    value(name) {
      const bindingName = trustedString(name);
      if (trustedArrayIncludes(["fs", "fs_dir", "pipe_wrap", "process_wrap", "spawn_sync", "tcp_wrap", "tls_wrap"], bindingName)) {
        fail("raw process or network binding is forbidden");
      }
      return originalBinding(name);
    }
  });
  objectDefineProperty(process, "kill", {
    configurable: false,
    writable: false,
    value(pid, signal, childHandle) {
      const targetPid = trustedNumber(pid);
      if (trustedNumberIsInteger(targetPid)
        && targetPid > 1
        && targetPid !== process.pid
        && (signal === "SIGTERM" || signal === "SIGKILL" || signal === 0)
        && approvedChildOwnsSignalTarget(childHandle, targetPid, originalExecFileSync)) {
        const signalNumber = signal === 0 ? 0 : trustedSignalNumberByName[signal];
        return trustedProcessRawKill(targetPid, signalNumber);
      }
      fail("manifest process signaling is forbidden");
    }
  });
  for (const name of ["_kill", "_debugProcess", "_debugEnd"]) {
    if (typeof process[name] === "function") {
      objectDefineProperty(process, name, {
        configurable: false,
        writable: false,
        value() {
          fail(`manifest process ${name} is forbidden`);
        }
      });
    }
  }
  for (const name of ["exit", "abort", "reallyExit"]) {
    if (typeof process[name] === "function") {
      objectDefineProperty(process, name, {
        configurable: false,
        writable: false,
        value() {
          fail(`manifest process ${name} is forbidden`);
        }
      });
    }
  }
  if (typeof process._linkedBinding === "function") {
    objectDefineProperty(process, "_linkedBinding", {
      configurable: false,
      writable: false,
      value() {
        fail("linked native bindings are forbidden");
      }
    });
  }
  if (typeof process.dlopen === "function") {
    objectDefineProperty(process, "dlopen", {
      configurable: false,
      writable: false,
      value() {
        fail("native addons are forbidden");
      }
    });
  }
  if (typeof process.getBuiltinModule === "function") {
    const originalGetBuiltinModule = process.getBuiltinModule.bind(process);
    objectDefineProperty(process, "getBuiltinModule", {
      configurable: false,
      writable: false,
      value(name) {
        const rawSpecifier = trustedString(name);
        const specifier = trustedStringStartsWith(rawSpecifier, "node:")
          ? trustedStringSlice(rawSpecifier, "node:".length)
          : rawSpecifier;
        if (specifier === "child_process"
          || specifier === "cluster"
          || specifier === "inspector"
          || specifier === "module"
          || specifier === "process"
          || specifier === "vm"
          || specifier === "worker_threads") {
          fail(`runtime builtin module ${specifier} is forbidden`);
        }
        return originalGetBuiltinModule(name);
      }
    });
  }
  // Named ESM exports such as `kill` from node:process are live bindings only
  // after the CommonJS builtin object is synchronized. Without this second sync,
  // a manifest could retain Node's original signal primitive despite process.kill
  // itself being frozen above.
  syncBuiltinESMExports();

  const state = Object.freeze({
    tokenDigest: childGuardTokenDigest(token),
    installed: true,
    controlDescriptor: 3,
    detachedLedgerDescriptor: 4,
    descriptorProof
  });
  objectDefineProperty(globalThis, guardStateSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: state
  });
  return state;
}

export function assertRegressionChildProcessGuardInstalled(expectedToken = "") {
  const state = globalThis[guardStateSymbol];
  if (!state?.installed
    || !trustedRegExpTest(/^[0-9a-f]{32}$/, trustedString(expectedToken || ""))
    || state.tokenDigest !== childGuardTokenDigest(expectedToken)
    || process.env[regressionChildGuardTokenEnvironment] !== expectedToken) {
    fail("installation proof is invalid");
  }
  assertControlDescriptorProof(state.descriptorProof);
  delete process.env[regressionChildGuardTokenEnvironment];
  delete process.env[regressionDetachedSpawnLedgerFdEnvironment];
  delete process.env[regressionDetachedSpawnSigningKeyFdEnvironment];
  return state;
}

export function sealRegressionDetachedSpawnLedger() {
  if (typeof activeDetachedSpawnSeal !== "function") fail("detached spawn ledger seal is unavailable");
  activeDetachedSpawnSeal();
}

installGuard();
