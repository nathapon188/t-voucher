import { useEffect, useRef, useState } from 'react';

// Always-visible scroll bar for touch devices, where browsers only flash an overlay
// scrollbar while scrolling. Mirrors the scroll position of `target` and can be dragged.
export default function ScrollRail({ target, inline = false }) {
  const rail = useRef(null);
  const drag = useRef(null);
  const [m, setM] = useState({ show: false, top: 0, size: 0 });

  const metrics = () => {
    const el = target.current;
    const trackH = rail.current?.clientHeight || el.clientHeight;
    const size = Math.max(44, (trackH * el.clientHeight) / el.scrollHeight);
    return { el, trackH, size, max: el.scrollHeight - el.clientHeight };
  };

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const { trackH, size, max } = metrics();
        setM({ show: max > 1, size, top: max > 0 ? ((trackH - size) * el.scrollTop) / max : 0 });
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const watchChildren = () => [...el.children].forEach(c => ro.observe(c));
    watchChildren();
    // Rows are added and removed as vouchers load or the search changes
    const mo = new MutationObserver(() => { watchChildren(); update(); });
    mo.observe(el, { childList: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [target]);

  const onThumbDown = e => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, scroll: target.current.scrollTop };
  };
  const onThumbMove = e => {
    if (!drag.current) return;
    const { el, trackH, size, max } = metrics();
    el.scrollTop = drag.current.scroll + ((e.clientY - drag.current.y) * max) / Math.max(1, trackH - size);
  };
  const onThumbUp = () => { drag.current = null; };

  // Tapping the track jumps so the thumb centres on the tap
  const onRailDown = e => {
    const { el, trackH, size, max } = metrics();
    const y = e.clientY - rail.current.getBoundingClientRect().top - size / 2;
    el.scrollTo({ top: (y / Math.max(1, trackH - size)) * max, behavior: 'smooth' });
  };

  return (
    <div ref={rail} className={`scroll-rail ${inline ? 'inline' : ''} ${m.show ? '' : 'off'}`} onPointerDown={onRailDown} aria-hidden="true">
      <div
        className="scroll-rail-thumb"
        style={{ height: m.size, transform: `translateY(${m.top}px)` }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
      />
    </div>
  );
}
