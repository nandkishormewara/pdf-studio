import { describe, expect, it } from 'vitest';
import { resolveWatermark, watermarkPlacement } from '../../../web/src/sdk/watermark';

describe('watermark', () => {
  it('uses the WebViewer-style defaults for a plain string', () => {
    expect(resolveWatermark('Jane Doe · 2401001')).toEqual({ text: 'Jane Doe · 2401001', color: '#ff0000', opacity: 0.22, fontSize: 22 });
  });

  it('keeps valid options and repairs invalid ones', () => {
    expect(resolveWatermark({ text: ' A ', color: '#00ff00', opacity: 0.5, fontSize: 30 })).toEqual({ text: 'A', color: '#00ff00', opacity: 0.5, fontSize: 30 });
    expect(resolveWatermark({ text: 'A', color: 'red" onload="x', opacity: 7, fontSize: -1 })).toEqual({ text: 'A', color: '#ff0000', opacity: 1, fontSize: 22 });
  });

  it('draws nothing without text', () => {
    expect(resolveWatermark('')).toBeNull();
    expect(resolveWatermark('   ')).toBeNull();
    expect(resolveWatermark(null)).toBeNull();
    expect(resolveWatermark({ text: '' })).toBeNull();
  });

  it('runs along the page diagonal through the centre', () => {
    const p = watermarkPlacement(612, 792);
    expect(p.cx).toBe(306);
    expect(p.cy).toBe(396);
    expect(p.angle).toBeCloseTo((Math.atan2(792, 612) * 180) / Math.PI, 6);
    expect(watermarkPlacement(100, 100).angle).toBeCloseTo(45, 6);
  });
});
