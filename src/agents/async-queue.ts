interface PendingConsumer<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

/** A small single-consumer-friendly async queue used by every AgentRun. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #consumers: PendingConsumer<T>[] = [];
  #ended = false;
  #failure: unknown;

  push(value: T): boolean {
    if (this.#ended) return false;

    const consumer = this.#consumers.shift();
    if (consumer) {
      consumer.resolve({ value, done: false });
    } else {
      this.#values.push(value);
    }
    return true;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#drainConsumers();
  }

  fail(error: unknown): void {
    if (this.#ended) return;
    this.#failure = error;
    this.#ended = true;
    this.#drainConsumers();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.#next(),
    };
  }

  #next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }

    if (this.#ended) {
      return this.#failure === undefined
        ? Promise.resolve({ value: undefined, done: true })
        : Promise.reject(this.#failure);
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#consumers.push({ resolve, reject });
    });
  }

  #drainConsumers(): void {
    for (const consumer of this.#consumers.splice(0)) {
      if (this.#failure === undefined) {
        consumer.resolve({ value: undefined, done: true });
      } else {
        consumer.reject(this.#failure);
      }
    }
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
