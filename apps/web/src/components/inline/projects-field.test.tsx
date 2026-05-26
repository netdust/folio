import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectsField } from './projects-field.tsx';

const projects = [
  { id: 'p-a', name: 'Project A' },
  { id: 'p-b', name: 'Project B' },
  { id: 'p-c', name: 'Project C' },
];

describe('ProjectsField', () => {
  it('renders "All projects" chip when value is ["*"]', () => {
    render(<ProjectsField value={['*']} projects={projects} onChange={() => {}} />);
    expect(screen.getByText('All projects')).toBeInTheDocument();
    expect(screen.queryByText('Project A')).not.toBeInTheDocument();
  });

  it('renders one chip per explicit id (current-slug lookup)', () => {
    render(<ProjectsField value={['p-a', 'p-c']} projects={projects} onChange={() => {}} />);
    expect(screen.getByText('Project A')).toBeInTheDocument();
    expect(screen.getByText('Project C')).toBeInTheDocument();
    expect(screen.queryByText('Project B')).not.toBeInTheDocument();
  });

  it('renders a muted "·removed" chip for orphan ids', () => {
    render(
      <ProjectsField value={['deadbeef-id-no-longer-exists']} projects={projects} onChange={() => {}} />,
    );
    expect(screen.getByText(/·removed/)).toBeInTheDocument();
  });

  it('renders an empty-state chip when value is []', () => {
    render(<ProjectsField value={[]} projects={projects} onChange={() => {}} />);
    expect(screen.getByText('No projects')).toBeInTheDocument();
  });

  it('toggling Select all from a partial list replaces value with ["*"]', async () => {
    const onChange = vi.fn();
    render(<ProjectsField value={['p-a']} projects={projects} onChange={onChange} />);
    await userEvent.click(screen.getByText('Project A')); // open popover
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(onChange).toHaveBeenLastCalledWith(['*']);
  });

  it('unchecking a project when Select all is on collapses to the explicit list minus that id', async () => {
    const onChange = vi.fn();
    render(<ProjectsField value={['*']} projects={projects} onChange={onChange} />);
    await userEvent.click(screen.getByText('All projects')); // open
    await userEvent.click(screen.getByRole('checkbox', { name: 'Project B' }));
    // Atomic transition: ['*'] → ['p-a', 'p-c'] (B filtered out).
    expect(onChange).toHaveBeenLastCalledWith(['p-a', 'p-c']);
  });

  it('toggling Select all off from ["*"] collapses to []', async () => {
    const onChange = vi.fn();
    render(<ProjectsField value={['*']} projects={projects} onChange={onChange} />);
    await userEvent.click(screen.getByText('All projects')); // open
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('checking a project from [] appends it', async () => {
    const onChange = vi.fn();
    render(<ProjectsField value={[]} projects={projects} onChange={onChange} />);
    await userEvent.click(screen.getByText('No projects')); // open
    await userEvent.click(screen.getByRole('checkbox', { name: 'Project A' }));
    expect(onChange).toHaveBeenLastCalledWith(['p-a']);
  });
});
