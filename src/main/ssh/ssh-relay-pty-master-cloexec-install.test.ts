import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayInstallMarkerModule from './ssh-relay-install-marker'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+testhash')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-install-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayInstallMarkerModule>()),
  createRelayInstallMarkerFileName: () => '.sftp-namespace-00000000000000000000000000000000'
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(false),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import {
  makeExecResponses,
  makeStagedFirstInstallExecPrefix,
  makeMockConnection,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'

const PATCH_ASSET = 'node-pty-1.1.0-master-cloexec-patch.cjs'

/**
 * The relay installs stock node-pty from npm, so the app's pnpm patch never reaches it and every
 * later child of the relay inherits a live pty master (#17915). The compile that closes it sits on
 * the connect path, so what these specs pin is the blast radius, not the patch itself.
 */
describe('relay pty-master close-on-exec patch on the install path', () => {
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    sftpCapture.paths.length = 0
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
  })

  function feed(execResponses: ExecResponse[]): void {
    const mockExec = vi.mocked(execCommand)
    for (const response of execResponses) {
      if (typeof response === 'string') {
        mockExec.mockResolvedValueOnce(response)
      } else {
        mockExec.mockRejectedValueOnce(new Error(response.reject))
      }
    }
  }

  function patchCommands(): string[] {
    return vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => command)
      .filter((command) => command.includes(PATCH_ASSET))
  }

  it('runs the patch on a Linux relay once node-pty is proven loadable', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))

    await deployAndLaunchRelay(conn)

    expect(patchCommands()).toHaveLength(1)
    expect(patchCommands()[0]).toContain("'/usr/bin/node'")
  })

  it('leaves an unloadable node-pty alone rather than rebuilding it blind', async () => {
    // A relay that could not build node-pty has nothing to fall back to, and the existing
    // reinstall path owns that repair.
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: 'ok',
        probe: 'missing',
        repairProbe: 'missing'
      })
    )

    await deployAndLaunchRelay(conn)

    expect(patchCommands()).toEqual([])
  })

  it('never adds a compile to a macOS relay, which does not leak the master', async () => {
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('darwin-arm64')
    const conn = makeMockConnection(sftpCapture)
    feed([
      ...makeStagedFirstInstallExecPrefix(),
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      '', // clean stage root
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(patchCommands()).toEqual([])
  })

  it('connects anyway when the patch command fails outright', async () => {
    const conn = makeMockConnection(sftpCapture)
    const responses = makeExecResponses({ npmInstall: 'ok', probe: 'ok' })
    const patchSlot = responses.findIndex(
      (response) => typeof response === 'string' && response.includes('ORCA-NPTY-CLOEXEC:')
    )
    expect(patchSlot).toBeGreaterThan(-1)
    responses[patchSlot] = { reject: 'no such file or directory' }
    feed(responses)

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()
  })
})
