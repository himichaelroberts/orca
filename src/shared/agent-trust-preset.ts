/** The agent whose "Do you trust this folder?" gate a preflight write satisfies.
 *  Shared so the main-process presets, the preload bridge, and
 *  `TUI_AGENT_CONFIG.preflightTrust` cannot drift apart. */
export type AgentTrustPreset = 'cursor' | 'copilot' | 'codex' | 'claude'
