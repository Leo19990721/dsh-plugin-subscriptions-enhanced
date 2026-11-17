// Local hooks replace two private UI exports removed in DSH 0.2.2.
function enhancedAnchoredPosition({ open, anchorRef, panelRef, gap = 8, margin = 12 }) {
  const [position, setPosition] = react.useState(null);
  react.useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const measure = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const left = Math.max(margin, Math.min(a.left, window.innerWidth - p.width - margin));
      const top = Math.max(margin, Math.min(a.top - p.height - gap, window.innerHeight - p.height - margin));
      setPosition(old => old?.left === left && old?.top === top ? old : { left, top, visibility: 'visible' });
    };
    measure();
    const resize = new ResizeObserver(measure);
    if (panelRef.current) resize.observe(panelRef.current);
    if (anchorRef.current) resize.observe(anchorRef.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { resize.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open, anchorRef, panelRef, gap, margin]);
  return position;
}

function enhancedDismissOutside(anchorRef, open, setOpen, panelRef) {
  react.useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!anchorRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [open, anchorRef, panelRef, setOpen]);
}
