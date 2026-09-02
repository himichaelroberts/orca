import type { AgentTrustPreset } from '../../shared/agent-trust-preset'
import { ipcRenderer } from 'electron'

export const agentTrustApi = {
  markTrusted: (args: {
    preset: AgentTrustPreset
    workspacePath: string
    connectionId?: string
  }): Promise<void> => ipcRenderer.invoke('agentTrust:markTrusted', args)
}
