import type { GroupedListSettings } from '@folio/shared';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { Field } from '../../lib/api/fields.ts';
import { FieldRenderer } from '../slideover/field-renderer.tsx';

const noop = () => {};

interface Props {
  doc: DocumentSummary;
  rowLayout: GroupedListSettings['rowLayout'];
  /** Field metadata (for the rowLayout field type → FieldRenderer). */
  fields: Field[];
  onOpen: (slug: string) => void;
}

/**
 * Resolve a layout key's display value off the document. The primary/subtitle
 * keys read the column (title/status) first, then frontmatter; layout `fields`
 * read frontmatter.
 */
function readValue(doc: DocumentSummary, key: string): unknown {
  if (key === 'title') return doc.title;
  if (key === 'status') return doc.status;
  return (doc.frontmatter as Record<string, unknown>)[key];
}

/**
 * A composed rich-row: a clickable primary line + optional subtitle, with the
 * configured `rowLayout.fields` rendered read-only via the shared FieldRenderer.
 * Clicking the row opens the document slideover (the caller wires `?doc=`).
 */
export function GroupedListRow({ doc, rowLayout, fields, onOpen }: Props) {
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  const subtitleVal = rowLayout.subtitle ? readValue(doc, rowLayout.subtitle) : undefined;

  return (
    <button
      type="button"
      data-testid={`grouped-row-${doc.slug}`}
      onClick={() => onOpen(doc.slug)}
      className="flex w-full items-center gap-3 rounded-md border border-border-light bg-shell px-3 py-2 text-left transition-colors hover:bg-card"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">
          {String(readValue(doc, rowLayout.primary) ?? 'Untitled')}
        </div>
        {subtitleVal !== undefined && subtitleVal !== null && subtitleVal !== '' ? (
          <div className="truncate text-xs text-fg-3">{String(subtitleVal)}</div>
        ) : null}
      </div>
      {rowLayout.fields.length > 0 ? (
        <div className="flex shrink-0 items-center gap-3">
          {rowLayout.fields.map((key) => {
            const field = fieldByKey.get(key);
            const value = (doc.frontmatter as Record<string, unknown>)[key];
            if (value === undefined || value === null || value === '') return null;
            return (
              <div
                key={key}
                className="text-xs text-fg-2"
                // Don't let a field-cell click bubble to the row's open handler.
                onClickCapture={(e) => e.stopPropagation()}
                onKeyDownCapture={(e) => e.stopPropagation()}
              >
                <FieldRenderer
                  fieldKey={key}
                  type={field?.type ?? 'string'}
                  value={value}
                  options={field?.options ?? undefined}
                  onCommit={noop}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </button>
  );
}
