import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentActivation, SubagentCatalogEntry, SubagentDescendantListEntry, SubagentInterruptReceipt, SubagentPromptReceipt, SubagentPromptRequest, SubagentRuntime } from "@deepseek-ai/dsh-subagent";

type ActivationSpec = Parameters<SubagentRuntime["startActivation"]>[0];
type FlatActivationSpec = Omit<ActivationSpec, "request"> & ActivationSpec["request"];
type TreeRuntime = { rootOf(agent: Agent): Agent; startActivation(spec: FlatActivationSpec): Promise<SubagentActivation> };

/** Native tree runtimes accept task fields directly on the activation specification. */
export function startNativeActivation(runtime: SubagentRuntime, spec: ActivationSpec): Promise<SubagentActivation> {
  if (typeof (runtime as unknown as Partial<TreeRuntime>).rootOf !== "function") return runtime.startActivation(spec);
  const { request, ...activation } = spec;
  return (runtime as unknown as TreeRuntime).startActivation({ ...request, ...activation });
}

export type NativeChildEntry = Pick<SubagentCatalogEntry, "id" | "mode"> & { readonly label?: string };
type ChildDiscovery = {
  listChildren?(parentId: SessionId, signal?: AbortSignal): Promise<NativeChildEntry[]>;
  listDescendants(parentId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>;
};

/** Discover direct catalog membership without loading or resuming a child. */
export async function listNativeChildren(runtime: ChildDiscovery, parentId: SessionId, signal?: AbortSignal): Promise<NativeChildEntry[]> {
  if (typeof runtime.listChildren === "function") return runtime.listChildren(parentId, signal);
  const descendants = await runtime.listDescendants(parentId, signal);
  return descendants.filter(row => row.parentId === parentId).map(row => row.kind === "diagnostic"
    ? { id: row.id, mode: "unknown" as const }
    : { id: row.id, mode: row.mode, ...row.label === undefined ? {} : { label: row.label } });
}

type TreePromptRequest = Omit<SubagentPromptRequest, "parentSessionId" | "mode">;
type TreeControls = {
  rootOf(agent: Agent): Agent;
  prompt(request: TreePromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>;
  interrupt(childId: SessionId, authority: { kind: "ancestor"; agent: Agent }): void;
};

/** Transport an already-authorized direct-child prompt through the Host's control contract. */
export function promptNativeChild(runtime: SubagentRuntime, request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
  if (typeof (runtime as unknown as Partial<TreeControls>).rootOf !== "function") return runtime.prompt(request, signal);
  const { parentSessionId: _parent, mode: _mode, ...prompt } = request;
  return (runtime as unknown as TreeControls).prompt(prompt, signal);
}

/** Caller-side catalog and exact-parent checks remain authoritative for this interrupt. */
export function interruptNativeChild(runtime: SubagentRuntime, childId: SessionId, caller: Agent): SubagentInterruptReceipt {
  if (typeof (runtime as unknown as Partial<TreeControls>).rootOf !== "function") return runtime.interruptByParent(childId, caller.id, "continuable");
  (runtime as unknown as TreeControls).interrupt(childId, { kind: "ancestor", agent: caller });
  return { accepted: true };
}
