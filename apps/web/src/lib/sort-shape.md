# Sort shape

The work-items URL stores sort as a flat pair: `?sort=<key>&dir=<asc|desc>`.
The View record stores sort as `Array<{key, dir}>`.

v1 supports SINGLE-COLUMN sort only — these two shapes carry the same info.
URL stays flat for human readability + simple bookmarking; view stays array
so multi-column sort lands as a non-breaking add. Reconciliation:
- URL → view: wrap `{key, dir}` in a single-element array.
- View → URL: take `array[0]` (Task 7's hydration effect).

TODO (post-v1): support multiple sort entries via repeated query params
like `?sort=title&dir=asc&sort=updated_at&dir=desc`. Probably do that after
real demand surfaces.
