import { symbols } from "@deepseek-ai/cordis";
import { SubagentError } from "@deepseek-ai/dsh-subagent";

interface OwnershipAgent { readonly id?: string }
export interface NativeOwnershipRegistry<A extends OwnershipAgent> {
  get(id: string): A | undefined;
  list(): A[];
  roots?(): A[];
  isOwnedBy?(id: string, parent: A): boolean;
}
interface TreeRuntime { rootOf(agent: object): OwnershipAgent }
interface ParentEdge { readonly parent: object; readonly runtime: TreeRuntime; readonly root: OwnershipAgent }
const edges = new WeakMap<object, WeakMap<object, ParentEdge>>();
const original = (value: object): object => Reflect.get(value, symbols.original) ?? value;
function runtimeOf(agent: object): TreeRuntime | undefined {
  const ctx = (agent as { ctx?: { get?(name: string): unknown } }).ctx;
  const runtime = ctx?.get?.("subagents") as TreeRuntime | undefined;
  return typeof runtime?.rootOf === "function" ? runtime : undefined;
}

/** Root membership is native runtime evidence, never durable session lineage. */
export function nativeRoots<A extends OwnershipAgent>(registry: NativeOwnershipRegistry<A>): A[] {
  if (typeof registry.roots === "function") return registry.roots();
  return registry.list().filter(agent => {
    if (agent.id === undefined || registry.get(agent.id) !== agent) return false;
    try { return runtimeOf(agent)?.rootOf(agent) === agent; }
    catch { return false; }
  });
}

/** A tree root is authority only while both exact objects remain registered. */
export function nativeTreeRoot<A extends OwnershipAgent>(registry: NativeOwnershipRegistry<A>, agent: A): A | undefined {
  if (agent.id === undefined || registry.get(agent.id) !== agent) return undefined;
  try {
    const root = runtimeOf(agent)?.rootOf(agent);
    if (root?.id === undefined) return undefined;
    const live = registry.get(root.id);
    return live === root && runtimeOf(live)?.rootOf(live) === live ? live : undefined;
  } catch { return undefined; }
}

export function nativeSameTree<A extends OwnershipAgent>(registry: NativeOwnershipRegistry<A>, left: A, right: A): boolean {
  const root = nativeTreeRoot(registry, left);
  return root !== undefined && nativeTreeRoot(registry, right) === root;
}

/** New runtimes require an authenticated creation edge in addition to native tree residency. */
export function nativeIsOwnedBy<A extends OwnershipAgent>(registry: NativeOwnershipRegistry<A> | undefined, childId: string, parent: A): boolean {
  if (registry === undefined) return false;
  if (typeof registry.isOwnedBy === "function") return registry.isOwnedBy(childId, parent);
  const child = registry.get(childId);
  if (child === undefined || parent.id === undefined || registry.get(parent.id) !== parent) return false;
  const edge = edges.get(original(registry))?.get(child);
  if (edge?.parent !== parent || original(runtimeOf(child) ?? {}) !== original(edge.runtime)) return false;
  try {
    return edge.root.id !== undefined && registry.get(edge.root.id) === edge.root
      && edge.runtime.rootOf(child) === edge.root && edge.runtime.rootOf(parent) === edge.root;
  } catch { return false; }
}

/** Call only after authenticating the native start's direct creator, not from a session header. */
export function bindNativeParent<A extends OwnershipAgent>(registry: NativeOwnershipRegistry<A>, child: A, parent: A): void {
  const deny = (): never => { throw new SubagentError("Exact native parent binding is unavailable", "UNAUTHORIZED"); };
  if (child === parent || child.id === undefined || parent.id === undefined
    || registry.get(child.id) !== child || registry.get(parent.id) !== parent) deny();
  if (typeof registry.isOwnedBy === "function") {
    if (!registry.isOwnedBy(child.id!, parent)) deny();
    return;
  }
  const runtime = runtimeOf(child);
  if (runtime === undefined) deny();
  const owner = runtime!;
  const root = owner.rootOf(child);
  if (root === child || owner.rootOf(parent) !== root || root.id === undefined || registry.get(root.id) !== root) deny();
  let bindings = edges.get(original(registry));
  if (bindings === undefined) { bindings = new WeakMap(); edges.set(original(registry), bindings); }
  const previous = bindings.get(child);
  if (previous !== undefined && (previous.parent !== parent || original(previous.runtime) !== original(owner) || previous.root !== root)) deny();
  bindings.set(child, { parent, runtime: owner, root });
}
