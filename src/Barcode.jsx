import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

// Code 128 barcode of the voucher number, scannable by standard POS scanners
export default function Barcode({ value }) {
  const svg = useRef(null);
  useEffect(() => {
    if (!svg.current) return;
    try {
      JsBarcode(svg.current, value, {
        format: 'CODE128', height: 64, width: 2, margin: 12,
        displayValue: true, fontSize: 14, font: 'monospace',
        background: '#ffffff', lineColor: '#000000'
      });
    } catch {
      svg.current.innerHTML = '';
    }
  }, [value]);
  return (
    <div className="barcode">
      <svg ref={svg} role="img" aria-label={`Barcode for voucher ${value}`} />
    </div>
  );
}
