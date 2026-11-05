import type { RemoteStream, RemoteStreamOptions } from "@deepseek-ai/dsh-api-gateway/client";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import { remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { parseRoleControlErrorInfo } from "../role-control-remote.js";
import type { RoleCallObservation, RoleCallObservationFrame, RoleControlErrorInfo } from "../role-control-types.js";

export type RoleCallObservationIssue =
  | ({ readonly kind: "domain" } & RoleControlErrorInfo)
  | { readonly kind: "transport"; readonly code: "unavailable" | "cancelled" | "internal" }
  | { readonly kind: "protocol"; readonly code: "invalid-frame" | "invalid-error" };

class ObservationProtocolError extends Error {
  constructor(readonly code: "invalid-frame") { super(code); }
}

function observationIssue(error: unknown): RoleCallObservationIssue {
  if (error instanceof ObservationProtocolError) return { kind: "protocol", code: error.code };
  const remote = remoteErrorOf(error);
  if (remote?.code === "dsmm-children/refused") {
    try { return { kind: "domain", ...parseRoleControlErrorInfo(remote.details) }; }
    catch { return { kind: "protocol", code: "invalid-error" }; }
  }
  return { kind: "transport", code: remote?.code === "gateway/cancelled" ? "cancelled" : remote?.code === "gateway/internal" ? "internal" : "unavailable" };
}

export interface RoleCallObservationState {
  readonly sessionId: string;
  readonly status: "unavailable" | "connecting" | "live" | "stale";
  readonly admissionEpoch?: string;
  readonly issue?: RoleCallObservationIssue;
  readonly calls: ReadonlyMap<string, RoleCallObservation>;
}

export type RoleCallStreamOpen = (sessionId: string, signal: AbortSignal) => AsyncIterable<RoleCallObservationFrame>;
export interface RoleCallStreamFactory {
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>;
}
interface Binding { readonly identity: object; readonly factory: RoleCallStreamFactory; readonly open: RoleCallStreamOpen }

export class RoleCallObservationController {
  private binding: Binding | null = null;
  private readonly sources = new Map<string, RoleCallObservationSource>();
  private disposed = false;

  source(sessionId: string): HostObservable<RoleCallObservationState> {
    let source = this.sources.get(sessionId);
    if (source === undefined) {
      source = new RoleCallObservationSource(sessionId);
      if (this.disposed) source.dispose(); else source.bind(this.binding);
      this.sources.set(sessionId, source);
    }
    return source;
  }

  observeSessionAvailability(sessionId: string, available: boolean): void {
    if (!this.disposed && available) this.sources.get(sessionId)?.observeAvailability();
  }

  bindConnection(factory: RoleCallStreamFactory, open: RoleCallStreamOpen): () => void {
    if (this.disposed) return () => {};
    const binding: Binding = { identity: {}, factory, open };
    this.binding = binding;
    for (const source of this.sources.values()) source.bind(binding);
    return () => {
      if (this.binding !== binding) return;
      this.binding = null;
      for (const source of this.sources.values()) source.bind(null);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.binding = null;
    for (const source of this.sources.values()) source.dispose();
    this.sources.clear();
  }
}

class RoleCallObservationSource implements HostObservable<RoleCallObservationState> {
  private snapshot: RoleCallObservationState;
  private readonly listeners = new Set<() => void>();
  private binding: Binding | null = null;
  private revision = 0;
  private stream?: RemoteStream<RoleCallObservationFrame>;
  private hint = 0;
  private consumedHint = 0;
  private disposed = false;

  constructor(private readonly sessionId: string) {
    this.snapshot = { sessionId, status: "unavailable", calls: new Map() };
  }

  getSnapshot(): RoleCallObservationState { return this.snapshot; }
  observeAvailability(): void {
    if (this.disposed || this.binding === null || this.listeners.size === 0) return;
    this.hint++;
    if (this.snapshot.status === "live") this.consumedHint = this.hint;
    else this.start();
  }
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size !== 0) return;
      this.revision++;
      this.consumedHint = this.hint;
      const stream = this.stream; this.stream = undefined;
      if (stream !== undefined) void stream.dispose();
    };
  }
  bind(binding: Binding | null): void {
    if (this.disposed || this.binding?.identity === binding?.identity) return;
    this.binding = binding; this.revision++;
    this.consumedHint = this.hint;
    const stream = this.stream; this.stream = undefined;
    if (stream !== undefined) void stream.dispose();
    this.publish({ sessionId: this.sessionId, status: "unavailable", calls: new Map() });
    if (this.listeners.size > 0) this.start();
  }
  dispose(): void {
    this.disposed = true;
    this.binding = null; this.revision++;
    this.consumedHint = this.hint;
    const stream = this.stream; this.stream = undefined;
    if (stream !== undefined) void stream.dispose();
    this.listeners.clear();
  }
  private start(): void {
    const binding = this.binding;
    if (this.disposed || binding === null || this.listeners.size === 0 || this.stream !== undefined) return;
    const revision = ++this.revision;
    this.consumedHint = this.hint;
    const stream = binding.factory.$stream<RoleCallObservationFrame>({
      name: `DSMM role calls for ${this.sessionId}`,
      open: signal => binding.open(this.sessionId, signal),
      ended: accepted => new Error(`DSMM role call stream ended ${accepted ? "after" : "before"} its snapshot`),
      carrierFailed: () => {
        if (this.revision === revision && this.stream === stream) this.invalidate("stale", { kind: "transport", code: "unavailable" });
      },
    });
    this.stream = stream;
    this.invalidate("connecting", this.snapshot.issue);
    void this.consume(stream, revision);
  }
  private async consume(stream: RemoteStream<RoleCallObservationFrame>, revision: number): Promise<void> {
    let generation = 0, admissionEpoch: string | undefined;
    try {
      for await (const item of stream) {
        if (this.revision !== revision || this.stream !== stream) return;
        const frame = item.value;
        if (frame.sessionId !== this.sessionId) throw new ObservationProtocolError("invalid-frame");
        if (item.generation !== generation) {
          if (frame.type !== "snapshot") throw new ObservationProtocolError("invalid-frame");
          generation = item.generation; admissionEpoch = frame.admissionEpoch;
          this.consumedHint = this.hint;
          item.accept();
          this.publish({ sessionId: this.sessionId, status: "live", admissionEpoch,
            calls: new Map(frame.calls.map(call => [call.callId, call])) });
          continue;
        }
        if (frame.type === "snapshot" || frame.admissionEpoch !== admissionEpoch) throw new ObservationProtocolError("invalid-frame");
        const calls = new Map(this.snapshot.calls);
        if (frame.type === "update") calls.set(frame.call.callId, frame.call); else calls.delete(frame.callId);
        this.publish({ sessionId: this.sessionId, status: "live", admissionEpoch, calls });
      }
    } catch (error) {
      if (this.revision === revision && this.stream === stream) this.invalidate("unavailable", observationIssue(error));
    } finally {
      if (this.revision === revision && this.stream === stream) {
        this.stream = undefined;
        if (this.hint > this.consumedHint) this.start();
      }
    }
  }
  private invalidate(status: "connecting" | "stale" | "unavailable", issue?: RoleCallObservationIssue): void {
    const calls = new Map([...this.snapshot.calls].map(([callId, call]) => [callId, call.phase === "settled" ? call : Object.freeze({
      ...call, actualRoute: Object.freeze({ status: "unknown" as const, reason: "not-observed" as const }),
    })]));
    this.publish({ ...this.snapshot, status, issue, calls });
  }
  private publish(snapshot: RoleCallObservationState): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
