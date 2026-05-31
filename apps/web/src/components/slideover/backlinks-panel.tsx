import type { BacklinkRow } from '../../lib/api/backlinks.ts';

interface Props {
  backlinks: BacklinkRow[];
  onOpen: (slug: string) => void;
}

export function BacklinksPanel({ backlinks, onOpen }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-fg-3">Linked from</div>
      {backlinks.length === 0 ? (
        <p className="text-xs text-fg-3">No documents link here.</p>
      ) : (
        backlinks.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onOpen(b.slug)}
            className="block w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
          >
            {b.title}
          </button>
        ))
      )}
    </div>
  );
}
