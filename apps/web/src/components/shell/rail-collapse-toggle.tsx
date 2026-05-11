import { useRailCollapsed } from './rail.tsx';
import { Button } from '../ui/button.tsx';

export function RailCollapseToggle() {
  const [collapsed, setCollapsed] = useRailCollapsed();
  return (
    <Button variant="secondary" size="sm" onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? 'Expand rail' : 'Collapse rail'}
    </Button>
  );
}
