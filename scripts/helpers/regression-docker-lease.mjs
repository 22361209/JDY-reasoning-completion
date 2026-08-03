import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync
} from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";

export const regressionDockerLeaseVersion = 2;
export const regressionDockerSocketPath = path.join(homedir(), ".docker/run/docker.sock");
export const regressionDockerHostArgument = `unix://${regressionDockerSocketPath}`;
export const regressionDockerExecutable = "/Applications/Docker.app/Contents/Resources/bin/docker";
export const regressionDockerPostgresContainer = "jdy-erp-postgres";
export const regressionDockerRedisContainer = "jdy-erp-redis";
export const regressionDockerToolPaths = Object.freeze({
  psql: "/usr/bin/psql",
  pg_dump: "/usr/bin/pg_dump",
  createdb: "/usr/bin/createdb",
  dropdb: "/usr/bin/dropdb",
  "redis-cli": "/usr/local/bin/redis-cli"
});
const regressionDockerContainerSpecifications = Object.freeze({
  [regressionDockerPostgresContainer]: Object.freeze({ image: "postgres:16", service: "postgres" }),
  [regressionDockerRedisContainer]: Object.freeze({ image: "redis:7", service: "redis" })
});

const dockerLeaseAckVersion = 2;
const dockerLeaseRoot = "/tmp/jdy-regression-owned-exec";
const maximumEngineResponseBytes = 4 * 1024 * 1024;
const cleanupWorkerCount = 8;
const cleanupIntentWorstCaseMs = 75_000;
const cleanupAcknowledgementMarginMs = 15_000;
const maximumRecoverableDockerIntents = 4_096;
const cleanupScript = String.raw`
umask 077
run_id="$1"
guard_token="$2"
lease_id="$3"
expected_tool="$4"
expected_application="$5"
lease_dir="${dockerLeaseRoot}/$run_id/$guard_token/$lease_id"
state_file="$lease_dir/state"
cancel_file="$lease_dir/cancel"
start_file="$lease_dir/start"
/usr/bin/mkdir -p "$lease_dir"
/usr/bin/chmod 700 "$lease_dir"
: > "$cancel_file"
same_identity() {
  candidate_pid="$1"
  candidate_start="$2"
  [ -r "/proc/$candidate_pid/stat" ] || return 1
  current_start=$(/usr/bin/awk '{print $22}' "/proc/$candidate_pid/stat" 2>/dev/null) || return 1
  [ "$current_start" = "$candidate_start" ] || return 1
  /usr/bin/tr '\000' '\n' < "/proc/$candidate_pid/environ" 2>/dev/null \
    | /usr/bin/grep -Fx "JDY_REGRESSION_DOCKER_LEASE=$lease_id" >/dev/null 2>&1
}
lease_process_exists() {
  for candidate_environment in /proc/[0-9]*/environ; do
    [ -r "$candidate_environment" ] || continue
    /usr/bin/tr '\000' '\n' < "$candidate_environment" 2>/dev/null \
      | /usr/bin/grep -Fx "JDY_REGRESSION_DOCKER_LEASE=$lease_id" >/dev/null 2>&1 \
      && return 0
  done
  return 1
}
mark_closed_lease() {
  wrapper_attempt=0
  while [ "$wrapper_attempt" -lt 80 ] && lease_process_exists; do
    wrapper_attempt=$((wrapper_attempt + 1))
    /usr/bin/sleep 0.05
  done
  lease_process_exists && return 1
  close_database_backend || return 1
  printf 'CLOSED||||%s\n' "$lease_id" > "$state_file.tmp" || return 1
  /usr/bin/mv "$state_file.tmp" "$state_file" || return 1
  /usr/bin/rm -f "$start_file"
}
close_database_backend() {
  [ -n "$expected_application" ] || return 0
  printf '%s\n' "$expected_application" \
    | /usr/bin/grep -Eq '^(a172_lock_[0-9]{10}|jdy_regression_[0-9a-f]{32})$' || return 1
  close_attempt=0
  while [ "$close_attempt" -lt 80 ]; do
    close_attempt=$((close_attempt + 1))
    PGAPPNAME=jdy_regression_cleanup /usr/bin/psql -X -v ON_ERROR_STOP=1 \
      -U jdy -d jdy_erp \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$expected_application' AND pid <> pg_backend_pid()" \
      >/dev/null 2>&1 || return 1
    remaining=$(PGAPPNAME=jdy_regression_cleanup /usr/bin/psql -X -v ON_ERROR_STOP=1 \
      -U jdy -d jdy_erp -At \
      -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$expected_application' AND pid <> pg_backend_pid()") || return 1
    [ "$remaining" = "0" ] && return 0
    /usr/bin/sleep 0.05
  done
  return 1
}
capture_redis_client_address() {
  redis_capture_attempt=0
  while [ "$redis_capture_attempt" -lt 40 ]; do
    redis_capture_attempt=$((redis_capture_attempt + 1))
    for descriptor in "/proc/$pid/fd/"*; do
      target=$(/usr/bin/readlink "$descriptor" 2>/dev/null) || continue
      case "$target" in
        socket:\[*\])
          socket_inode=$(printf '%s\n' "$target" | /usr/bin/awk -F'[][]' '{ print $2 }')
          ;;
        *) continue ;;
      esac
      endpoint=$(/usr/bin/awk -v socket_inode="$socket_inode" \
        '$10 == socket_inode && $3 == "0100007F:18EB" && $4 == "01" { print $2; exit }' \
        "/proc/$pid/net/tcp" 2>/dev/null) || continue
      printf '%s\n' "$endpoint" | /usr/bin/grep -Eq '^0100007F:[0-9A-F]{4}$' || continue
      port_hex=$(printf '%s\n' "$endpoint" | /usr/bin/awk -F: '{ print $2 }')
      port_decimal=$((0x$port_hex))
      [ "$port_decimal" -ge 1024 ] && [ "$port_decimal" -le 65535 ] || continue
      redis_client_address="127.0.0.1:$port_decimal"
      return 0
    done
    same_identity "$pid" "$started" || return 2
    /usr/bin/sleep 0.05
  done
  return 1
}
close_redis_client() {
  close_output=$(/usr/local/bin/redis-cli -n 0 --raw CLIENT KILL ADDR "$redis_client_address") || return 1
  [ "$close_output" = "1" ] && return 0
  same_identity "$pid" "$started" || return 0
  return 1
}
wait_for_terminal_receipt() {
  receipt_attempt=0
  while [ "$receipt_attempt" -lt 80 ]; do
    receipt_attempt=$((receipt_attempt + 1))
    IFS='|' read -r receipt_state _ _ _ receipt_lease < "$state_file" || return 1
    if { [ "$receipt_state" = "DONE" ] \
      || [ "$receipt_state" = "CANCELLED" ] \
      || [ "$receipt_state" = "CLOSED" ]; } \
      && [ "$receipt_lease" = "$lease_id" ]; then
      return 0
    fi
    /usr/bin/sleep 0.05
  done
  return 1
}
cleanup_status=0
attempt=0
while [ "$attempt" -lt 80 ]; do
  attempt=$((attempt + 1))
  if [ ! -e "$state_file" ]; then
    if [ "$attempt" -lt 80 ]; then
      /usr/bin/sleep 0.05
      continue
    fi
    # No state means the daemon may have accepted ExecStart without yet
    # materializing the fixed wrapper. Retain cancel and fail closed; a delayed
    # wrapper must leave a durable CANCELLED receipt for the next recovery pass.
    cleanup_status=81
    break
  fi
  IFS='|' read -r state pid started tool recorded_lease < "$state_file" || exit 71
  [ "$recorded_lease" = "$lease_id" ] || { cleanup_status=75; break; }
  case "$state" in
    ARMING)
      # Cancellation may race the wrapper between its initial check, process
      # creation and ACTIVE publication. Never infer closure from a momentary
      # absence: wait for its durable CANCELLED/DONE/ACTIVE transition.
      /usr/bin/sleep 0.05
      continue
      ;;
    DONE|CANCELLED)
      mark_closed_lease || cleanup_status=83
      break
      ;;
    CLOSED)
      mark_closed_lease || cleanup_status=83
      break
      ;;
    ACTIVE)
      ;;
    *)
      cleanup_status=72
      break
      ;;
  esac
  case "$pid:$started" in
    *[!0-9:]*|:*) cleanup_status=73; break ;;
  esac
  [ "$cleanup_status" = "0" ] || break
  if [ "$tool" != "$expected_tool" ]; then cleanup_status=74; break; fi
  if [ ! -r "/proc/$pid/stat" ]; then
    if wait_for_terminal_receipt; then
      mark_closed_lease || cleanup_status=83
    else
      cleanup_status=84
    fi
    break
  fi
  observed_start=$(/usr/bin/awk '{print $22}' "/proc/$pid/stat" 2>/dev/null) || { cleanup_status=76; break; }
  if [ "$observed_start" != "$started" ]; then cleanup_status=76; break; fi
  /usr/bin/tr '\000' '\n' < "/proc/$pid/environ" 2>/dev/null \
    | /usr/bin/grep -Fx "JDY_REGRESSION_DOCKER_LEASE=$lease_id" >/dev/null 2>&1 || { cleanup_status=76; break; }
  if [ "$expected_tool" = "/usr/local/bin/redis-cli" ]; then
    redis_client_address=""
    if capture_redis_client_address; then
      redis_capture_status=0
    else
      redis_capture_status=$?
    fi
    if [ "$redis_capture_status" = "2" ]; then
      if wait_for_terminal_receipt; then
        mark_closed_lease || cleanup_status=83
      else
        cleanup_status=84
      fi
      break
    fi
    if [ "$redis_capture_status" != "0" ] || ! close_redis_client; then
      cleanup_status=79
      break
    fi
  fi
  /bin/kill -TERM -- "$pid" 2>/dev/null || true
  wait_attempt=0
  while [ "$wait_attempt" -lt 30 ] && same_identity "$pid" "$started"; do
    wait_attempt=$((wait_attempt + 1))
    /usr/bin/sleep 0.05
  done
  if same_identity "$pid" "$started"; then
    /bin/kill -KILL -- "$pid" 2>/dev/null || true
  fi
  wait_attempt=0
  while [ "$wait_attempt" -lt 30 ] && same_identity "$pid" "$started"; do
    wait_attempt=$((wait_attempt + 1))
    /usr/bin/sleep 0.05
  done
  if same_identity "$pid" "$started"; then
    cleanup_status=77
  else
    if ! wait_for_terminal_receipt; then
      cleanup_status=84
    else
      mark_closed_lease || cleanup_status=83
    fi
  fi
  break
done
if [ "$cleanup_status" = "0" ] && [ -e "$state_file" ]; then
  IFS='|' read -r final_state _ _ _ final_lease < "$state_file" || cleanup_status=80
  if [ "$cleanup_status" = "0" ] \
    && { [ "$final_state" != "CLOSED" ] || [ "$final_lease" != "$lease_id" ] || lease_process_exists; }; then
    cleanup_status=80
  fi
fi
# A cancel tombstone is deliberately retained when the daemon accepted ExecStart
# but the fixed wrapper has not materialized yet. A delayed wrapper can only
# leave a durable CANCELLED receipt; it can never execute the requested tool.
exit "$cleanup_status"
`;
const closedReceiptScavengerScript = String.raw`
set -eu
root="${dockerLeaseRoot}"
[ -e "$root" ] || exit 0
[ -d "$root" ] && [ ! -L "$root" ] || exit 91
current_uid=$(/usr/bin/id -u)
assert_private_directory() {
  candidate="$1"
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(/usr/bin/stat -c %u "$candidate")" = "$current_uid" ] || return 1
  [ "$(/usr/bin/stat -c %a "$candidate")" = "700" ] || return 1
}
assert_private_file() {
  candidate="$1"
  [ -f "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(/usr/bin/stat -c %u "$candidate")" = "$current_uid" ] || return 1
  [ "$(/usr/bin/stat -c %a "$candidate")" = "600" ] || return 1
  [ "$(/usr/bin/stat -c %h "$candidate")" = "1" ] || return 1
}
lease_process_exists() {
  expected_lease="$1"
  for candidate_environment in /proc/[0-9]*/environ; do
    [ -r "$candidate_environment" ] || continue
    /usr/bin/tr '\000' '\n' < "$candidate_environment" 2>/dev/null \
      | /usr/bin/grep -Fx "JDY_REGRESSION_DOCKER_LEASE=$expected_lease" >/dev/null 2>&1 \
      && return 0
  done
  return 1
}
assert_private_directory "$root" || exit 92
for run_dir in "$root"/*; do
  [ -e "$run_dir" ] || continue
  run_name=$(/usr/bin/basename "$run_dir")
  printf '%s\n' "$run_name" | /usr/bin/grep -Eq '^[0-9a-f]{32}$' || exit 93
  assert_private_directory "$run_dir" || exit 94
  for token_dir in "$run_dir"/*; do
    [ -e "$token_dir" ] || continue
    token_name=$(/usr/bin/basename "$token_dir")
    printf '%s\n' "$token_name" | /usr/bin/grep -Eq '^[0-9a-f]{32}$' || exit 95
    assert_private_directory "$token_dir" || exit 96
    for lease_dir in "$token_dir"/*; do
      [ -e "$lease_dir" ] || continue
      lease_name=$(/usr/bin/basename "$lease_dir")
      printf '%s\n' "$lease_name" | /usr/bin/grep -Eq '^[0-9a-f]{32}$' || exit 97
      assert_private_directory "$lease_dir" || exit 98
      state_file="$lease_dir/state"
      cancel_file="$lease_dir/cancel"
      assert_private_file "$state_file" || exit 99
      assert_private_file "$cancel_file" || exit 100
      for receipt_entry in "$lease_dir"/*; do
        [ -e "$receipt_entry" ] || continue
        receipt_name=$(/usr/bin/basename "$receipt_entry")
        case "$receipt_name" in
          state|cancel) ;;
          *) exit 101 ;;
        esac
      done
      IFS='|' read -r receipt_state _ _ _ receipt_lease < "$state_file" || exit 102
      [ "$receipt_state" = "CLOSED" ] && [ "$receipt_lease" = "$lease_name" ] || exit 103
      lease_process_exists "$lease_name" && exit 104
      /usr/bin/rm -f "$state_file" "$cancel_file"
      /usr/bin/rmdir "$lease_dir"
    done
    /usr/bin/rmdir "$token_dir" 2>/dev/null || [ -n "$(/usr/bin/ls -A "$token_dir")" ] || exit 105
  done
  /usr/bin/rmdir "$run_dir" 2>/dev/null || [ -n "$(/usr/bin/ls -A "$run_dir")" ] || exit 106
done
/usr/bin/rmdir "$root" 2>/dev/null || [ -n "$(/usr/bin/ls -A "$root")" ] || exit 107
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertCanonicalRegressionDockerEndpointSync(expected = null) {
  const executable = lstatSync(regressionDockerExecutable);
  if (!executable.isFile()
    || executable.isSymbolicLink()
    || executable.nlink !== 1
    || (typeof process.getuid === "function" && executable.uid !== process.getuid())) {
    throw new Error("regression Docker executable is not the canonical owned Docker Desktop CLI");
  }
  const socket = lstatSync(regressionDockerSocketPath);
  if (!socket.isSocket()
    || socket.isSymbolicLink()
    || socket.nlink !== 1
    || (typeof process.getuid === "function" && socket.uid !== process.getuid())) {
    throw new Error("regression Docker endpoint is not the canonical owned local Unix socket");
  }
  const observed = {
    executable: {
      device: String(executable.dev),
      inode: String(executable.ino),
      size: executable.size,
      sha256: createHash("sha256").update(readFileSync(regressionDockerExecutable)).digest("hex")
    },
    socket: {
      device: String(socket.dev),
      inode: String(socket.ino)
    }
  };
  if (expected != null && JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("regression Docker executable or local endpoint changed after ownership capture");
  }
  return observed;
}

export function regressionDockerEndpointFingerprint(endpoint) {
  const normalized = endpoint || assertCanonicalRegressionDockerEndpointSync();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function captureRegressionDockerOwnershipSync({ execFileSync }) {
  assert(typeof execFileSync === "function", "regression Docker ownership requires a trusted synchronous executor");
  const endpoint = assertCanonicalRegressionDockerEndpointSync();
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: maximumEngineResponseBytes
  };
  let info;
  let inspected;
  try {
    info = JSON.parse(execFileSync(regressionDockerExecutable, [
      "--host", regressionDockerHostArgument, "info", "--format", "{{json .}}"
    ], options));
    inspected = JSON.parse(execFileSync(regressionDockerExecutable, [
      "--host", regressionDockerHostArgument, "inspect",
      regressionDockerPostgresContainer, regressionDockerRedisContainer
    ], options));
  } catch (error) {
    throw new Error(`regression Docker ownership could not be captured: ${error instanceof Error ? error.message : String(error)}`);
  }
  const daemonId = String(info?.ID || "");
  assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(daemonId),
    "regression Docker daemon identity is invalid");
  assert(Array.isArray(inspected) && inspected.length === 2,
    "regression Docker container ownership set is incomplete");
  const containers = {};
  for (const container of inspected) {
    const name = String(container?.Name || "").replace(/^\//, "");
    const specification = regressionDockerContainerSpecifications[name];
    const id = String(container?.Id || "");
    const imageId = String(container?.Image || "");
    const startedAt = String(container?.State?.StartedAt || "");
    const labels = container?.Config?.Labels || {};
    if (!specification
      || !/^[0-9a-f]{64}$/.test(id)
      || !/^sha256:[0-9a-f]{64}$/.test(imageId)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(startedAt)
      || container?.State?.Running !== true
      || container?.State?.Paused !== false
      || container?.State?.Restarting !== false
      || container?.State?.Dead !== false
      || container?.Config?.Image !== specification.image
      || labels["com.docker.compose.project"] !== "infra"
      || labels["com.docker.compose.service"] !== specification.service
      || labels["com.docker.compose.oneoff"] !== "False"
      || container?.HostConfig?.Privileged !== false
      || String(container?.HostConfig?.PidMode || "") !== "") {
      throw new Error(`regression Docker container ${name || "<unknown>"} does not match the reviewed runtime identity`);
    }
    if (containers[name]) throw new Error("regression Docker container ownership contains a duplicate name");
    containers[name] = Object.freeze({ id, imageId, startedAt });
  }
  for (const name of Object.keys(regressionDockerContainerSpecifications)) {
    if (!containers[name]) throw new Error(`regression Docker container ${name} is unavailable`);
  }
  assertCanonicalRegressionDockerEndpointSync(endpoint);
  return Object.freeze({
    version: 1,
    endpoint: Object.freeze(endpoint),
    endpointFingerprint: regressionDockerEndpointFingerprint(endpoint),
    daemonId,
    containers: Object.freeze(containers)
  });
}

export function normalizeRegressionDockerLeaseIntent(intent) {
  const id = String(intent?.id || "");
  const container = String(intent?.container || "");
  const containerId = String(intent?.containerId || "");
  const containerStartedAt = String(intent?.containerStartedAt || "");
  const daemonId = String(intent?.daemonId || "");
  const endpointFingerprint = String(intent?.endpointFingerprint || "");
  const imageId = String(intent?.imageId || "");
  const tool = String(intent?.tool || "");
  const applicationName = String(intent?.applicationName || "");
  assert(/^[0-9a-f]{32}$/.test(id), "regression Docker lease id is invalid");
  assert(/^[0-9a-f]{64}$/.test(containerId)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(containerStartedAt)
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(daemonId)
    && /^[0-9a-f]{64}$/.test(endpointFingerprint)
    && /^sha256:[0-9a-f]{64}$/.test(imageId)
    && ((container === regressionDockerPostgresContainer
      && ["psql", "pg_dump", "createdb", "dropdb"].includes(tool)
      && /^(?:a172_lock_[0-9]{10}|jdy_regression_[0-9a-f]{32})$/.test(applicationName))
    || (container === regressionDockerRedisContainer && tool === "redis-cli" && applicationName === "")),
  "regression Docker lease container/tool pair is invalid");
  return {
    id,
    container,
    containerId,
    containerStartedAt,
    daemonId,
    endpointFingerprint,
    imageId,
    tool,
    applicationName
  };
}

function dockerEngineRequest({ method, requestPath, body = null, timeoutMs = 10_000, endpointFingerprint = "" }) {
  const assertEndpoint = () => {
    const observed = assertCanonicalRegressionDockerEndpointSync();
    if (endpointFingerprint && regressionDockerEndpointFingerprint(observed) !== endpointFingerprint) {
      throw new Error("regression Docker endpoint identity changed after lease capture");
    }
  };
  assertEndpoint();
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: regressionDockerSocketPath,
      path: requestPath,
      method,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length)
      } : undefined
    });
    const chunks = [];
    let total = 0;
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Docker Engine request timed out")));
    request.on("response", (response) => {
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maximumEngineResponseBytes) {
          request.destroy(new Error("Docker Engine response exceeded the safety bound"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Docker Engine ${method} ${requestPath} failed ${response.statusCode}: ${responseBody.toString("utf8").slice(0, 1000)}`));
          return;
        }
        assertEndpoint();
        resolve({ status: response.statusCode, body: responseBody });
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function decodeJsonResponse(response, label) {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function assertRegressionDockerLeaseTarget(intent) {
  const info = decodeJsonResponse(await dockerEngineRequest({
    method: "GET",
    requestPath: "/info",
    endpointFingerprint: intent.endpointFingerprint
  }), "Docker daemon ownership inspection");
  if (String(info?.ID || "") !== intent.daemonId) {
    throw new Error("regression Docker daemon identity changed after lease capture");
  }
  const inspected = decodeJsonResponse(await dockerEngineRequest({
    method: "GET",
    requestPath: `/containers/${intent.containerId}/json`,
    endpointFingerprint: intent.endpointFingerprint
  }), "Docker container ownership inspection");
  const specification = regressionDockerContainerSpecifications[intent.container];
  const labels = inspected?.Config?.Labels || {};
  if (String(inspected?.Id || "") !== intent.containerId
    || String(inspected?.Image || "") !== intent.imageId
    || String(inspected?.State?.StartedAt || "") !== intent.containerStartedAt
    || inspected?.State?.Running !== true
    || inspected?.State?.Paused !== false
    || inspected?.State?.Restarting !== false
    || inspected?.State?.Dead !== false
    || inspected?.Config?.Image !== specification?.image
    || labels["com.docker.compose.project"] !== "infra"
    || labels["com.docker.compose.service"] !== specification?.service
    || labels["com.docker.compose.oneoff"] !== "False"
    || inspected?.HostConfig?.Privileged !== false
    || String(inspected?.HostConfig?.PidMode || "") !== "") {
    throw new Error("regression Docker container identity changed after lease capture");
  }
}

function regressionDockerOwnershipTarget(ownership, container) {
  assert(ownership?.version === 1,
    "regression Docker ownership capture version is invalid");
  assert(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(String(ownership?.daemonId || ""))
    && /^[0-9a-f]{64}$/.test(String(ownership?.endpointFingerprint || "")),
  "regression Docker ownership capture is incomplete");
  assertCanonicalRegressionDockerEndpointSync(ownership.endpoint);
  const captured = ownership?.containers?.[container];
  assert(captured
    && /^[0-9a-f]{64}$/.test(String(captured.id || ""))
    && /^sha256:[0-9a-f]{64}$/.test(String(captured.imageId || ""))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(String(captured.startedAt || "")),
  `regression Docker ownership capture for ${container} is incomplete`);
  return {
    container,
    containerId: captured.id,
    containerStartedAt: captured.startedAt,
    daemonId: ownership.daemonId,
    endpointFingerprint: ownership.endpointFingerprint,
    imageId: captured.imageId
  };
}

async function scavengeDockerClosedReceiptsForTarget(target) {
  await assertRegressionDockerLeaseTarget(target);
  const created = decodeJsonResponse(await dockerEngineRequest({
    method: "POST",
    requestPath: `/containers/${target.containerId}/exec`,
    endpointFingerprint: target.endpointFingerprint,
    body: {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: [
        "/usr/bin/sh", "-ceu", closedReceiptScavengerScript,
        "jdy-regression-docker-closed-receipt-scavenger"
      ]
    }
  }), "Docker closed-receipt scavenger creation");
  const execId = String(created?.Id || "");
  assert(/^[0-9a-f]{64}$/.test(execId),
    "Docker closed-receipt scavenger exec id is invalid");
  await dockerEngineRequest({
    method: "POST",
    requestPath: `/exec/${execId}/start`,
    body: { Detach: false, Tty: false },
    timeoutMs: 15_000,
    endpointFingerprint: target.endpointFingerprint
  });
  const inspected = decodeJsonResponse(await dockerEngineRequest({
    method: "GET",
    requestPath: `/exec/${execId}/json`,
    endpointFingerprint: target.endpointFingerprint
  }), "Docker closed-receipt scavenger inspection");
  if (inspected?.Running !== false || inspected?.ExitCode !== 0) {
    throw new Error(`Docker closed-receipt scavenger did not close safely: ${JSON.stringify({
      container: target.container,
      running: inspected?.Running,
      exitCode: inspected?.ExitCode
    })}`);
  }
  await assertRegressionDockerLeaseTarget(target);
  return target.container;
}

export async function scavengeRegressionDockerClosedReceipts({ ownership }) {
  const targets = [regressionDockerPostgresContainer, regressionDockerRedisContainer]
    .map((container) => regressionDockerOwnershipTarget(ownership, container));
  const scavenged = [];
  for (const target of targets) {
    scavenged.push(await scavengeDockerClosedReceiptsForTarget(target));
  }
  return { ok: true, scavenged };
}

async function cleanupDockerLeaseIntent(intent, { runId, guardToken }) {
  const normalized = normalizeRegressionDockerLeaseIntent(intent);
  await assertRegressionDockerLeaseTarget(normalized);
  const toolPath = regressionDockerToolPaths[normalized.tool];
  const created = decodeJsonResponse(await dockerEngineRequest({
    method: "POST",
    requestPath: `/containers/${normalized.containerId}/exec`,
    endpointFingerprint: normalized.endpointFingerprint,
    body: {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: [
        "/usr/bin/sh", "-ceu", cleanupScript, "jdy-regression-docker-cleanup",
        runId, guardToken, normalized.id, toolPath, normalized.applicationName
      ]
    }
  }), "Docker cleanup exec creation");
  const execId = String(created?.Id || "");
  assert(/^[0-9a-f]{64}$/.test(execId), "Docker cleanup exec id is invalid");
  await dockerEngineRequest({
    method: "POST",
    requestPath: `/exec/${execId}/start`,
    body: { Detach: false, Tty: false },
    timeoutMs: regressionDockerCleanupDeadlineMs(1),
    endpointFingerprint: normalized.endpointFingerprint
  });
  const inspected = decodeJsonResponse(await dockerEngineRequest({
    method: "GET",
    requestPath: `/exec/${execId}/json`,
    endpointFingerprint: normalized.endpointFingerprint
  }), "Docker cleanup exec inspection");
  if (inspected?.Running !== false || inspected?.ExitCode !== 0) {
    throw new Error(`Docker cleanup exec did not close safely: ${JSON.stringify({ running: inspected?.Running, exitCode: inspected?.ExitCode })}`);
  }
  await assertRegressionDockerLeaseTarget(normalized);
  return normalized;
}

export async function cleanupRegressionDockerLeaseIntents({ intents, runId, guardToken }) {
  assert(/^[0-9a-f]{32}$/.test(String(runId || "")), "regression Docker cleanup run id is invalid");
  assert(/^[0-9a-f]{32}$/.test(String(guardToken || "")), "regression Docker cleanup guard token is invalid");
  assert(Array.isArray(intents) && intents.length <= maximumRecoverableDockerIntents,
    "regression Docker cleanup intent list is invalid");
  const normalized = intents.map(normalizeRegressionDockerLeaseIntent);
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error("regression Docker cleanup intent list contains duplicate lease ids");
  }
  const cleanedByIndex = new Array(normalized.length);
  const errorsByIndex = new Array(normalized.length);
  let nextIndex = 0;
  const workerCount = Math.min(cleanupWorkerCount, normalized.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= normalized.length) return;
      const intent = normalized[index];
      try {
        cleanedByIndex[index] = await cleanupDockerLeaseIntent(intent, { runId, guardToken });
      } catch (error) {
        errorsByIndex[index] = {
          ...intent,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }));
  const cleaned = cleanedByIndex.filter(Boolean);
  const errors = errorsByIndex.filter(Boolean);
  return { ok: errors.length === 0, cleaned, errors };
}

export function regressionDockerCleanupDeadlineMs(intentCount) {
  assert(Number.isInteger(intentCount) && intentCount >= 0 && intentCount <= maximumRecoverableDockerIntents,
    "regression Docker cleanup deadline intent count is invalid");
  return cleanupAcknowledgementMarginMs
    + Math.ceil(intentCount / cleanupWorkerCount) * cleanupIntentWorstCaseMs;
}

export function encodeRegressionDockerWatchdogAck(result) {
  const payload = `${JSON.stringify(result)}\n`;
  if (Buffer.byteLength(payload) < 2 || Buffer.byteLength(payload) > 1024 * 1024) {
    throw new Error("regression Docker watchdog acknowledgement size is invalid");
  }
  return payload;
}

export function readRegressionDockerWatchdogAck({
  payload,
  ledgerFile,
  runId,
  guardToken,
  expectedIntentIds,
  expectedCompletedIds,
  requireSealed = true,
  expectedTrigger = "OWNER_EOF"
}) {
  payload = String(payload || "");
  if (Buffer.byteLength(payload) < 2
    || Buffer.byteLength(payload) > 1024 * 1024
    || !payload.endsWith("\n")
    || payload.slice(0, -1).includes("\n")
    || payload.includes("\r")) {
    throw new Error("regression Docker watchdog acknowledgement frame is invalid");
  }
  let result;
  try {
    result = JSON.parse(payload.slice(0, -1));
  } catch {
    throw new Error("regression Docker watchdog acknowledgement is invalid JSON");
  }
  const expectedKeys = "cleanedIds,completedAt,completedIds,errors,guardToken,intentIds,ledgerFile,ok,partialLedgerRecord,runId,sealed,trigger,version";
  if (!result
    || typeof result !== "object"
    || Array.isArray(result)
    || Object.keys(result).sort().join(",") !== expectedKeys
    || encodeRegressionDockerWatchdogAck(result) !== payload) {
    throw new Error("regression Docker watchdog acknowledgement is not canonical");
  }
  const expected = [...expectedIntentIds].map(String).sort();
  const observed = Array.isArray(result?.intentIds) ? result.intentIds.map(String).sort() : [];
  const expectedCompleted = [...expectedCompletedIds].map(String).sort();
  const observedCompleted = Array.isArray(result?.completedIds) ? result.completedIds.map(String).sort() : [];
  const expectedCleaned = expected;
  const observedCleaned = Array.isArray(result?.cleanedIds) ? result.cleanedIds.map(String).sort() : [];
  if (result?.version !== dockerLeaseAckVersion
    || result?.runId !== runId
    || result?.guardToken !== guardToken
    || result?.ledgerFile !== ledgerFile
    || result?.trigger !== expectedTrigger
    || (requireSealed && result?.sealed !== true)
    || result?.partialLedgerRecord !== false
    || result?.ok !== true
    || JSON.stringify(observed) !== JSON.stringify(expected)
    || JSON.stringify(observedCompleted) !== JSON.stringify(expectedCompleted)
    || JSON.stringify(observedCleaned) !== JSON.stringify(expectedCleaned)
    || new Set(observed).size !== observed.length
    || new Set(observedCompleted).size !== observedCompleted.length
    || new Set(observedCleaned).size !== observedCleaned.length
    || !Array.isArray(result?.errors)
    || result.errors.length !== 0
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(result?.completedAt || ""))) {
    throw new Error(`regression Docker watchdog did not prove exact lease closure: ${JSON.stringify({
      versionMatches: result?.version === dockerLeaseAckVersion,
      runMatches: result?.runId === runId,
      guardMatches: result?.guardToken === guardToken,
      ledgerMatches: result?.ledgerFile === ledgerFile,
      triggerMatches: result?.trigger === expectedTrigger,
      sealed: result?.sealed === true,
      partial: result?.partialLedgerRecord !== false,
      ok: result?.ok === true,
      expectedIntentCount: expected.length,
      observedIntentCount: observed.length,
      expectedCompletedCount: expectedCompleted.length,
      observedCompletedCount: observedCompleted.length,
      expectedCleanedCount: expectedCleaned.length,
      observedCleanedCount: observedCleaned.length,
      errorsEmpty: Array.isArray(result?.errors) && result.errors.length === 0,
      completionTimestampValid: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(result?.completedAt || ""))
    })}`);
  }
  return result;
}
