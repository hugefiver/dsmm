import type { NativePageForm } from "./deployment-controller.js";

/** rc.2 and 0.2.1-alpha.1 public shared Plugins owner contracts; no runtime import. */
interface PluginConfigViewProps { readonly view: "summary" | "page"; readonly form?: NativePageForm }
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "plugins.item": { kind: "list"; scope: "root"; owner: PluginConfigViewProps };
    "plugins.bundle.config": { kind: "keyed"; scope: "root"; owner: PluginConfigViewProps };
    "plugins.row.config": { kind: "keyed"; scope: "root"; owner: PluginConfigViewProps };
  }
}
