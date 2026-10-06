import type {
  PackageTrust,
  WidgetRuntimeDefinition,
} from '@neuralis/package-system/contracts';
import type { ComponentType } from 'react';
import { createElement } from 'react';
import type { WidgetDefinition } from '../widgets/types';
import { getHostRegistry } from './hostRegistryInstance';
import { IframeWidget, type IframeWidgetSource } from './IframeWidget';
import { isAssetBackedSurfaceUrl } from './packageAssetScope';
import { isUiModulePending, uiModuleRefusalReason } from './uiModuleLoader';

type DirectRenderer = ComponentType<Record<string, unknown>>;

export function resolveWidgetRenderer(
  widget: WidgetRuntimeDefinition,
  trust: PackageTrust | undefined,
): WidgetDefinition {
  const componentImport = widget.component.import;

  if (widget.component.renderer === 'direct' && componentImport) {
    const Component = getHostRegistry().resolve(componentImport) as DirectRenderer | null;
    if (Component) {
      return {
        type: widget.type,
        title: widget.title ?? widget.type,
        icon: widget.icon,
        chrome: widget.chrome,
        openBehavior: widget.open,
        defaultOpen: widget.defaultOpen,
        packageId: widget.packageId,
        trust,
        render: (ctx) => createElement(Component, {
          agentId: ctx.agentId,
          widgetId: ctx.instance.id,
          state: ctx.instance.state,
          hidden: ctx.instance.hidden === true,
        }),
      };
    }
  }

  if (widget.component.renderer === 'iframe' && widget.component.url && widget.packageId) {
    const url = widget.component.url;
    const title = widget.title ?? widget.type;
    // CARD1 3A — the client does NOT navigate a URL for asset-backed widgets:
    // the snapshot's `/api/packages/{id}/app/…` value is a host-internal
    // logical descriptor. The scoped-asset path needs the COORDINATE
    // (packageId, surfaceKind, surfaceId, fingerprint); the entry path is
    // resolved server-side at mint (§F item 2). Only a genuinely remote
    // absolute URL (trusted/first-party — untrusted absolutes are dropped in
    // the snapshot) is passed through as-is. `isAssetBackedSurfaceUrl` is the
    // ONE client-side classifier, shared with the card reconcile.
    const source: IframeWidgetSource =
      isAssetBackedSurfaceUrl(url)
        ? {
            kind: 'scoped-asset',
            coordinate: {
              packageId: widget.packageId,
              // K1 — the widget's asset-scope identity is its EXACT declared type.
              surfaceId: widget.type,
              fingerprint: `widget:${url}`,
            },
          }
        : { kind: 'absolute', url, trust };
    return {
      type: widget.type,
      title,
      icon: widget.icon,
      chrome: widget.chrome,
      openBehavior: widget.open,
      defaultOpen: widget.defaultOpen,
      packageId: widget.packageId,
      trust,
      render: () => <IframeWidget title={title} source={source} />,
    };
  }

  // A `direct` surface whose runtime module is still attaching is LOADING, not
  // unrenderable — the registry notifies and the widget re-resolves. One the
  // host REFUSED names the reason in place (the same list the server logged).
  const attaching = widget.component.renderer === 'direct' && isUiModulePending(widget.packageId);
  const refusalOf = (): string | null =>
    widget.component.renderer === 'direct' && widget.packageId ? uiModuleRefusalReason(widget.packageId) : null;
  return {
    type: widget.type,
    title: widget.title ?? widget.type,
    icon: widget.icon,
    chrome: widget.chrome,
    openBehavior: widget.open,
    defaultOpen: widget.defaultOpen,
    packageId: widget.packageId,
    trust,
    render: () => {
      const refusal = attaching ? null : refusalOf();
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center text-sm text-white/55">
          <span>{attaching ? 'Loading…' : 'This widget cannot be rendered by this host.'}</span>
          {refusal ? (
            <span className="text-xs text-white/40">
              Its UI module was refused ({refusal}) — the package owner rebuilds it for this host.
            </span>
          ) : null}
        </div>
      );
    },
  };
}
