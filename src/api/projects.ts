import { apiGet, apiPost, apiPatch, apiDelete } from './http';

export type ProjectMember = {
  userId: string;
  name: string;
  /** D2 projection: present for the caller's OWN row always; for other members
   *  only with `project.members`. */
  email?: string;
  role: string;
  position: string;
  tier: number;
  addedAt: string;
};

export type RoleDefinition = {
  agents: '*' | 'own' | 'view';
  canInvite: boolean;
  canManageRoles: boolean;
  /** D2 projection: present for the caller's OWN role always (client-side
   *  widget gating reads it); for other roles only with `project.roles`. */
  grantedFeatures?: string[];
  /** Ordinal role priority (lower = stronger; S4). Server-returned; built-in
   *  roles resolve via `rolePriority` even when omitted. */
  priority?: number;
};

export type AgentOwnershipEntry = {
  createdBy: string;
  assignedTo: string[];
};

/** The project's icon, colour and picture reference — every member sees it. */
export type { ProjectAppearance } from '@/server/store/projectTypes';
import type { ProjectAppearance } from '@/server/store/projectTypes';
import type { AppearancePayload } from '@/workspace/shell/appearanceEditor';

// Canonical spend-limit shape — kernel-owned, type-only import (erased at build).
export type { SpendLimits, SpendLimitRule, SpendPeriod } from '@neuralis/package-system/contracts';
import type { SpendLimits } from '@neuralis/package-system/contracts';

export type ProjectRecord = {
  id: string;
  name: string;
  description?: string;
  appearance?: ProjectAppearance;
  ownerId: string;
  members: Record<string, ProjectMember>;
  roles: Record<string, RoleDefinition>;
  agentOwnership: Record<string, AgentOwnershipEntry>;
  limits: { spend: SpendLimits; rateLimitRpm?: number | null };
  sandbox?: { landlock?: { enabled: boolean; networkAccess: boolean } };
  createdAt: string;
  updatedAt: string;
};

export async function listProjects(): Promise<ProjectRecord[]> {
  return apiGet<ProjectRecord[]>('/api/projects');
}

export async function getProject(id: string): Promise<ProjectRecord> {
  return apiGet<ProjectRecord>(`/api/projects/${id}`);
}

export async function createProject(params: {
  name: string;
  description?: string;
}): Promise<ProjectRecord> {
  return apiPost<ProjectRecord>('/api/projects', params);
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<ProjectRecord, 'name' | 'description' | 'members' | 'roles' | 'agentOwnership' | 'limits'>> & {
    /** `null` resets the appearance, the picture included. */
    appearance?: AppearancePayload | null;
  },
): Promise<ProjectRecord> {
  return apiPatch<ProjectRecord>(`/api/projects/${id}`, patch);
}

export async function deleteProject(id: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/api/projects/${id}`);
}
