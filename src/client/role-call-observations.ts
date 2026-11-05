import type { RemoteStream, RemoteStreamOptions } from "@deepseek-ai/dsh-api-gateway/client";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { RoleCallObservation, RoleCallObservationFrame } from "../role-control-types.js";

export interface RoleCallObservationState {
  readonly sessionId: string;
  readonly status: "unavailable" | "connecting" | "live" | "stale";
  readonly admissionEpoch?: string;
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

  source(sessionId: string): HostObservable<RoleCallObservationState> {
    let source = this.sources.get(sessionId);
    if (source === undefined) {
      source = new RoleCallObservationSource(sessionId);
      source.bind(this.binding);
      this.sources.set(sessionId, source);
    }
    return source;
  }

  bindConnection(factory: RoleCallStreamFactory, open: RoleCallStreamOpen): () => void {
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

  constructor(private readonly sessionId: string) {
    this.snapshot = { sessionId, status: "unavailable", calls: new Map() };
  }

  getSnapshot(): RoleCallObservationState { return this.snapshot; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size !== 0) return;
      this.revision++;
      const stream = this.stream; this.stream = undefined;
      if (stream !== undefined) void stream.dispose();
    };
  }
  bind(binding: Binding | null): void {
    if (this.binding?.identity === binding?.identity) return;
    this.binding = binding; this.revision++;
    const stream = this.stream; this.stream = undefined;
    if (stream !== undefined) void stream.dispose();
    this.publish({ sessionId: this.sessionId, status: "unavailable", calls: new Map() });
    if (this.listeners.size > 0) this.start();
  }
  dispose(): void {
    this.binding = null; this.revision++;
    const stream = this.stream; this.stream = undefined;
    if (stream !== undefined) void stream.dispose();
    this.listeners.clear();
  }
  private start(): void {
    const binding = this.binding;
    if (binding === null || this.listeners.size === 0 || this.stream !== undefined) return;
    const revision = ++this.revision;
    this.publish({ sessionId: this.sessionId, status: "connecting", calls: new Map() });
    const stream = binding.factory.$stream<RoleCallObservationFrame>({
      name: `DSMM role calls for ${this.sessionId}`,
      open: signal => binding.open(this.sessionId, signal),
      ended: accepted => new Error(`DSMM role call stream ended ${accepted ? "after" : "before"} its snapshot`),
      carrierFailed: () => {
        if (this.revision === revision && this.stream === stream) this.invalidate("stale");
      },
    });
    this.stream = stream;
    void this.consume(stream, revision);
  }
  private async consume(stream: RemoteStream<RoleCallObservationFrame>, revision: number): Promise<void> {
    let generation = 0, admissionEpoch: string | undefined;
    try {
      for await (const item of stream) {
        if (this.revision !== revision || this.stream !== stream) return;
        const frame = item.value;
        if (frame.sessionId !== this.sessionId) throw new Error("DSMM role call stream changed sessions");
        if (item.generation !== generation) {
          if (frame.type !== "snapshot") throw new Error("DSMM role call generation omitted its snapshot");
          generation = item.generation; admissionEpoch = frame.admissionEpoch;
          this.publish({ sessionId: this.sessionId, status: "live", admissionEpoch,
            calls: new Map(frame.calls.map(call => [call.callId, call])) });
          item.accept();
          continue;
        }
        if (frame.type === "snapshot" || frame.admissionEpoch !== admissionEpoch) throw new Error("DSMM role call update crossed its admission");
        const calls = new Map(this.snapshot.calls);
        if (frame.type === "update") calls.set(frame.call.callId, frame.call); else calls.delete(frame.callId);
        this.publish({ sessionId: this.sessionId, status: "live", admissionEpoch, calls });
      }
    } catch {
      if (this.revision === revision && this.stream === stream) this.invalidate("unavailable");
    } finally { if (this.revision === revision && this.stream === stream) this.stream = undefined; }
  }
  private invalidate(status: "stale" | "unavailable"): void {
    const calls = new Map([...this.snapshot.calls].map(([callId, call]) => [callId, call.phase === "settled" ? call : Object.freeze({
      ...call, actualRoute: Object.freeze({ status: "unknown" as const, reason: "not-observed" as const }),
    })]));
    this.publish({ ...this.snapshot, status, calls });
  }
  private publish(snapshot: RoleCallObservationState): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
