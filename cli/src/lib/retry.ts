export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  onAttempt?: (attempt: number, attempts: number) => void;
}

/** Retry an async action, swallowing errors until the last attempt. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 20, delayMs = 5000, onAttempt } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    onAttempt?.(attempt, attempts);
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
