import { AsyncLocalStorage } from 'node:async_hooks'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'

const tailByConfigPath = new Map<string, Promise<void>>()
// Why: the grant lane runs inside the installer that already owns the file.
// AsyncLocalStorage survives awaits, so the inner acquire can see the outer
// one and pass through instead of queueing behind itself forever.
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Serializes everything that mutates one agent config file as a single lane
 * per file — Codex `config.toml` hook installs, trust grants, and user-hook
 * rebases, and Claude `.claude.json` trust grants.
 *
 * Why (#16441): these used to block the main thread, so two of them could
 * never be in flight at once. Now that they await, a second run could write
 * the file between another run's capture and its restore-on-failure, undoing
 * a mutation that run never made and resurrecting trust it deliberately
 * removed.
 */
export function runExclusivelyForAgentConfigFile<T>(
  configPath: string,
  run: () => Promise<T>
): Promise<T> {
  const key = normalizeRuntimePathForComparison(configPath)
  const held = heldKeys.getStore()
  if (held?.has(key)) {
    return run()
  }
  const owned = new Set(held ?? [])
  owned.add(key)
  const enter = (): Promise<T> => heldKeys.run(owned, run)
  const previous = tailByConfigPath.get(key) ?? Promise.resolve()
  // Why both handlers: a rejected predecessor must not cancel the queue.
  const result = previous.then(enter, enter)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  tailByConfigPath.set(key, tail)
  void tail.then(() => {
    if (tailByConfigPath.get(key) === tail) {
      tailByConfigPath.delete(key)
    }
  })
  return result
}
