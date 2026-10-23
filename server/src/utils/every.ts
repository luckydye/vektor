/** Run `task` every `intervalMs` without keeping the process alive; returns what stops it. */
export function every(intervalMs: number, task: () => void): () => void {
  const timer = setInterval(task, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
