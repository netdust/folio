import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { Icon } from './icon.tsx';

describe('Icon', () => {
  it('renders the passed lucide-react icon', () => {
    const { container } = render(<Icon icon={Inbox} label="Inbox" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-label')).toBe('Inbox');
  });

  it('sets stroke-width to 1.5', () => {
    const { container } = render(<Icon icon={Inbox} label="Inbox" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
  });

  it('without label, sets aria-hidden=true', () => {
    const { container } = render(<Icon icon={Inbox} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('aria-label')).toBeNull();
  });
});
