import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getActiveMultiplexer: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('./ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: mocks.getActiveMultiplexer
}))

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))

const { markRemoteAgentWorkspaceTrusted } = await import('./remote-agent-trust-presets')

function makeFsProvider(overrides: Record<string, unknown> = {}) {
  return {
    realpath: vi.fn(async (path: string) => `/real${path}`),
    readFile: vi.fn(async () => ({ content: '', isBinary: false })),
    createDir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => {
      throw new Error('missing')
    }),
    ...overrides
  }
}

function writeFileCalls(fsProvider: ReturnType<typeof makeFsProvider>): [string, string][] {
  return fsProvider.writeFile.mock.calls as unknown as [string, string][]
}

describe('markRemoteAgentWorkspaceTrusted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: '/home/u/' }))
    })
  })

  it('writes Codex trust to the remote home and canonicalized workspace path', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(mocks.getActiveMultiplexer).toHaveBeenCalledWith('ssh-1')
    expect(fsProvider.realpath).toHaveBeenCalledWith('/repo/worktree')
    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.codex')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.codex/config.toml',
      expect.stringContaining('[projects."/real/repo/worktree"]')
    )
  })

  it('writes Codex trust when the remote home is a Windows absolute path', async () => {
    const fsProvider = makeFsProvider({
      realpath: vi.fn(async () => 'C:/Users/alice/platform')
    })
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'C:\\Users\\alice\\' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-windows',
      workspacePath: 'C:\\Users\\alice\\platform'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('C:/Users/alice/.codex')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:/Users/alice/.codex/config.toml',
      expect.stringContaining('[projects."C:/Users/alice/platform"]')
    )
  })

  it('writes Cursor trust marker on the remote host', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'cursor',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.cursor/projects/real-repo-worktree')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.cursor/projects/real-repo-worktree/.workspace-trusted',
      expect.stringContaining('"workspacePath": "/real/repo/worktree"')
    )
  })

  it('sanitizes Windows path characters in remote Cursor trust marker paths', async () => {
    const fsProvider = makeFsProvider({
      realpath: vi.fn(async () => 'C:/Users/alice/platform')
    })
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'C:/Users/alice/' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'cursor',
      connectionId: 'ssh-windows',
      workspacePath: 'C:\\Users\\alice\\platform'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith(
      'C:/Users/alice/.cursor/projects/C-Users-alice-platform'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:/Users/alice/.cursor/projects/C-Users-alice-platform/.workspace-trusted',
      expect.stringContaining('"workspacePath": "C:/Users/alice/platform"')
    )
  })

  it('appends Copilot trusted folder remotely without clobbering config keys', async () => {
    const writeFile = vi.fn(async (_filePath: string, _content: string) => undefined)
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({
        content: JSON.stringify({ firstLaunchAt: '2026-01-01', trustedFolders: ['/old'] }),
        isBinary: false
      })),
      writeFile
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'copilot',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.copilot')
    const written = writeFile.mock.calls[0]?.[1]
    expect(typeof written).toBe('string')
    expect(JSON.parse(written as string)).toEqual({
      firstLaunchAt: '2026-01-01',
      trustedFolders: ['/old', '/real/repo/worktree']
    })
  })

  it('does nothing when the SSH home cannot be resolved safely', async () => {
    const fsProvider = makeFsProvider()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'relative/home' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })

  it('sets hasTrustDialogAccepted on the remote Claude config', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'claude',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.writeFile).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenBody] = writeFileCalls(fsProvider)[0]
    expect(writtenPath).toBe('/home/u/.claude.json')
    expect(JSON.parse(writtenBody)).toEqual({
      projects: { '/real/repo/worktree': { hasTrustDialogAccepted: true } }
    })
  })

  it('preserves the remote Claude config it did not author', async () => {
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({
        content: JSON.stringify({
          oauthAccount: { emailAddress: 'someone@example.com' },
          projects: { '/other': { hasTrustDialogAccepted: true } }
        }),
        isBinary: false
      }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'claude',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    const parsed = JSON.parse(writeFileCalls(fsProvider)[0][1]) as {
      oauthAccount: unknown
      projects: Record<string, unknown>
    }
    expect(parsed.oauthAccount).toEqual({ emailAddress: 'someone@example.com' })
    expect(parsed.projects['/other']).toEqual({ hasTrustDialogAccepted: true })
    expect(parsed.projects['/real/repo/worktree']).toEqual({ hasTrustDialogAccepted: true })
  })

  it('leaves an unparseable remote Claude config alone', async () => {
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({ content: '{ not json', isBinary: false }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'claude',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })

  it('skips the remote Claude write when trust is already accepted', async () => {
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({
        content: JSON.stringify({
          projects: { '/real/repo/worktree': { hasTrustDialogAccepted: true } }
        }),
        isBinary: false
      }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'claude',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })
})
