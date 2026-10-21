import assert from "node:assert/strict";
import { test } from "node:test";
import { DSMM_ROLES, DSMM_ROLE_IDS, isDsmmRoleId } from "../lib/roles.js";

test("standalone role catalog initializes its full identity and native delegation policy before runtime consumers", async () => {
  assert.deepEqual(DSMM_ROLES.map(role => role.id), [...DSMM_ROLE_IDS]);
  for (const role of DSMM_ROLES) assert.equal(isDsmmRoleId(role.id), true);
  const { roleProviderName } = await import("../lib/role-providers.js");
  const { allowedRoleChildren } = await import("../lib/role-policy.js");
  for (const role of DSMM_ROLES) {
    assert.deepEqual(allowedRoleChildren(role.id), role.allowedChildren);
    assert.deepEqual(allowedRoleChildren(role.id, true), role.id === "dsmm-builder" ? role.childBuilderAllowedChildren ?? [] : role.allowedChildren);
    for (const target of allowedRoleChildren(role.id, true)) assert.equal(isDsmmRoleId(target), true);
    assert.equal(roleProviderName(role.id), `dsmm-role-${role.id.slice("dsmm-".length)}`);
  }
});
