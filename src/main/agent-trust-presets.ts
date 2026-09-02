import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { AgentTrustPreset } from '../shared/agent-trust-preset'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { ClaudeRuntimePathResolver } from './claude-accounts/runtime-paths'
import { observe } from './codex/codex-path-observation'
import { resolveLoginShellEnvironment } from './startup/login-shell-environment'
import { getOrcaManagedCodexHomePath } from './codex/codex-home-paths'
import { upsertProjectTrustLevel } from './codex/config-toml-trust'
import { runExclusivelyForAgentConfigFile } from './agent-config-mutation-queue'
import { runExclusivelyForCodexTrustConfig } from './codex/codex-trust-config-mutation-queue'

export type { AgentTrustPreset }

/**
 * Pre-mark a workspace as trusted for cursor-agent, GitHub Copilot CLI,
 * Codex, or Claude Code so the agent's "Do you trust this folder?" menu does
 * not fire on first launch.
 *
 * Why: Orca's "drop URL into agent input as a draft" flow injects the URL
 * via bracketed-paste once the TUI is up. If the trust menu intercepts the
 * keystrokes (each menu reads a single character or numbered option), the
 * paste either selects an arbitrary option or quits the session. Pre-writing
 * the same trust artifacts that the agent writes after the user accepts is
 * the only documented bypass — both CLIs read these files at startup before
 * showing the menu.
 *
 * Side note: a `--trust`-style CLI flag exists in cursor-agent but only
 * applies in `--print/headless` mode (per its --help). Copilot has no
 * documented flag at all (verified against @github/copilot 1.0.32 bundle).
 * Codex's `--dangerously-bypass-approvals-and-sandbox` would also change
 * approval/sandbox policy, so it is not equivalent to "trust this project".
 * Claude Code has no interactive flag either: `--print` skips the dialog but
 * only in non-interactive mode, and `--permission-mode` /
 * `--dangerously-skip-permissions` govern tool approvals, not workspace trust.
 */

/**
 * Cursor's CLI keeps a per-workspace trust marker at:
 *   ~/.cursor/projects/<slug>/.workspace-trusted
 * where <slug> is the absolute path with the leading `/` stripped and
 * remaining `/` replaced with `-`. The file payload is `{ trustedAt,
 * workspacePath }`. Verified against the cursor-agent CLI bundle
 * (versions/2026.04.17-787b533/index.ts: `_=".workspace-trusted"`, slug
 * derived via the same util that resolves `~/.cursor/projects/<slug>`).
 */
export function markCursorWorkspaceTrusted(workspacePath: string): void {
  const absPath = canonicalize(workspacePath)
  const slug = cursorWorkspaceSlug(absPath)
  if (!slug) {
    return
  }
  const trustDir = join(homedir(), '.cursor', 'projects', slug)
  const trustFile = join(trustDir, '.workspace-trusted')
  if (existsSync(trustFile)) {
    return
  }
  mkdirSync(trustDir, { recursive: true })
  const payload = JSON.stringify(
    { trustedAt: new Date().toISOString(), workspacePath: absPath },
    null,
    2
  )
  writeFileAtomically(trustFile, `${payload}\n`)
}

/**
 * GitHub Copilot CLI keeps a global list of trusted folders in
 * ~/.copilot/config.json under `trustedFolders` (verified against the
 * @github/copilot 1.0.32 bundle: `addTrustedFolder` and `isFolderTrusted`
 * both read/write this exact key, and folder comparison is done after a
 * realpath() resolution).
 *
 * We append to the array in-place so unrelated config keys (loggedInUsers,
 * copilotTokens, etc.) survive untouched.
 */
export function markCopilotFolderTrusted(workspacePath: string): void {
  const absPath = canonicalize(workspacePath)
  const configDir = join(homedir(), '.copilot')
  const configPath = join(configDir, 'config.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Why: a corrupted config.json is the user's to fix — refuse to overwrite
    // it from this side-effect path. Copilot will rewrite the file itself
    // after the user accepts the trust prompt manually.
    return
  }
  const existing = Array.isArray(config.trustedFolders) ? (config.trustedFolders as unknown[]) : []
  const normalizedExisting = existing.map((entry) =>
    typeof entry === 'string' ? canonicalize(entry) : null
  )
  if (normalizedExisting.includes(absPath)) {
    return
  }
  const next = [...existing.filter((e) => typeof e === 'string'), absPath]
  config.trustedFolders = next
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * Codex stores project trust in ~/.codex/config.toml under:
 *   [projects."<realpath>"]
 *   trust_level = "trusted"
 *
 * Verified against codex-rs/tui/src/onboarding/trust_directory.rs and
 * codex-rs/core/src/config/config_tests.rs in the Codex CLI source.
 */
export function markCodexProjectTrusted(workspacePath: string): Promise<void> {
  const absPath = resolveCodexProjectTrustRoot(workspacePath)
  const systemTomlPath = join(homedir(), '.codex', 'config.toml')
  // Why: Orca-launched Codex runs with an Orca-owned CODEX_HOME, so the trust
  // preset must also update the runtime config Codex will actually read.
  const runtimeTomlPath = join(getOrcaManagedCodexHomePath(), 'config.toml')
  // Why (#16441): hook installs now await a codex app-server grant, so an
  // unqueued write here can land inside their capture->restore window and be
  // reverted. Same runtime-before-system lock order the installer takes.
  return runExclusivelyForCodexTrustConfig(runtimeTomlPath, () =>
    runExclusivelyForCodexTrustConfig(systemTomlPath, async () => {
      upsertProjectTrustLevel(systemTomlPath, absPath, 'trusted')
      upsertProjectTrustLevel(runtimeTomlPath, absPath, 'trusted')
    })
  )
}

/**
 * The config path the *launched* Claude will read.
 *
 * Why not just the runtime resolver: it reads this process's
 * `CLAUDE_CONFIG_DIR`, but agents run in a PTY whose profile-loading shell may
 * export a different one — a GUI-launched Electron never sourced those rc
 * files, so the two disagree exactly when the user sets it in their shell. The
 * write would then land in a file the session never opens and the dialog would
 * still fire, silently. Falls back to the resolver on any failure, which is the
 * pre-existing behavior.
 */
async function resolveClaudeLaunchConfigPath(): Promise<string> {
  try {
    const launchEnv = await resolveLoginShellEnvironment()
    // Why trim only the emptiness test: a directory name may legally carry
    // leading or trailing spaces, and Claude reads the raw env value — trimming
    // the path itself would send this write to a file the session never opens.
    const launchConfigDir = launchEnv.CLAUDE_CONFIG_DIR
    if (launchConfigDir?.trim()) {
      return join(launchConfigDir, '.claude.json')
    }
  } catch {
    // Fall through to the process-env resolver.
  }
  return new ClaudeRuntimePathResolver().getRuntimePaths().configPath
}

/**
 * Claude Code keeps per-project trust in its config JSON under:
 *   { "projects": { "<realpath>": { "hasTrustDialogAccepted": true } } }
 *
 * The config path is whatever the runtime resolver picks (CLAUDE_CONFIG_DIR,
 * else a colocated ~/.claude/.claude.json, else ~/.claude.json), so trust
 * lands in the file the launched agent will actually read.
 *
 * Only `hasTrustDialogAccepted` is written. The sibling
 * `hasClaudeMdExternalIncludesApproved` flag is a separate consent about
 * executing external CLAUDE.md includes, and granting it here would approve
 * something the user never saw.
 */
export async function markClaudeProjectTrusted(workspacePath: string): Promise<void> {
  const absPath = canonicalize(workspacePath)
  const configPath = await resolveClaudeLaunchConfigPath()
  // Why: the config holds live per-session counters every running Claude
  // rewrites, so two concurrent worktree creations must not read-modify-write
  // it at once and drop each other's entry.
  return runExclusivelyForAgentConfigFile(configPath, async () => {
    // Why observe() and not existsSync: existsSync answers false for EACCES,
    // EPERM, EIO and every unrecognised errno as readily as for ENOENT, so an
    // unreadable config would look like "no config yet" and be replaced —
    // taking the user's Claude auth, history, and MCP servers with it. One call
    // also closes the TOCTOU window the existsSync + read pair opened.
    const observation = observe(() => readFileSync(configPath, 'utf-8'))
    if (observation.kind === 'indeterminate') {
      return
    }
    let config: Record<string, unknown> = {}
    if (observation.kind === 'present') {
      let parsed: unknown
      try {
        parsed = JSON.parse(observation.value)
      } catch {
        // Why: a config we cannot parse is the user's to fix. Claude rewrites
        // it itself once the trust prompt is accepted manually.
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return
      }
      config = parsed as Record<string, unknown>
    }
    const projectsValue = config.projects
    const projects =
      projectsValue && typeof projectsValue === 'object' && !Array.isArray(projectsValue)
        ? (projectsValue as Record<string, unknown>)
        : {}
    const existingEntry = projects[absPath]
    const entry =
      existingEntry && typeof existingEntry === 'object' && !Array.isArray(existingEntry)
        ? (existingEntry as Record<string, unknown>)
        : {}
    if (entry.hasTrustDialogAccepted === true) {
      return
    }
    projects[absPath] = { ...entry, hasTrustDialogAccepted: true }
    config.projects = projects
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
  })
}

/**
 * One writer per preset, so the local dispatch has a single source of truth.
 *
 * Why `satisfies Record<AgentTrustPreset, …>`: a preset added to the union
 * fails to compile here (TS2741) instead of silently doing nothing at launch —
 * which is exactly how Claude went unsupported. Note the repo's oxlint
 * `switch-exhaustiveness-check` is not type-aware across modules, so a bare
 * switch would NOT have caught it.
 */
const LOCAL_TRUST_PRESET_WRITERS = {
  cursor: async (workspacePath: string) => markCursorWorkspaceTrusted(workspacePath),
  copilot: async (workspacePath: string) => markCopilotFolderTrusted(workspacePath),
  // Why: the Codex write queues behind any in-flight hook grant, so the agent must not launch until it lands.
  codex: (workspacePath: string) => markCodexProjectTrusted(workspacePath),
  claude: (workspacePath: string) => markClaudeProjectTrusted(workspacePath)
} satisfies Record<AgentTrustPreset, (workspacePath: string) => Promise<void>>

/** Applies one local trust preset. */
export async function applyLocalAgentTrustPreset(
  preset: AgentTrustPreset,
  workspacePath: string
): Promise<void> {
  await LOCAL_TRUST_PRESET_WRITERS[preset](workspacePath)
}

function resolveCodexProjectTrustRoot(workspacePath: string): string {
  const absPath = canonicalize(workspacePath)
  try {
    const gitDirReference = readFileSync(join(absPath, '.git'), 'utf-8').trim()
    if (!gitDirReference.startsWith('gitdir:')) {
      return absPath
    }
    const gitDirPath = gitDirReference.slice('gitdir:'.length).trim()
    if (!gitDirPath) {
      return absPath
    }
    const gitDir = resolve(absPath, gitDirPath)
    const worktreesDir = dirname(gitDir)
    if (basename(worktreesDir) !== 'worktrees') {
      return absPath
    }
    // Why: workspace-controlled .git metadata must not broaden trust without Git's reciprocal link.
    const gitDirBacklink = readFileSync(join(gitDir, 'gitdir'), 'utf-8').trim()
    if (!gitDirBacklink) {
      return absPath
    }
    const resolvedBacklink = resolve(gitDir, gitDirBacklink)
    const workspaceGitFile = join(absPath, '.git')
    if (
      resolvedBacklink !== workspaceGitFile &&
      canonicalize(resolvedBacklink) !== canonicalize(workspaceGitFile)
    ) {
      return absPath
    }
    // Why: mirror Codex's validated .git/worktrees/<name> traversal instead of trusting arbitrary commondir contents.
    return canonicalize(dirname(dirname(worktreesDir)))
  } catch {
    return absPath
  }
}

function canonicalize(p: string): string {
  // Why: macOS reports `/tmp/x` and `/private/tmp/x` as the same inode, but
  // both Cursor and Copilot's trust comparators run realpath() before the
  // string compare. Mirror that so a worktree under a symlinked parent
  // (orca caches realpath()'d worktree paths) matches the agent's lookup.
  try {
    if (existsSync(p)) {
      return realpathSync.native(p)
    }
  } catch {
    // Fall through to the raw input.
  }
  return p
}

function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  // Why: Windows absolute paths include characters such as ":" that cannot
  // be used in the ~/.cursor/projects/<slug> directory name.
  const slug = stripped.replace(/[\\/:*?"<>|]+/g, '-')
  return slug
}
