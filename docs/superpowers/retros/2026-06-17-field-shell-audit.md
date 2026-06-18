# Field-shell sibling-site audit (Task 8 of the field-shell UX pass)

Swept every inline-editable surface after migrating the field layer onto `EditableShell`. Goal: no field-VALUE surface left hand-rolling its own box/font.

## Verdict: the inline-field-value layer is fully converged on `EditableShell`.

Every surface that renders a click-to-edit field VALUE routes through `InlineEdit`, `InlineSelect`, or `FieldRenderer` — all of which now render through the shell:
- `table/table-cell.tsx`, `table/table-add-row.tsx`, `views/list-row.tsx` — table/list cell values.
- `slideover/frontmatter-form.tsx`, `slideover/document-slideover.tsx`, `slideover/workspace-document-slideover.tsx` — slideover field values (via `FieldRenderer` + `InlineSelect`).

## Intentional exclusions (hand-rolled box, but NOT a field-value editor — documented, not migrated)

| Surface | File:line | Why excluded |
|---|---|---|
| ImageField edit input | `slideover/field-renderer.tsx:639` | Carries the `isSafeImageUrl` scheme guard; it's a thumbnail editor, not a text-value box. Migrating it risks the security guard for zero consistency gain. |
| RelationField search box | `slideover/field-renderer.tsx:268` | A document SEARCH input inside the relation picker popover — not an inline value cell. Already `text-sm` (font-consistent). |
| "Add field name" popover input | `slideover/frontmatter-form.tsx:437` | A field-CREATION form input, not editing an existing value. |
| Activity-log textarea | `slideover/log-activity-button.tsx:52`, `workspace-log-activity-button.tsx:58` | An explicit comment/log form, not a field value. |
| Provider/model select, mode-toggle | `inline/provider-model-field.tsx:148`, `slideover/mode-toggle.tsx:14` | Settings controls, not document field values. |

## `text-xs` remaining — all legitimate secondary text (not field values)
`inline-select.tsx:77` (option hint), `table-cell.tsx:89` ("no status" placeholder), error/alert text, picker key-hints, the groups-truncated footnote. None is an editable value.

## Net code change for Task 8: none.
The sweep is the deliverable — it confirms the convergence is complete and records the exclusions so a future reader knows they were decided, not missed. The convergence-point rule going forward: a new field sub-component that hand-rolls its own padding/font instead of consuming `EditableShell` is the bypass to flag in review.
