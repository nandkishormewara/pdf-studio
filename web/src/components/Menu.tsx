import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const ITEMS = '[role^="menuitem"]:not(:disabled)';

/**
 * Small dropdown menu that closes on outside click / Escape.
 * Keyboard (WAI-ARIA menu button): opening focuses the first item, ↑ ↓ Home End move,
 * Escape closes and returns focus to the button, Tab closes.
 */
export function Menu({ label, title, children, disabled }: { label: ReactNode; title: string; children: (close: () => void) => ReactNode; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') { setOpen(false); return; }
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = ({ ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // keep page navigation keys away from the viewer
    items[(next + items.length) % items.length].focus();
  };

  return (
    <div className="menu" ref={ref}>
      <button ref={trigger} className={`menu-trigger ${open ? 'on' : ''}`} title={title} aria-haspopup="menu" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        {label}
      </button>
      {open && (
        <div className="menu-panel" role="menu" ref={panel} onKeyDown={onPanelKey}>
          {children(() => { setOpen(false); trigger.current?.focus(); })}
        </div>
      )}
    </div>
  );
}
