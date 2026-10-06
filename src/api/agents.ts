import type { WorkspaceAgentRecord } from '@neuralis/package-system/contracts';
import { apiGet } from './http';

/**
 * The workspace's agent list: the host's own `GET /api/agents`, typed by the
 * kernel record (`AgentDirectory.listAgents`). The host keeps no copy of an
 * agent's configuration vocabulary — `config` is opaque here, and creating or
 * editing an agent is the owning package's UI, through its own routes.
 */
export async function listAgents(projectId: string): Promise<WorkspaceAgentRecord[]> {
  return apiGet<WorkspaceAgentRecord[]>(`/api/agents?projectId=${encodeURIComponent(projectId)}`);
}
