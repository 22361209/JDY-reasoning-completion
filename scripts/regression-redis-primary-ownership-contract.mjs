#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { deleteProvenRedisPrimary } from "./helpers/regression-auth.mjs";

const key = `jdy:a174-contract:sessions:${randomUUID()}`;
const redis = (...args) => execFileSync("docker", [
  "exec",
  process.env.JDY_REDIS_CONTAINER || "jdy-erp-redis",
  "redis-cli",
  "-n",
  process.env.JDY_REDIS_DB || "0",
  "--raw",
  ...args
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  redis("HSET", key, "unrelated", "repurposed");
  assert.throws(
    () => deleteProvenRedisPrimary(key, "admin"),
    /ownership changed/,
    "a key that survived without its proven username field must fail closed"
  );
  assert.equal(redis("EXISTS", key), "1", "ownership drift must never delete the repurposed key");

  redis("HSET", key, "sessionAttr:jdy.username", "other-user");
  assert.throws(
    () => deleteProvenRedisPrimary(key, "admin"),
    /ownership changed/,
    "a changed username owner must fail closed"
  );
  assert.equal(redis("EXISTS", key), "1", "a differently owned key must remain intact");

  redis("HSET", key, "sessionAttr:jdy.username", "admin");
  assert.equal(deleteProvenRedisPrimary(key, "admin"), 1, "the exact proven owner may be deleted atomically");
  assert.equal(redis("EXISTS", key), "0");
  assert.equal(deleteProvenRedisPrimary(key, "admin"), 0, "natural expiry before deletion is safe");

  console.log(JSON.stringify({ ok: true, missingOwnerFailClosed: true, changedOwnerFailClosed: true }));
} finally {
  redis("DEL", key);
}
