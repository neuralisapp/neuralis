'use client';

import { createElement, useState, type ComponentType } from 'react';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { WorkspaceRoot } from '@/workspace/WorkspaceRoot';
import { HOST_SLOTS, useHostSlot } from '@/workspace/packages/hostRegistryInstance';
import PasswordChangeModal from '@/workspace/shell/PasswordChangeModal';
import { seedHostRuntimeFacts } from '@/workspace/packages/buildWorkspaceHostPort';

/** The `workspace.banner` slot: whatever a native package fills it with, above the workspace. */
function WorkspaceBanner() {
  const Banner = useHostSlot(HOST_SLOTS.banner);
  return Banner ? createElement(Banner as ComponentType) : null;
}

type Props = {
  initialSnapshot: PackageRuntimeSnapshot | null;
  refreshSnapshot: () => Promise<PackageRuntimeSnapshot>;
  /** The server's own container fact (the kernel's `detectDocker`), read at request time. */
  isDocker: boolean;
  mustChangePassword?: boolean;
  userId?: string;
};

export function WorkspacePageClient({
  initialSnapshot,
  refreshSnapshot,
  isDocker,
  mustChangePassword,
  userId,
}: Props) {
  // Synchronous, before any package UI renders: surfaces read `port.isDocker` at render.
  seedHostRuntimeFacts({ isDocker });
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
