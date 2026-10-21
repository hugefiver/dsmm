import { renderAgentCordis } from "../lib/index.js";
import type { DsmmRoleDefinition } from "../lib/roles.js";

// Published renderer input shape before source/catalog metadata was added.
const legacyRole: DsmmRoleDefinition = {
  id: "dsmm-builder", name: "External Builder", description: "Caller-defined role",
  order: 1, mode: "primary", enabledByDefault: true, access: "write", persona: "Bounded caller persona"
};
renderAgentCordis(legacyRole, undefined, ["dsmm-builder"], {});
