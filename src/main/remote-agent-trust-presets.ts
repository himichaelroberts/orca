import type { AgentTrustPreset } from './agent-trust-presets'
import { runExclusivelyForAgentConfigFile } from './agent-config-mutation-queue'
import { upsertProjectTrustLevelInContent } from './codex/config-toml-trust'
import { getActiveMultiplexer } from './ssh/ssh-target-registry'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from './providers/types'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../shared/cross-platform-path'

export async function markRemoteAgentWorkspaceTrusted(args: {
  preset: AgentTrustPreset
  connectionId: string
  workspacePath: string
}): Promise<void> {
  const home = await resolveRemoteHome(args.connectionId)
  const fsProvider = getSshFilesystemProvider(args.connectionId)
  if (!home || !fsProvider) {
    return
  }

  const workspacePath = await canonicalizeRemoteWorkspacePath(fsProvider, args.workspacePath)
  if (args.preset === 'codex') {
    await markRemoteCodexProjectTrusted(fsProvider, home, workspacePath)
  } else if (args.preset === 'cursor') {
    await markRemoteCursorWorkspaceTrusted(fsProvider, home, workspacePath)
  } else if (args.preset === 'copilot') {
    await markRemoteCopilotFolderTrusted(fsProvider, home, workspacePath)
  } else if (args.preset === 'claude') {
    await markRemoteClaudeProjectTrusted(fsProvider, home, workspacePath, args.connectionId)
  }
}

async function resolveRemoteHome(connectionId: string): Promise<string | null> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux || mux.isDisposed?.()) {
    return null
  }
  const result = (await mux.request('session.resolveHome', { path: '~' })) as {
    resolvedPath?: unknown
  }
  const home =
    typeof result.resolvedPath === 'string'
      ? normalizeRuntimePathSeparators(result.resolvedPath.trim())
      : ''
  return home &&
    (home.startsWith('/') || isWindowsAbsolutePathLike(home)) &&
    !hasRemotePathControlCharacter(home)
    ? home.replace(/\/$/, '')
    : null
}

function hasRemotePathControlCharacter(value: string): boolean {
  return value.includes(String.fromCharCode(0)) || value.includes('\r') || value.includes('\n')
}

async function canonicalizeRemoteWorkspacePath(
  fsProvider: IFilesystemProvider,
  workspacePath: string
): Promise<string> {
  try {
    return await fsProvider.realpath(workspacePath)
  } catch {
    return workspacePath
  }
}

async function readRemoteTextFile(
  fsProvider: IFilesystemProvider,
  filePath: string
): Promise<string> {
  try {
    const result = await fsProvider.readFile(filePath)
    return result.isBinary ? '' : result.content
  } catch {
    return ''
  }
}

async function markRemoteCodexProjectTrusted(
  fsProvider: IFilesystemProvider,
  remoteHome: string,
  workspacePath: string
): Promise<void> {
  const codexDir = `${remoteHome}/.codex`
  const configPath = `${codexDir}/config.toml`
  const existing = await readRemoteTextFile(fsProvider, configPath)
  const updated = upsertProjectTrustLevelInContent(existing, workspacePath, 'trusted', {
    // Why: workspacePath was resolved by the remote filesystem provider; local
    // realpath would canonicalize the wrong machine on SSH.
    alreadyCanonical: true
  })
  if (updated === existing) {
    return
  }
  await fsProvider.createDir(codexDir)
  await fsProvider.writeFile(configPath, updated)
}

async function markRemoteCursorWorkspaceTrusted(
  fsProvider: IFilesystemProvider,
  remoteHome: string,
  workspacePath: string
): Promise<void> {
  const slug = workspacePath.replace(/^[\\/]+/, '').replace(/[\\/:*?"<>|]+/g, '-')
  if (!slug) {
    return
  }
  const trustDir = `${remoteHome}/.cursor/projects/${slug}`
  const trustFile = `${trustDir}/.workspace-trusted`
  try {
    await fsProvider.stat(trustFile)
    return
  } catch {
    // Missing marker: write the same shape the local trust preset writes.
  }
  await fsProvider.createDir(trustDir)
  await fsProvider.writeFile(
    trustFile,
    `${JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath }, null, 2)}\n`
  )
}

async function markRemoteCopilotFolderTrusted(
  fsProvider: IFilesystemProvider,
  remoteHome: string,
  workspacePath: string
): Promise<void> {
  const configDir = `${remoteHome}/.copilot`
  const configPath = `${configDir}/config.json`
  const raw = await readRemoteTextFile(fsProvider, configPath)
  let config: Record<string, unknown> = {}
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>
      }
    } catch {
      return
    }
  }
  const existing = Array.isArray(config.trustedFolders) ? (config.trustedFolders as unknown[]) : []
  if (existing.includes(workspacePath)) {
    return
  }
  config.trustedFolders = [...existing.filter((entry) => typeof entry === 'string'), workspacePath]
  await fsProvider.createDir(configDir)
  await fsProvider.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * Remote mirror of `markClaudeProjectTrusted`. The local runtime resolver is
 * not consulted: CLAUDE_CONFIG_DIR belongs to this desktop process, and the
 * SSH-launched agent reads the remote user's own home.
 */
async function markRemoteClaudeProjectTrusted(
  fsProvider: IFilesystemProvider,
  remoteHome: string,
  workspacePath: string,
  connectionId: string
): Promise<void> {
  const configPath = await resolveRemoteClaudeConfigPath(fsProvider, remoteHome)
  // Why: this is a read-modify-write of a file that carries the remote user's
  // auth, history, and every other project entry. Two workspace creations on
  // one host would otherwise write stale snapshots and drop each other's trust
  // entry, leaving that launch still facing the dialog. Keyed by host so
  // separate connections do not serialize against each other.
  return runExclusivelyForAgentConfigFile(`${connectionId}\u0000${configPath}`, async () => {
    const existing = await readRemoteClaudeConfig(fsProvider, configPath)
    if (existing === 'unreadable') {
      return
    }
    const config = existing
    const projectsValue = config.projects
    const projects =
      projectsValue && typeof projectsValue === 'object' && !Array.isArray(projectsValue)
        ? (projectsValue as Record<string, unknown>)
        : {}
    const existingEntry = projects[workspacePath]
    const entry =
      existingEntry && typeof existingEntry === 'object' && !Array.isArray(existingEntry)
        ? (existingEntry as Record<string, unknown>)
        : {}
    if (entry.hasTrustDialogAccepted === true) {
      return
    }
    projects[workspacePath] = { ...entry, hasTrustDialogAccepted: true }
    config.projects = projects
    await fsProvider.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  })
}

/**
 * Reads the remote Claude config, separating "no config yet" from "there is one
 * and we could not read it".
 *
 * Why: `readRemoteTextFile` flattens a transport error, a permission denial,
 * and a binary result all into `''`, which is indistinguishable from an absent
 * file. Treating that as empty and writing would replace a live config —
 * discarding the remote user's Claude credentials, history, and MCP servers.
 * Probe existence first and refuse to write over anything we cannot parse.
 */
async function readRemoteClaudeConfig(
  fsProvider: IFilesystemProvider,
  configPath: string
): Promise<Record<string, unknown> | 'unreadable'> {
  let exists = true
  try {
    await fsProvider.stat(configPath)
  } catch {
    exists = false
  }
  if (!exists) {
    return {}
  }
  let content: string
  try {
    const result = await fsProvider.readFile(configPath)
    if (result.isBinary) {
      return 'unreadable'
    }
    content = result.content
  } catch {
    return 'unreadable'
  }
  if (!content.trim()) {
    // An empty file has nothing to lose.
    return {}
  }
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'unreadable'
    }
    return parsed as Record<string, unknown>
  } catch {
    return 'unreadable'
  }
}

/**
 * Mirrors `resolveConfigPath`: Claude reads a colocated
 * `<home>/.claude/.claude.json` when that file exists, else `<home>/.claude.json`.
 * Probed on the remote host, because the fallback is a filesystem condition
 * there and not something this desktop process can infer. `CLAUDE_CONFIG_DIR`
 * stays out of scope — it belongs to this process, not the SSH host.
 */
async function resolveRemoteClaudeConfigPath(
  fsProvider: IFilesystemProvider,
  remoteHome: string
): Promise<string> {
  const colocated = `${remoteHome}/.claude/.claude.json`
  try {
    await fsProvider.stat(colocated)
    return colocated
  } catch {
    return `${remoteHome}/.claude.json`
  }
}
