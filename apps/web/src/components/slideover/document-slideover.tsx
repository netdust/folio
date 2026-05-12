import { useNavigate, useSearch } from '@tanstack/react-router';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { useDocument } from '../../lib/api/documents.ts';

interface Props {
  wslug: string;
  pslug: string;
}

export function DocumentSlideover({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { doc?: string };
  const open = !!search.doc;
  const slug = search.doc ?? null;
  const { data: doc, isLoading, error } = useDocument(wslug, pslug, slug);

  const close = () => {
    const { doc: _doc, ...next } = search;
    void navigate({ to: '.', search: next });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <SheetContent width={800} className="h-screen">
        <SheetHeader>
          <SheetTitle>
            {isLoading ? 'Loading…' : error ? 'Failed to load' : doc?.title ?? '—'}
          </SheetTitle>
          <IconButton label="Close document" onClick={close}>
            <span className="font-mono text-sm">×</span>
          </IconButton>
        </SheetHeader>
        <div className="flex-1 overflow-auto px-6 py-4">
          {isLoading ? (
            <div className="text-fg-3">Loading document…</div>
          ) : error ? (
            <div className="text-danger">Failed to load document.</div>
          ) : doc ? (
            <article>
              <div className="font-mono text-[11px] text-fg-3">/{doc.slug}</div>
              {/* Frontmatter form lands in Task 15, body editor in Task 16.
                  For Task 14 we render the body as a read-only pre block. */}
              <pre className="mt-4 whitespace-pre-wrap font-mono text-sm text-fg">
                {doc.body || '(empty body)'}
              </pre>
            </article>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
