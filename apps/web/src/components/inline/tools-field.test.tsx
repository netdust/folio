import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolsField } from './tools-field.tsx';

/**
 * Wrap ToolsField in a stateful host so successive clicks see the updated
 * `value` prop — same pattern users will see in the real FrontmatterForm.
 */
function Host({
  initial,
  onChange,
}: {
  initial: string[];
  onChange?: (next: string[]) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ToolsField
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('ToolsField', () => {
  it('renders "No tools" chip when value is empty', () => {
    render(<ToolsField value={[]} onChange={() => {}} />);
    expect(screen.getByText('No tools')).toBeInTheDocument();
  });

  it('renders one chip per selected tool', () => {
    render(
      <ToolsField
        value={['list_documents', 'create_document']}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('list_documents')).toBeInTheDocument();
    expect(screen.getByText('create_document')).toBeInTheDocument();
  });

  it('checking a tool appends it via onChange', async () => {
    const onChange = vi.fn();
    render(<ToolsField value={[]} onChange={onChange} />);
    await userEvent.click(screen.getByText('No tools')); // open
    await userEvent.click(screen.getByRole('checkbox', { name: 'list_documents' }));
    expect(onChange).toHaveBeenLastCalledWith(['list_documents']);
  });

  it('unchecking a tool removes it via onChange', async () => {
    const onChange = vi.fn();
    render(<ToolsField value={['list_documents', 'create_document']} onChange={onChange} />);
    await userEvent.click(screen.getByText('list_documents')); // open
    await userEvent.click(screen.getByRole('checkbox', { name: 'list_documents' }));
    expect(onChange).toHaveBeenLastCalledWith(['create_document']);
  });

  it('persists in MCP_TOOL_GROUPS order regardless of click sequence', async () => {
    const onChange = vi.fn();
    render(<Host initial={[]} onChange={onChange} />);
    await userEvent.click(screen.getByText('No tools'));
    // Click in reverse-of-defined order: delete_document then list_documents.
    await userEvent.click(screen.getByRole('checkbox', { name: 'delete_document' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'list_documents' }));
    // Final call: list_documents (Read group) comes before delete_document (Delete group).
    expect(onChange).toHaveBeenLastCalledWith(['list_documents', 'delete_document']);
  });

  it('groups tools by Read / Write / Delete', async () => {
    render(<ToolsField value={[]} onChange={() => {}} />);
    await userEvent.click(screen.getByText('No tools'));
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Write')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });
});
