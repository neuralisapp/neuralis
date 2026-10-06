import { apiGet, apiPost, apiPatch, apiDelete } from './http';

export type AdminUserView = {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  invitedBy: string | null;
  createdAt: string;
  role: string | null;
  position: string | null;
  tier: number | null;
  isMember: boolean;
};

export type InviteData = {
  email: string;
  name: string;
  role: string;
  password?: string;
  projectId?: string;
};

export type InviteResult = {
  user: { id: string; email: string; name: string };
  tempPassword?: string;
  role: string;
};

export function listAdminUsers(): Promise<{ users: AdminUserView[] }> {
  return apiGet('/api/admin/users');
}

export function inviteUser(data: InviteData): Promise<InviteResult> {
  return apiPost('/api/admin/users', data);
}

export function updateAdminUser(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; tempPassword?: string }> {
  return apiPatch(`/api/admin/users/${id}`, patch);
}

export function deleteAdminUser(id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/api/admin/users/${id}`);
}

export function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return apiPatch(`/api/admin/users/${userId}`, { currentPassword, newPassword });
}
