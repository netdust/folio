import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FieldRenderer } from './field-renderer.tsx';

describe('FieldRenderer', () => {
  it('renders a string input for string type', async () => {
    const onCommit = vi.fn();
    render(<FieldRenderer fieldKey="title" type="string" value="hello" onCommit={onCommit} />);
    await userEvent.click(screen.getByText('hello'));
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'world{Enter}');
    expect(onCommit).toHaveBeenCalledWith('world');
  });

  it('renders a number input for number type and commits a number, not a string', async () => {
    const onCommit = vi.fn();
    render(<FieldRenderer fieldKey="estimate" type="number" value={3} onCommit={onCommit} />);
    // Number now has a display state (parity with other fields): click the shown
    // value to enter edit, then the spinbutton input appears.
    await userEvent.click(screen.getByText('3'));
    const input = screen.getByRole('spinbutton');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith(5);
  });

  it('renders a checkbox for boolean type', async () => {
    const onCommit = vi.fn();
    render(<FieldRenderer fieldKey="urgent" type="boolean" value={false} onCommit={onCommit} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('renders a date input for date type', async () => {
    const onCommit = vi.fn();
    render(<FieldRenderer fieldKey="due" type="date" value="2026-06-01" onCommit={onCommit} />);
    await userEvent.click(screen.getByText('2026-06-01'));
    const input = screen.getByDisplayValue('2026-06-01');
    await userEvent.clear(input);
    await userEvent.type(input, '2026-07-15');
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith('2026-07-15');
  });

  it('renders a select popover for select type', async () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer
        fieldKey="priority"
        type="select"
        value="medium"
        options={['low', 'medium', 'high']}
        onCommit={onCommit}
      />,
    );
    await userEvent.click(screen.getByText('medium'));
    await userEvent.click(await screen.findByRole('option', { name: 'high' }));
    expect(onCommit).toHaveBeenCalledWith('high');
  });

  it('renders multi-select as chip list with add/remove', async () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer
        fieldKey="labels"
        type="multi_select"
        value={['bug', 'urgent']}
        options={['bug', 'urgent', 'low-priority']}
        onCommit={onCommit}
      />,
    );
    // Click the X on "urgent"
    await userEvent.click(screen.getByRole('button', { name: /Remove urgent/ }));
    expect(onCommit).toHaveBeenLastCalledWith(['bug']);
  });

  it('renders url as a link in display mode and editable input on click', async () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer fieldKey="docs" type="url" value="https://example.com" onCommit={onCommit} />,
    );
    expect(screen.getByRole('link', { name: 'https://example.com' })).toBeInTheDocument();
  });

  describe('image field', () => {
    it('renders an <img> preview for a valid https URL', () => {
      const onCommit = vi.fn();
      render(
        <FieldRenderer fieldKey="cover" type="image" value="https://x/i.png" onCommit={onCommit} />,
      );
      expect(screen.getByRole('img')).toHaveAttribute('src', 'https://x/i.png');
    });

    it('does NOT commit a javascript: URL typed into the editor (scheme guard)', async () => {
      const onCommit = vi.fn();
      render(<FieldRenderer fieldKey="cover" type="image" value="" onCommit={onCommit} />);
      // Empty value renders the "(no image)" affordance — click it to edit.
      await userEvent.click(screen.getByText('(no image)'));
      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'javascript:alert(1)');
      await userEvent.tab();
      expect(onCommit).not.toHaveBeenCalledWith('javascript:alert(1)');
    });

    it('does NOT commit a data: URL typed into the editor (scheme guard)', async () => {
      const onCommit = vi.fn();
      render(<FieldRenderer fieldKey="cover" type="image" value="" onCommit={onCommit} />);
      await userEvent.click(screen.getByText('(no image)'));
      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'data:text/html,<script>alert(1)</script>');
      await userEvent.tab();
      expect(onCommit).not.toHaveBeenCalledWith('data:text/html,<script>alert(1)</script>');
    });

    it('does NOT render an <img> for an unsafe stored value', () => {
      const onCommit = vi.fn();
      render(
        <FieldRenderer
          fieldKey="cover"
          type="image"
          value="javascript:alert(1)"
          onCommit={onCommit}
        />,
      );
      expect(screen.queryByRole('img')).toBeNull();
    });

    it('renders the "(no image)" affordance for an empty value', () => {
      const onCommit = vi.fn();
      render(<FieldRenderer fieldKey="cover" type="image" value="" onCommit={onCommit} />);
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByText('(no image)')).toBeInTheDocument();
    });

    it('commits a valid https image URL typed into the editor', async () => {
      const onCommit = vi.fn();
      render(<FieldRenderer fieldKey="cover" type="image" value="" onCommit={onCommit} />);
      await userEvent.click(screen.getByText('(no image)'));
      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'https://cdn/photo.jpg');
      await userEvent.tab();
      expect(onCommit).toHaveBeenCalledWith('https://cdn/photo.jpg');
    });

    it('allows clearing the field (empty commit is permitted)', async () => {
      const onCommit = vi.fn();
      render(
        <FieldRenderer
          fieldKey="cover"
          type="image"
          value="https://cdn/photo.jpg"
          onCommit={onCommit}
        />,
      );
      await userEvent.click(screen.getByRole('img'));
      const input = screen.getByRole('textbox');
      await userEvent.clear(input);
      await userEvent.tab();
      expect(onCommit).toHaveBeenCalledWith('');
    });
  });

  it('renders relation as read-only chips when no candidates are provided (table path)', () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer
        fieldKey="owner"
        type="relation"
        value={['[[people-ada]]', '[[ghost]]']}
        options={['table:tbl_1', 'multi']}
        onCommit={onCommit}
        resolveSlug={(slug) => (slug === 'people-ada' ? { slug, title: 'Ada' } : null)}
      />,
    );
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('[[ghost]]')).toHaveClass('line-through');
    // No add affordance on the table path.
    expect(screen.queryByRole('button', { name: /add link/i })).toBeNull();
  });

  it('renders an add affordance when candidates are provided (slideover path)', () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer
        fieldKey="owner"
        type="relation"
        value={['[[people-ada]]']}
        options={['table:tbl_1', 'multi']}
        onCommit={onCommit}
        relationCandidates={[
          { id: 'a', slug: 'people-ada', title: 'Ada' },
          { id: 'b', slug: 'people-bob', title: 'Bob' },
        ]}
        resolveSlug={(slug) => (slug === 'people-ada' ? { slug, title: 'Ada' } : null)}
      />,
    );
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add link/i })).toBeInTheDocument();
  });
});
