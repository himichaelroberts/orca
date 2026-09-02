import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  applyLocalAgentTrustPreset: vi.fn()
}))

vi.mock('../agent-trust-presets', () => mocks)

import { markLocalWorktreeTrusted } from './runtime-worktree-agent-startup'

describe('markLocalWorktreeTrusted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.applyLocalAgentTrustPreset.mockResolvedValue(undefined)
  })

  it('waits for the trust write before resolving', async () => {
    let finish!: () => void
    mocks.applyLocalAgentTrustPreset.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    let settled = false
    const marking = markLocalWorktreeTrusted('codex', '/workspace/app').then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await marking
    expect(mocks.applyLocalAgentTrustPreset).toHaveBeenCalledWith('codex', '/workspace/app')
  })

  it('contains a rejected trust write', async () => {
    mocks.applyLocalAgentTrustPreset.mockRejectedValueOnce(new Error('write failed'))

    await expect(markLocalWorktreeTrusted('codex', '/workspace/app')).resolves.toBeUndefined()
  })

  it('resolves the claude preset so the Chat UI launch is not left at the trust dialog', async () => {
    await markLocalWorktreeTrusted('claude', '/workspace/app')

    expect(mocks.applyLocalAgentTrustPreset).toHaveBeenCalledWith('claude', '/workspace/app')
  })

  it('skips agents with no preset', async () => {
    await markLocalWorktreeTrusted('gemini', '/workspace/app')

    expect(mocks.applyLocalAgentTrustPreset).not.toHaveBeenCalled()
  })
})
