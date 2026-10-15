// Filters as shutters: the market used to be one card with three long rows of pills (≈30 controls
// at once). Groups collapse into accordion panels — one open at a time — and each head shows how
// many filters are active inside it, so a collapsed panel never hides an applied filter.
// The accordion itself is the same `.gt-shutter` block the Floodgrid uses (layout.css).
import { ChevronIcon } from '@/shared/ui/GridIcons';
import { Pill } from '@/shared/ui/primitives';

export function FilterShutter({
  title,
  count = 0,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="gt-shutter" data-open={open ? 'true' : 'false'}>
      <div className="gt-shutter-head">
        <button type="button" className="gt-shutter-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="strong">{title}</span>
            {count > 0 && <Pill active>{count}</Pill>}
          </span>
          <span className="gt-shutter-chev" aria-hidden><ChevronIcon size={18} /></span>
        </button>
      </div>
      <div className="gt-shutter-body">
        <div className="tabs" style={{ padding: '4px 12px 12px' }}>{children}</div>
      </div>
    </div>
  );
}
