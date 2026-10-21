// Native rc.2 session-event augmentation; keep the emitted module for consumers.
import type { DsmmRoleId } from "./roles.js";
import type {} from "@deepseek-ai/dsh-session/types";

export interface DsmmRolePolicyEventData {
  version: 1;
  role: DsmmRoleId;
  policy: string | null;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "deepwork/mode": { active: boolean };
    "dsmm/role-policy": DsmmRolePolicyEventData;
  }
}

export interface DeepworkSessionEventMap {
  "deepwork/mode": { active: boolean };
  "dsmm/role-policy": DsmmRolePolicyEventData;
}
