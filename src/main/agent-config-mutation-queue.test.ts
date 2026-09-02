import { describe, expect, it } from 'vitest'
import { runExclusivelyForAgentConfigFile } from './agent-config-mutation-queue'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runExclusivelyForAgentConfigFile', () => {
  // Why: the grant lane runs inside the installer that already owns the file;
  // a non-reentrant lane would queue it behind itself and never settle.
  it('passes through a nested acquire of a lane the caller already holds', async () => {
    const nested = await runExclusivelyForAgentConfigFile('/a/config.toml', () =>
      runExclusivelyForAgentConfigFile('/a/config.toml', () => Promise.resolve('inner'))
    )
    expect(nested).toBe('inner')
  })

  it('still queues an unrelated lane acquired from inside another lane', async () => {
    const gate = deferred()
    let innerRan = false
    const blocking = runExclusivelyForAgentConfigFile('/b/config.toml', () => gate.promise)
    const nested = runExclusivelyForAgentConfigFile('/a/config.toml', () =>
      runExclusivelyForAgentConfigFile('/b/config.toml', () => {
        innerRan = true
        return Promise.resolve()
      })
    )
    await Promise.resolve()
    expect(innerRan).toBe(false)
    gate.resolve()
    await blocking
    await nested
    expect(innerRan).toBe(true)
  })

  it('runs one mutation at a time per config.toml', async () => {
    const order: string[] = []
    const first = deferred()
    const second = deferred()

    const a = runExclusivelyForAgentConfigFile('/home/.codex/config.toml', async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
      return 'a'
    })
    const b = runExclusivelyForAgentConfigFile('/home/.codex/config.toml', async () => {
      order.push('b:start')
      await second.promise
      order.push('b:end')
      return 'b'
    })

    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    first.resolve()
    await a
    second.resolve()
    await b
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('keeps distinct config.toml paths independent', async () => {
    const gate = deferred()
    let secondRan = false
    const blocked = runExclusivelyForAgentConfigFile('/a/config.toml', () => gate.promise)
    await runExclusivelyForAgentConfigFile('/b/config.toml', async () => {
      secondRan = true
    })
    expect(secondRan).toBe(true)
    gate.resolve()
    await blocked
  })

  it('keeps the queue alive after a rejected mutation', async () => {
    const failing = runExclusivelyForAgentConfigFile('/a/config.toml', () =>
      Promise.reject(new Error('grant blew up'))
    )
    await expect(failing).rejects.toThrow('grant blew up')
    await expect(
      runExclusivelyForAgentConfigFile('/a/config.toml', () => Promise.resolve('next'))
    ).resolves.toBe('next')
  })

  // Why: normalized keys, so a Windows caller passing the other separator or
  // case must still land in the same lane as the run it has to wait for.
  it('serializes equivalent paths that differ only in normalization', async () => {
    const gate = deferred()
    let secondStarted = false
    const blocked = runExclusivelyForAgentConfigFile(
      String.raw`C:\Users\Alice\.codex\config.toml`,
      () => gate.promise
    )
    const queued = runExclusivelyForAgentConfigFile('C:/Users/Alice/.codex/config.toml', () => {
      secondStarted = true
      return Promise.resolve()
    })
    await Promise.resolve()
    expect(secondStarted).toBe(false)
    gate.resolve()
    await blocked
    await queued
    expect(secondStarted).toBe(true)
  })

  it('coalesces WSL UNC aliases without folding the case-sensitive Linux path', async () => {
    const aliasGate = deferred()
    let aliasStarted = false
    const blockedAlias = runExclusivelyForAgentConfigFile(
      String.raw`\\wsl.localhost\Ubuntu\home\Alice\.codex\config.toml`,
      () => aliasGate.promise
    )
    const queuedAlias = runExclusivelyForAgentConfigFile(
      String.raw`\\wsl$\ubuntu\home\Alice\.codex\config.toml`,
      () => {
        aliasStarted = true
        return Promise.resolve()
      }
    )
    await Promise.resolve()
    expect(aliasStarted).toBe(false)

    let distinctStarted = false
    await runExclusivelyForAgentConfigFile(
      String.raw`\\wsl.localhost\Ubuntu\home\alice\.codex\config.toml`,
      async () => {
        distinctStarted = true
      }
    )
    expect(distinctStarted).toBe(true)

    aliasGate.resolve()
    await blockedAlias
    await queuedAlias
    expect(aliasStarted).toBe(true)
  })
})
