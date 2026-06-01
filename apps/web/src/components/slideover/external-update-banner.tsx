import type { ExternalUpdate } from '../../lib/use-live-document.ts';

interface ExternalUpdateBannerProps {
  update: ExternalUpdate;
  /** Discard the local draft + pull server truth. Only shown for 'updated'. */
  onReload: () => void;
  onDismiss: () => void;
}

/**
 * Shared banner for the notify-don't-stomp slideover live-update flow. Rendered
 * by both document-slideover and workspace-document-slideover so the wording,
 * styling, and a11y stay in one place. The reload ACTION differs per slideover
 * (different query-key family), so it is injected via `onReload`.
 */
export function ExternalUpdateBanner({
  update,
  onReload,
  onDismiss,
}: ExternalUpdateBannerProps) {
  return (
    <div
      role="status"
      className="mb-2 flex flex-shrink-0 items-center gap-2 rounded border border-border-light bg-card px-3 py-1.5 text-xs text-fg-2"
    >
      <span>
        {update.kind === 'deleted'
          ? 'This document was deleted.'
          : `Updated by ${update.actor ?? 'someone'}.`}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        {update.kind === 'updated' && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-medium text-fg hover:bg-bg"
            onClick={onReload}
          >
            Reload
          </button>
        )}
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-fg-3 hover:bg-bg hover:text-fg"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
