# Phase 1 — Manual QA scenarios

This file contains manual QA scenarios for Phase 1 of the Folio frontend.
Task 29 will populate the full scenario list (scenarios 1–7 and 9+).
Scenario 8 (the round-trip wedge) is authored here because it is the acceptance
gate for Task 19 and must exist before Task 29 lands.

---

### Scenario 8 (Phase 1 wedge): Round-trip

1. Use the fixture at `apps/server/src/__e2e__/fixtures/phase-1-frontend-roundtrip.md` — either paste it into a new work item created via curl (POST text/markdown body), or copy the body section into an existing item.
2. Open the work item slideover.
3. Verify Milkdown renders the table, the task list (with the second item checked), and the code fence as a code block (the inner `---` block is NOT interpreted as YAML).
4. Toggle to Raw MD. Verify the body is byte-for-byte the fixture (frontmatter is NOT shown — it lives in the form above).
5. Edit a line in raw mode. Wait 1 second for debounce.
6. Toggle back to Edit. Confirm Milkdown reflects the edit.
7. Reload the page. Confirm both the rich and raw views show the edited body. Confirm the frontmatter form still shows the original `priority`, `due_date`, `labels`, `estimate`, `agent`, `metadata` (including the nested object).
8. Right-click the row in the list view → Copy as Markdown (after Task 27 lands; otherwise skip). Paste into a text editor — confirm byte-equality with what raw mode shows plus the frontmatter block.
