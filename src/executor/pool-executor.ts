/**
 * PooledWorkerExecutor — WorkerExecutor semantics with pre-warmed, reused workers.
 *
 * What is reused: the worker thread and its loaded QuickJS WASM module (the ~100 ms
 * start-up cost). What is NOT reused: guest state — every execution gets a fresh
 * QuickJS runtime and context, exactly as in WorkerExecutor.
 *
 * Fail-safe recycling: a worker is terminated and replaced after ANY execution that
 * ends with an error (guest throw, timeout, crash, stack overflow, heap limit), and
 * after `maxUses` successful executions, so WASM state a guest may have damaged
 * never outlives one failure and module growth is bounded.
 *
 * Same isolation as WorkerExecutor: empty `env`, V8 heap limit, tool functions stay
 * in the parent, hard kill at timeoutMs + killGraceMs. Idle workers are `unref`'d so
 * they never keep the process alive; call `close()` to stop the pool explicitly.
 */
import { Worker } from "node:worker_threads";
import type { ExecuteOptions, ExecuteResult, Executor, ResolvedProvider } from "../types.ts";
import { WORKER_ENTRY, type WorkerExecutorOptions } from "./worker-executor.ts";
import { providerSpecs, runCall, toProviders, type CallMsg, type Fns } from "./worker-bridge.ts";

export interface PooledWorkerExecutorOptions extends WorkerExecutorOptions {
  /** Maximum number of workers (= concurrent executions). Extra executions queue FIFO. Default 2. */
  size?: number;
  /** Successful executions per worker before it is recycled. Default 100. */
  maxUses?: number;
  /** Idle workers are terminated after this many ms (0 = never). Default 30_000. */
  idleMs?: number;
  /** Pre-warm workers at construction and after recycling (except idle reaping). Default true. */
  prewarm?: boolean;
}

export interface PoolStats { spawned: number; alive: number; idle: number; busy: number; queued: number; warming: number }

type DoneMsg = { type: "done"; job: number; result: ExecuteResult };
type WorkerMsg = CallMsg | DoneMsg | { type: "ready" } | { type: "failed"; error: string };

interface Slot {
  worker: Worker;
  uses: number;
  isReady: boolean;
  ready: Promise<string | null>; // null = ready, string = start-up error
  idleTimer?: NodeJS.Timeout;
  onMessage?: (m: CallMsg | DoneMsg) => void;
  onDead?: (reason: string) => void;
  dead: boolean;
  exited: boolean;
  deathReason?: string;
}

export class PooledWorkerExecutor implements Executor {
  readonly #size: number;
  readonly #maxUses: number;
  readonly #idleMs: number;
  readonly #prewarm: boolean;
  readonly #heapMb: number;
  readonly #killGraceMs: number;
  readonly #timeoutMs: number;
  readonly #quickjs: WorkerExecutorOptions;
  readonly #slots = new Set<Slot>();
  readonly #idle: Slot[] = [];
  readonly #queue: Array<(s: Slot | null) => void> = [];
  readonly #terminating = new Map<Slot, Promise<void>>();
  #closing?: Promise<void>;
  #spawned = 0;
  #nextJob = 0;
  #closed = false;

  constructor(options: PooledWorkerExecutorOptions = {}) {
    const { size = 2, maxUses = 100, idleMs = 30_000, prewarm = true, workerHeapMb = 128, killGraceMs = 1_000, ...quickjs } = options;
    if (!Number.isInteger(size) || size < 1) throw new Error("PooledWorkerExecutor: size must be an integer >= 1");
    if (!Number.isInteger(maxUses) || maxUses < 1) throw new Error("PooledWorkerExecutor: maxUses must be an integer >= 1");
    this.#size = size;
    this.#maxUses = maxUses;
    this.#idleMs = idleMs;
    this.#prewarm = prewarm;
    this.#heapMb = workerHeapMb;
    this.#killGraceMs = killGraceMs;
    this.#timeoutMs = quickjs.timeoutMs ?? 30_000;
    this.#quickjs = { ...quickjs, timeoutMs: this.#timeoutMs };
    this.#tryRefill(true);
  }

  get stats(): PoolStats {
    let warming = 0;
    for (const slot of this.#slots) if (!slot.isReady) warming++;
    return { spawned: this.#spawned, alive: this.#slots.size, idle: this.#idle.length, busy: this.#slots.size - this.#idle.length, queued: this.#queue.length, warming };
  }

  execute(code: string, providersOrFns: ResolvedProvider[] | Fns, options?: ExecuteOptions): Promise<ExecuteResult> {
    if (options?.connectors?.length) {
      return Promise.resolve({ result: undefined, error: "PooledWorkerExecutor does not support connector bindings", logs: [] });
    }
    const providers = toProviders(providersOrFns);
    return this.#acquire().then((slot) => (slot ? this.#run(slot, code, providers) : { result: undefined, error: "Executor pool is closed", logs: [] }));
  }

  /** Terminates every worker. In-flight and queued executions resolve with an error. Idempotent. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const w of this.#queue.splice(0)) w(null);
    for (const slot of this.#slots) void this.#destroy(slot, "Executor pool closed", true);
    // Wait for both new and already-running terminations, including unref'ed idle retirements.
    this.#refTerminating();
    this.#closing = Promise.allSettled(this.#terminating.values()).then((results) => {
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.#closing;
  }

  #spawn(): Slot {
    const worker = new Worker(WORKER_ENTRY, {
      workerData: { mode: "pool", options: this.#quickjs },
      env: {},
      // No `stderr: true` here: a captured stderr stream keeps the process alive even after
      // worker.unref(). The worker silences its own stderr instead (emscripten abort noise).
      resourceLimits: { maxOldGenerationSizeMb: this.#heapMb },
    });
    this.#spawned++;
    let markReady!: (v: string | null) => void;
    const slot: Slot = { worker, uses: 0, isReady: false, ready: new Promise((r) => (markReady = r)), dead: false, exited: false };
    this.#slots.add(slot);
    worker.on("message", (m: WorkerMsg) => {
      if (slot.dead) return;
      if (m.type === "ready") { slot.isReady = true; markReady(null); }
      else if (m.type === "failed") dead(`Sandbox worker failed to start: ${m.error}`);
      else slot.onMessage?.(m);
    });
    const dead = (reason: string) => {
      markReady(reason);
      if (slot.dead) return;
      void this.#destroy(slot, reason);
    };
    worker.on("error", (e) => dead(`Sandbox worker failed: ${e.message}`));
    worker.on("exit", (c) => {
      slot.exited = true;
      dead(`Sandbox worker exited (code ${c})`);
    });
    return slot;
  }

  #acquire(): Promise<Slot | null> {
    if (this.#closed) return Promise.resolve(null);
    const ready = this.#idle.findIndex((slot) => slot.isReady);
    // Starting workers are parked in creation order: take the oldest if none is ready.
    const idle = this.#idle.splice(ready < 0 ? 0 : ready, 1)[0];
    if (idle) return Promise.resolve(this.#take(idle));
    if (this.#hasCapacity()) return Promise.resolve(this.#take(this.#spawn()));
    this.#refTerminating();
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  #take(slot: Slot): Slot {
    clearTimeout(slot.idleTimer);
    slot.worker.ref();
    return slot;
  }

  /** Hands a healthy slot to the next queued execution, or parks it as idle. */
  #park(slot: Slot): void {
    if (slot.dead) return this.#tryRefill(false);
    const next = this.#queue.shift();
    if (next) return next(this.#take(slot));
    slot.worker.unref();
    this.#idle.push(slot);
    if (this.#idleMs > 0) {
      slot.idleTimer = setTimeout(() => void this.#destroy(slot, "idle", true), this.#idleMs);
      slot.idleTimer.unref();
    }
  }

  #hasCapacity(): boolean {
    return !this.#closed && this.#slots.size + this.#terminating.size < this.#size;
  }

  #refTerminating(): void {
    for (const slot of this.#terminating.keys()) if (!slot.exited) slot.worker.ref();
  }

  /** Serve demand first; idle reaping and failed warm-up do not trigger prewarming. */
  #tryRefill(allowPrewarm: boolean): void {
    while (this.#queue.length && this.#hasCapacity()) {
      const slot = this.#take(this.#spawn());
      this.#queue.shift()!(slot);
    }
    while (allowPrewarm && this.#prewarm && !this.#queue.length && this.#hasCapacity()) this.#park(this.#spawn());
  }

  #forget(slot: Slot): void {
    clearTimeout(slot.idleTimer);
    this.#slots.delete(slot);
    const i = this.#idle.indexOf(slot);
    if (i >= 0) this.#idle.splice(i, 1);
  }

  #destroy(slot: Slot, reason: string, cooperative = false): Promise<void> {
    if (slot.dead) return Promise.resolve();
    slot.dead = true;
    slot.deathReason = reason;
    this.#forget(slot);
    const canCooperate = cooperative && slot.isReady && !slot.onMessage && !slot.exited;
    const allowPrewarm = slot.isReady && reason !== "idle";
    const terminated = this.#stopWorker(slot, canCooperate, reason === "idle").finally(() => {
      this.#terminating.delete(slot);
      this.#tryRefill(allowPrewarm);
    });
    this.#terminating.set(slot, terminated);
    // Background retirement has no caller; close still sees failures in its snapshot.
    void terminated.catch(() => {});
    slot.onDead?.(reason);
    this.#tryRefill(allowPrewarm);
    return terminated;
  }

  async #stopWorker({ worker }: Slot, cooperative: boolean, idle: boolean): Promise<void> {
    if (!cooperative) {
      await worker.terminate();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      const force = async () => {
        clearTimeout(timer);
        worker.off("exit", onExit);
        try {
          await worker.terminate();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      worker.once("exit", onExit);
      const timer = setTimeout(force, this.#killGraceMs);
      if (idle) timer.unref();
      try {
        worker.postMessage({ type: "shutdown" });
      } catch {
        void force();
      }
    });
  }

  #run(slot: Slot, code: string, providers: ResolvedProvider[]): Promise<ExecuteResult> {
    if (this.#closed || slot.dead) {
      return Promise.resolve({ result: undefined, error: slot.deathReason ?? "Executor pool is closed", logs: [] });
    }
    const job = ++this.#nextJob;
    const byName = new Map(providers.map((p) => [p.name, p.fns as Fns]));
    return new Promise<ExecuteResult>((resolve) => {
      let settled = false;
      const finish = (r: ExecuteResult, healthy: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(kill);
        slot.onMessage = slot.onDead = undefined;
        slot.uses++;
        if (healthy && !r.error && slot.uses < this.#maxUses && !this.#closed) this.#park(slot);
        else void this.#destroy(slot, "recycled", healthy && !r.error);
        resolve(r);
      };
      // Covers worker start-up too, so a worker that never becomes ready cannot hang the caller.
      const kill = setTimeout(
        () => finish({ result: undefined, error: `Execution timed out after ${this.#timeoutMs}ms (worker terminated)`, logs: [] }, false),
        this.#timeoutMs + this.#killGraceMs,
      );
      slot.onDead = (reason) => finish({ result: undefined, error: reason, logs: [] }, false);
      slot.onMessage = async (m) => {
        if (m.job !== job) return; // stale message from an earlier job on this worker
        if (m.type === "done") return finish(m.result, true);
        const reply = await runCall(byName, m);
        if (!settled) slot.worker.postMessage(reply);
      };
      void slot.ready.then((err) => {
        if (settled) return;
        if (err) return finish({ result: undefined, error: err, logs: [] }, false);
        slot.worker.postMessage({ type: "job", job, code, providers: providerSpecs(providers) });
      });
    });
  }
}
