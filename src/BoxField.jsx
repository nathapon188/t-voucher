import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

const TILE_W = 64, TILE_H = 32, BASE = 8;
const MAX_LIFT = 70, RADIUS = 170;

// Teal at rest, blending to gold as boxes rise (gift voucher theme)
const REST = { top: [16, 74, 72], left: [9, 50, 49], right: [5, 35, 35] };
const LIFT = { top: [240, 205, 115], left: [176, 136, 52], right: [124, 92, 30] };
const mix = (a, b, k) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;

// Full-screen isometric box grid. Boxes rise near the pointer; ripple(x, y) sends a wave out.
const BoxField = forwardRef(function BoxField(_props, ref) {
  const canvasRef = useRef(null);
  const ripples = useRef([]);

  useImperativeHandle(ref, () => ({
    ripple(x, y, amp = 50) {
      ripples.current.push({ x, y, amp, t0: performance.now() / 1000 });
    }
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, active: false };
    let W, H, tiles = [], raf;

    function build() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tiles = [];
      const rows = Math.ceil(H / (TILE_H / 2)) + 6;
      const cols = Math.ceil(W / TILE_W) + 2;
      for (let r = -2; r < rows; r++)
        for (let c = -1; c < cols; c++)
          tiles.push({ x: c * TILE_W + (r & 1 ? TILE_W / 2 : 0), y: (r * TILE_H) / 2, h: 0, seed: Math.random() * 6.28 });
    }

    function poly(pts, fill) {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    function frame(now) {
      const t = now / 1000;
      mouse.x += (mouse.tx - mouse.x) * 0.18;
      mouse.y += (mouse.ty - mouse.y) * 0.18;
      const rs = ripples.current;
      for (let i = rs.length - 1; i >= 0; i--) if (t - rs[i].t0 > 3) rs.splice(i, 1);

      ctx.clearRect(0, 0, W, H);
      const hw = TILE_W / 2, hh = TILE_H / 2;

      for (const tile of tiles) {
        const dx = tile.x - mouse.x, dy = (tile.y - mouse.y) * 2;
        const d2 = dx * dx + dy * dy;
        let target = mouse.active ? MAX_LIFT * Math.exp(-d2 / ((2 * RADIUS * RADIUS) / 2.2)) : 0;
        if (!reduceMotion) target += 3 + 3 * Math.sin(t * 1.2 + tile.x * 0.012 + tile.y * 0.025 + tile.seed * 0.3);
        for (const rp of rs) {
          const rx = tile.x - rp.x, ry = (tile.y - rp.y) * 2;
          const age = t - rp.t0;
          const band = Math.sqrt(rx * rx + ry * ry) - age * 650;
          target += rp.amp * Math.exp(-(band * band) / (2 * 45 * 45)) * Math.max(0, 1 - age / 3);
        }
        tile.h += (target - tile.h) * 0.12;

        const { x, y, h } = tile;
        if (x < -TILE_W || x > W + TILE_W || y - h < -TILE_H * 2 || y - h > H + TILE_H) continue;

        const k = Math.min(1, h / MAX_LIFT);
        const ty = y - h;
        poly([x - hw, ty, x, ty + hh, x, y + hh + BASE, x - hw, y + BASE], mix(REST.left, LIFT.left, k));
        poly([x + hw, ty, x, ty + hh, x, y + hh + BASE, x + hw, y + BASE], mix(REST.right, LIFT.right, k));
        poly([x, ty - hh, x + hw, ty, x, ty + hh, x - hw, ty], mix(REST.top, LIFT.top, k));
        ctx.strokeStyle = `rgba(243,217,139,${0.08 + k * 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - hw, ty); ctx.lineTo(x, ty - hh); ctx.lineTo(x + hw, ty);
        ctx.stroke();
      }
      raf = requestAnimationFrame(frame);
    }

    const onMove = e => {
      mouse.tx = e.clientX; mouse.ty = e.clientY;
      if (!mouse.active) { mouse.x = e.clientX; mouse.y = e.clientY; }
      mouse.active = true;
    };
    const onLeave = () => { mouse.active = false; };
    const onDown = e => {
      if (e.target.closest('.card')) return;
      ripples.current.push({ x: e.clientX, y: e.clientY, amp: 40, t0: performance.now() / 1000 });
    };

    build();
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', build);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', build);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="field" />;
});

export default BoxField;
