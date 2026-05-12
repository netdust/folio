import { inferFieldType } from '@folio/shared';
import type { Status } from '../../lib/api/statuses.ts';
import type { Field, FieldType } from '../../lib/api/fields.ts';
import { InlineSelect } from '../inline/inline-select.tsx';
import { FieldRenderer } from './field-renderer.tsx';

interface Props {
  type: 'work_item' | 'page';
  status: string | null;
  statuses: Status[];
  frontmatter: Record<string, unknown>;
  pinnedFields: Field[];
  onStatusCommit: (next: string) => void;
  onFrontmatterCommit: (patch: Record<string, unknown>) => void;
  pendingKeys?: Set<string>;
}

export function FrontmatterForm({
  type,
  status,
  statuses,
  frontmatter,
  pinnedFields,
  onStatusCommit,
  onFrontmatterCommit,
  pendingKeys,
}: Props) {
  const pinnedByKey = new Map(pinnedFields.map((f) => [f.key, f]));

  // Sort keys: pinned (by `order`) first, then inferred (alphabetical).
  const inferredKeys = Object.keys(frontmatter).filter((k) => !pinnedByKey.has(k)).sort();
  const orderedKeys = [
    ...pinnedFields.map((f) => f.key),
    ...inferredKeys.filter((k) => k in frontmatter),
  ];

  return (
    <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
      {type === 'work_item' ? (
        <>
          <dt className="self-center font-mono text-[11px] text-fg-3">status</dt>
          <dd>
            <InlineSelect
              value={status}
              options={statuses.map((s) => ({ value: s.key, label: s.name, color: s.color }))}
              onCommit={onStatusCommit}
              placeholder="no status"
              renderDisplay={(opt) =>
                opt ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5"
                    style={{ backgroundColor: `${opt.color}22`, color: opt.color }}
                  >
                    {opt.label}
                  </span>
                ) : (
                  <span className="text-fg-3">no status</span>
                )
              }
            />
          </dd>
        </>
      ) : null}

      {orderedKeys.map((key) => {
        const value = frontmatter[key];
        const pinned = pinnedByKey.get(key);
        const fieldType: FieldType = pinned?.type ?? inferFieldType(value);
        const label = pinned?.label ?? key;
        const options = pinned?.options ?? undefined;
        return (
          <div key={key} className="contents">
            <dt className="self-center font-mono text-[11px] text-fg-3" title={key}>
              {label}
            </dt>
            <dd>
              <FieldRenderer
                fieldKey={key}
                type={fieldType}
                value={value}
                options={options ?? undefined}
                onCommit={(next) => onFrontmatterCommit({ [key]: next })}
                isPending={pendingKeys?.has(key)}
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
