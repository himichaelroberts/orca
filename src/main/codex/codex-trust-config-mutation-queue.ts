// Why: the lane is keyed by file path and carries nothing Codex-specific, so
// Claude's `.claude.json` trust write shares it. Codex call sites keep their
// existing name.
export { runExclusivelyForAgentConfigFile as runExclusivelyForCodexTrustConfig } from '../agent-config-mutation-queue'
