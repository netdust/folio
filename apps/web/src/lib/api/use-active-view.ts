import { useSearch } from '@tanstack/react-router';
import { type View, useViews } from './views.ts';

/**
 * THE resolver for "which saved view is active on this table". Reads `?view=<id>`
 * from the URL search (mirrors the house pattern in table-view.tsx), resolves it
 * against the table's view list, and falls back to the table's `isDefault` view,
 * then the first view. Sibling to invariant 18's table-resolution: this is the
 * current-VIEW where that is current-TABLE.
 */
export function useActiveView(
  wslug: string,
  pslug: string,
  tslug: string,
): {
  view: View | undefined;
  views: View[];
  isLoading: boolean;
} {
  const search = useSearch({ strict: false }) as { view?: string };
  const { data: views, isLoading } = useViews(wslug, pslug, tslug);
  const list = views ?? [];
  const active =
    (search.view ? list.find((v) => v.id === search.view) : undefined) ??
    list.find((v) => v.isDefault) ??
    list[0];
  return { view: active, views: list, isLoading };
}
