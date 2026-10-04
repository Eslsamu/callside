export interface SetupProgress {
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  percent?: number;
  message: string;
}
export async function withSetupProgress<T>(
  token: string,
  path: string,
  action: () => Promise<T>,
  update?: (value: SetupProgress) => void,
): Promise<T> {
  let active = true;
  const poll = async () => {
    try {
      const response = await fetch('/api/' + path + '/status', {
        headers: { 'X-Callside-Token': token },
      });
      if (response.ok && active) update?.(await response.json());
    } catch {
      /* The preparation request reports failures. */
    }
  };
  const timer = setInterval(() => void poll(), 500);
  try {
    return await action();
  } finally {
    active = false;
    clearInterval(timer);
  }
}
