/**
 * Per-phone serial queue with a global concurrency limit.
 * Different phones run in parallel; the same phone stays ordered.
 */
export function createPhoneQueue(options?: { maxConcurrent?: number }) {
  const maxConcurrent = Math.max(1, options?.maxConcurrent ?? 5);
  let running = 0;
  const waiters: Array<() => void> = [];
  const phoneTails = new Map<string, Promise<void>>();
  let pending = 0;

  async function acquire(): Promise<void> {
    if (running < maxConcurrent) {
      running += 1;
      return;
    }
    // Slot is transferred by release() — do not increment again.
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    running = Math.max(0, running - 1);
  }

  function enqueue(phone: string, task: () => Promise<void>): void {
    pending += 1;
    const prev = phoneTails.get(phone) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await acquire();
        try {
          await task();
        } finally {
          release();
        }
      })
      .catch((err) => {
        console.error(`Phone queue task failed for ${phone}`, err);
      })
      .finally(() => {
        pending = Math.max(0, pending - 1);
        if (phoneTails.get(phone) === next) {
          phoneTails.delete(phone);
        }
      });
    phoneTails.set(phone, next);
  }

  function stats(): { running: number; pending: number; phones: number } {
    return { running, pending, phones: phoneTails.size };
  }

  async function drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pending > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return { enqueue, stats, drain };
}

export type PhoneQueue = ReturnType<typeof createPhoneQueue>;

/**
 * Buffer rapid messages from the same phone (e.g. "04.09" then "18:00")
 * into one combined turn before the phone queue runs.
 */
export function createDebouncedIngress<TMeta>(options: {
  queue: PhoneQueue;
  delayMs?: number;
  combineTexts?: (texts: string[]) => string;
  run: (args: {
    phone: string;
    text: string;
    metas: TMeta[];
  }) => Promise<void>;
}) {
  const delayMs = Math.max(200, options.delayMs ?? 1200);
  const combineTexts =
    options.combineTexts ?? ((texts: string[]) => texts.join("\n").trim());
  const buffers = new Map<
    string,
    {
      texts: string[];
      metas: TMeta[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function flushPhone(phone: string): void {
    const buf = buffers.get(phone);
    if (!buf) return;
    clearTimeout(buf.timer);
    buffers.delete(phone);
    const text = combineTexts(buf.texts);
    const metas = buf.metas;
    if (!text) return;
    options.queue.enqueue(phone, () => options.run({ phone, text, metas }));
  }

  function push(phone: string, text: string, meta: TMeta): void {
    let buf = buffers.get(phone);
    if (buf) {
      clearTimeout(buf.timer);
    } else {
      buf = { texts: [], metas: [], timer: setTimeout(() => {}, 0) };
      clearTimeout(buf.timer);
      buffers.set(phone, buf);
    }
    buf.texts.push(text);
    buf.metas.push(meta);
    buf.timer = setTimeout(() => flushPhone(phone), delayMs);
  }

  async function drain(timeoutMs = 5000): Promise<void> {
    for (const phone of [...buffers.keys()]) {
      flushPhone(phone);
    }
    await options.queue.drain(timeoutMs);
  }

  return { push, drain, flushPhone };
}

export type DebouncedIngress<TMeta> = ReturnType<
  typeof createDebouncedIngress<TMeta>
>;
