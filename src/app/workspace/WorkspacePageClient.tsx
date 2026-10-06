'use client';

import { createElement, useState, type ComponentType } from 'react';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { WorkspaceRoot } from '@/workspace/WorkspaceRoot';
import { HOST_SLOTS, useHostSlot } from '@/workspace/packages/hostRegistryInstance';
import PasswordChangeModal from '@/workspace/shell/PasswordChangeModal';

/** The `workspace.banner` slot: whatever a first-party package fills it with, above the workspace. */
function WorkspaceBanner() {
  const Banner = useHostSlot(HOST_SLOTS.banner);
  return Banner ? createElement(Banner as ComponentType) : null;
}

type Props = {
  initialSnapshot: PackageRuntimeSnapshot | null;
  refreshSnapshot: () => Promise<PackageRuntimeSnapshot>;
  mustChangePassword?: boolean;
  userId?: string;
};

export function WorkspacePageClient({
  initialSnapshot,
  refreshSnapshot,
  mustChangePassword,
  userId,
}: Props) {
  const [showPwdModal, setShowPwdModal] = useState(!!mustChangePassword);

  if (showPwdModal && userId) {
    return (
      <PasswordChangeModal
        userId={userId}
        forced
        onSuccess={() => {
          setShowPwdModal(false);
          // Force page reload to get fresh session without mustChangePassword
          window.location.reload();
        }}
      />
    );
  }

  return (
    <>
      <WorkspaceBanner />
      <WorkspaceRoot
        initialSnapshot={initialSnapshot}
        refreshSnapshot={refreshSnapshot}
      />
    </>
  );
}
