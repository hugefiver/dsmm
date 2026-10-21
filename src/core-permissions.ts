import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { DsmmDeploymentConfig } from "./deployment-config.js";
import { installDeploymentPermissionRules } from "./deployment-permission-rules.js";
import { PermissionRefusal, permissionOriginal } from "./permission-control.js";
import type { PermissionControlCollaborators } from "./permission-control.js";
import { installPermissionController } from "./permission-controller.js";
import type { DsmmPermissionController } from "./permission-controller.js";
import { registerPermissionControlRpc } from "./permission-rpc.js";

/** The native Core fiber owns one source backend, execution controller and RPC service. */
export function installCorePermissions(ctx: Context, deployment: DsmmDeploymentConfig,
  authority: PermissionControlCollaborators, assertWritable: (root: Agent) => void): DsmmPermissionController {
  let controller: DsmmPermissionController | undefined;
  const backend = installDeploymentPermissionRules(ctx, {
    deployment, assertWritable,
    revoke: () => {},
    notify: async () => {
      const current = ctx.get("dsmmPermissionController");
      if (controller === undefined || current === undefined || permissionOriginal(current) !== permissionOriginal(controller)
        || current.rules !== backend.runtime) throw new PermissionRefusal("unavailable");
    },
  });
  controller = installPermissionController(ctx, {
    authority, rules: backend.runtime,
    // The public ShellExecutor has no executable/environment resolution proof.
    // This identity never grants read trust or filesystem colocation.
    shellIdentity: (_scope, kind) => Object.freeze({ executable: `unresolved-native-${kind}`,
      dialect: kind === "bash" ? "posix" : "powershell", commandField: "command", cwdField: "workdir" }),
  });
  const installed = controller;
  ctx.inject(["typert"], scope => {
    if (scope.get("dsmmPermissions") !== undefined) throw new PermissionRefusal("unavailable");
    registerPermissionControlRpc(scope, { backend, runtime: backend.runtime });
  });
  return installed;
}
