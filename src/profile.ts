import { channel } from 'node:diagnostics_channel';

// Local, opt-in diagnostics for the disposable benchmark harness. No content,
// paths, environment values, or output are collected by an ordinary CLI run.
const timing = channel('membrain.performance');
const noop = () => undefined;
export function span(name: string): () => void {
  if (!timing.hasSubscribers) return noop;
  const start = performance.now();
  return () => timing.publish({ name, durationMs: performance.now() - start });
}
