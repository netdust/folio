import { toast } from 'sonner';
import { TableCell } from './table-cell.tsx';
import { RowContextMenu } from '../views/row-context-menu.tsx';
import { gridTemplate, type Column } from './columns.ts';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { formatApiError } from '../../lib/api/index.ts';
import type { DocumentSummary, DocumentPatch } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';

interface Props {
  doc: DocumentSummary;
  columns: Column[];
  statuses: Status[];
  wslug: string;
  pslug: string;
  isPending: boolean;
  onOpen: (slug: string) => void;
  onUpdate: (slug: string, patch: DocumentPatch) => void;
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
        className="group/row flex w-full items-center gap-2 border-b border-border-light py-1 hover:bg-card"
      >
        <div
          className="grid flex-1 items-center gap-3"
          style={{ gridTemplateColumns: gridTemplate(columns) }}
        >
          {(() => {
            const last = columns[columns.length - 1];
            return (
              <>
                {columns.slice(0, -1).map((c, i) => (
                  <TableCell
                    key={c.key}
                    column={c}
                    doc={doc}
                    statuses={statuses}
                    isPending={isPending}
                    isSticky={i === 0}
                    onOpen={onOpen}
                    onTitleCommit={onTitleCommit}
                    onStatusCommit={onStatusCommit}
                    onFieldCommit={onFieldCommit}
                  />
                ))}
                {columns.length > 1 ? <div aria-hidden /> : null}
                {last ? (
                  <TableCell
                    key={last.key}
                    column={last}
                    doc={doc}
                    statuses={statuses}
                    isPending={isPending}
                    isSticky={columns.length === 1}
                    onOpen={onOpen}
                    onTitleCommit={onTitleCommit}
                    onStatusCommit={onStatusCommit}
                    onFieldCommit={onFieldCommit}
                  />
                ) : null}
              </>
            );
          })()}
        </div>
        {/* Spacer matching the column-picker IconButton on the header for grid alignment. */}
        <div aria-hidden className="h-6 w-6 shrink-0" />
      </div>
    </RowContextMenu>
  );
}
