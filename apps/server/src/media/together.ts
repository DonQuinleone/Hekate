/**
 * Run tasks side by side under one signal: if any fails, the others are cancelled, and the
 * result settles only once every task has ended, so nothing still runs in a workspace
 * that is about to be removed. Rejects with the first failure in time.
 */
export async function together<T extends readonly unknown[]>(
  signal: AbortSignal,
  tasks: { [K in keyof T]: (signal: AbortSignal) => Promise<T[K]> },
): Promise<T> {
  const shared = new AbortController();
  const stop = () => shared.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  // The first failure in time is the cause; the others are mostly its cancellations.
  let cause: { error: unknown } | undefined;
  try {
    const settled = await Promise.allSettled(
      tasks.map((task) =>
        task(shared.signal).catch((error: unknown) => {
          cause ??= { error };
          stop();
          throw error;
        }),
      ),
    );
    if (cause) throw cause.error;
    return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
