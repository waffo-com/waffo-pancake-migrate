import ora from "ora";

const active = new Set<ReturnType<typeof ora>>();

export function spinner(
  ...args: Parameters<typeof ora>
): ReturnType<typeof ora> {
  const instance = ora(...args);
  active.add(instance);
  return instance;
}

/** Release timers and restore stdin/cursor even when an awaited operation throws. */
export function stopSpinners(): void {
  for (const instance of active) instance.stop();
  active.clear();
}
