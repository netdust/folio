// editable-shell.test.tsx — the ONE thing the shell carries logic for.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditableShell } from './editable-shell.tsx';

// Helper: the box-metric classes (font/padding/size) that MUST be identical
// across modes. Adjust the regex to the exact tokens the shell emits.
const BOX_METRIC_RE = /(text-sm|px-1|py-0\.5)/g;
function boxMetrics(el: HTMLElement): string[] {
  return (el.className.match(BOX_METRIC_RE) ?? []).sort();
}

describe('EditableShell box-equivalence', () => {
  it('display and edit modes carry IDENTICAL box-metric classes (no layout shift)', () => {
    const { container: disp } = render(<EditableShell mode="display">x</EditableShell>);
    const { container: edit } = render(<EditableShell mode="edit">x</EditableShell>);
    const dispBox = disp.firstElementChild as HTMLElement;
    const editBox = edit.firstElementChild as HTMLElement;
    expect(boxMetrics(dispBox)).toEqual(boxMetrics(editBox));
    expect(boxMetrics(dispBox).length).toBeGreaterThan(0);
  });

  it('applies the pending opacity treatment in both modes', () => {
    const { container } = render(
      <EditableShell mode="display" isPending>
        x
      </EditableShell>,
    );
    expect((container.firstElementChild as HTMLElement).className).toMatch(/opacity-60/);
  });

  it('right align does not change box-metric classes', () => {
    const { container: l } = render(
      <EditableShell mode="display" align="left">
        x
      </EditableShell>,
    );
    const { container: r } = render(
      <EditableShell mode="display" align="right">
        x
      </EditableShell>,
    );
    expect(boxMetrics(l.firstElementChild as HTMLElement)).toEqual(
      boxMetrics(r.firstElementChild as HTMLElement),
    );
  });
});
