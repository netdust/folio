import { toast } from 'sonner';
import type { DocumentPatch, DocumentSummary } from '../../lib/api/documents.ts';
import { formatApiError } from '../../lib/api/index.ts';
import type { Status } from '../../lib/api/statuses.ts';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { RowContextMenu } from '../views/row-context-menu.tsx';
import { type Column, gridTemplate } from './columns.ts';
import { TableCell } from './table-cell.tsx';

interface Props {
  doc: DocumentSummary;
  columns: Column[];
  statuses: Status[];
  wslug: string;
  pslug: string;
  isPending: boolean;
  onOpen: (slug: string) => void;
  onUpdate: (slug: string, patch: DocumentPatch) => void;
  resolveRelation?: (slug: string) => { slug: string; title: string } | null;
}

export function TableRow({
  doc,
  columns,
  statuses,
  wslug,
  pslug,
  isPending,
  onOpen,
  onUpdate,
  resolveRelation,
}: Props) {
  const onTitleCommit = (slug: string, next: string) => onUpdate(slug, { title: next });
  const onStatusCommit = (slug: string, next: string) => onUpdate(slug, { status: next });
  const onFieldCommit = (slug: string, key: string, next: unknown) =>
    onUpdate(slug, { frontmatter: { [key]: next } });

  const onCopy = async () => {
    try {
      await copyDocumentAsMarkdown(wslug, pslug, doc.slug);
      toast.success('Copied as Markdown');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <RowContextMenu items={[{ label: 'Copy as Markdown', onSelect: onCopy, hint: '⌘⇧C' }]}>
      <div
        role="listitem"
        className="group/row flex min-h-[35px] w-full items-center gap-2 border-b border-border-light py-1 hover:bg-card"
      >
        {/* No `gap` — columns sit flush so each cell's `border-l` (in TableCell)
            is a true full-height column separator at the column boundary, aligned
            with the header. The cell's own `px-3` provides the internal spacing. */}
        <div
          className="grid flex-1 items-center"
          style={{ gridTemplateColumns: gridTemplate(columns) }}
        >
          {columns.map((c, i) => (
            <TableCell
              key={c.key}
              column={c}
              doc={doc}
              statuses={statuses}
              wslug={wslug}
              pslug={pslug}
              isPending={isPending}
              isSticky={i === 0}
              onOpen={onOpen}
              onTitleCommit={onTitleCommit}
              onStatusCommit={onStatusCommit}
              onFieldCommit={onFieldCommit}
              resolveRelation={resolveRelation}
            />
          ))}
        </div>
        <div
          aria-hidden
          className="sticky right-0 z-[1] w-11 flex-shrink-0 self-stretch border-l border-border-light bg-content group-hover/row:bg-card"
        />
      </div>
    </RowContextMenu>
  );
}
