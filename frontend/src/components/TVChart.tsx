import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, ColorType, CrosshairMode, LineType, IChartApi, ISeriesApi } from 'lightweight-charts';

interface RangeTrigger {
  from?: string;
  to?: string;
  reset1Y?: boolean;
}

interface TVChartProps {
  data: any[];
  showPivots: boolean;
  showTargets: boolean;
  showVolume: boolean;
  showBreadth?: boolean;
  showBreakout?: boolean;
  showCorrelation?: boolean;
  rangeUpdateTrigger?: RangeTrigger | null;
  exportTrigger?: number;
  symbolName?: string;
}

const parseTime = (dateStr: string) => {
  if (typeof dateStr === 'string' && dateStr.includes('T')) {
    const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
    return Math.floor(d.getTime() / 1000) as any;
  }
  return dateStr;
};

const COLOR_PINK = 'rgb(255, 50, 150)';
const COLOR_BLUE = 'rgb(50, 50, 255)';
const SOLAR_BASE3 = '#fdf6e3';
const SOLAR_BASE01 = '#586e75';
const SOLAR_BASE1 = '#93a1a1';

export const TVChart: React.FC<TVChartProps> = (props) => {
  const { data, showPivots, showTargets, showVolume, showBreadth, showBreakout, showCorrelation } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Containers (Always persistent in DOM)
  const pRef = useRef<HTMLDivElement>(null);
  const vRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const boRef = useRef<HTMLDivElement>(null);
  const cRef = useRef<HTMLDivElement>(null);
  
  const charts = useRef<Record<string, IChartApi | null>>({});
  const [priceHeight, setPriceHeight] = useState(50); 
  const isDragging = useRef<boolean>(false);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      setPriceHeight(Math.max(20, Math.min(80, pct)));
    };
    const onMouseUp = () => { isDragging.current = false; document.body.style.cursor = 'default'; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, []);

  useEffect(() => {
    if (!pRef.current || data.length === 0) return;

    const sortedData = [...data].sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
    const times = sortedData.map(d => parseTime(d.Date));
    const ohlc = sortedData.map((d, i) => ({ time: times[i], open: Number(d.Open), high: Number(d.High), low: Number(d.Low), close: Number(d.Close) })).filter(d => !isNaN(d.open));

    const options = {
      layout: { background: { type: ColorType.Solid, color: SOLAR_BASE3 }, textColor: SOLAR_BASE01 },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: SOLAR_BASE1, timeVisible: true, rightOffset: 20, fixRightEdge: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    };

    // Init All 5 Charts on persistent refs
    const pc = createChart(pRef.current, options);
    const vc = createChart(vRef.current!, options);
    const bc = createChart(bRef.current!, options);
    const boc = createChart(boRef.current!, options);
    const cc = createChart(cRef.current!, options);
    charts.current = { price: pc, volume: vc, breadth: bc, breakout: boc, correlation: cc };

    const candleS = pc.addCandlestickSeries({ upColor: 'transparent', downColor: SOLAR_BASE01, borderVisible: true, borderUpColor: SOLAR_BASE01, borderDownColor: SOLAR_BASE01, wickUpColor: SOLAR_BASE01, wickDownColor: SOLAR_BASE01 });
    candleS.setData(ohlc);

    if (showPivots) {
      const rs = pc.addLineSeries({ color: 'transparent', priceLineVisible: false, crosshairMarkerVisible: false });
      const ss = pc.addLineSeries({ color: 'transparent', priceLineVisible: false, crosshairMarkerVisible: false });
      const rp: any[] = [], sp: any[] = [], rm: any[] = [], sm: any[] = [];
      sortedData.forEach((d, i) => {
        if (d.Resistance_Pivot != null && d.Is_Up_Rotation !== true) {
          rp.push({ time: times[i], value: Number(d.Resistance_Pivot) });
          rm.push({ time: times[i], position: 'inBar', color: COLOR_PINK, shape: 'circle', size: 0.1 });
        }
        if (d.Support_Pivot != null && d.Is_Down_Rotation !== true) {
          sp.push({ time: times[i], value: Number(d.Support_Pivot) });
          sm.push({ time: times[i], position: 'inBar', color: COLOR_BLUE, shape: 'circle', size: 0.1 });
        }
      });
      rs.setData(rp); rs.setMarkers(rm);
      ss.setData(sp); ss.setMarkers(sm);
    }

    if (showTargets) {
      const uT = sortedData.filter(d => d.Upper_Target != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Upper_Target) }));
      const lT = sortedData.filter(d => d.Lower_Target != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Lower_Target) }));
      if (uT.length) pc.addLineSeries({ color: COLOR_BLUE, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false }).setData(uT);
      if (lT.length) pc.addLineSeries({ color: COLOR_PINK, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false }).setData(lT);
    }

    vc.addHistogramSeries({ color: 'rgba(147, 161, 161, 0.5)', priceFormat: { type: 'volume' } }).setData(sortedData.filter(d => d.Volume != null).map((d, i) => ({ time: times[i], value: Number(d.Volume) })));
    bc.addLineSeries({ color: COLOR_BLUE, lineWidth: 2, title: 'Breadth %' }).setData(sortedData.filter(d => d.Uptrend_Pct != null).map((d, i) => ({ time: times[i], value: Number(d.Uptrend_Pct) * 100 })));
    boc.addLineSeries({ color: COLOR_PINK, lineWidth: 2, title: 'Breakout %' }).setData(sortedData.filter(d => d.Breakout_Pct != null).map((d, i) => ({ time: times[i], value: Number(d.Breakout_Pct) * 100 })));
    cc.addLineSeries({ color: SOLAR_BASE01, lineWidth: 2, title: 'Correlation %' }).setData(sortedData.filter(d => d.Correlation_Pct != null).map((d, i) => ({ time: times[i], value: Number(d.Correlation_Pct) * 100 })));

    const list = [pc, vc, bc, boc, cc];
    let syncing = false;
    list.forEach(c => {
      c.timeScale().subscribeVisibleLogicalRangeChange(r => { if (!syncing && r) { syncing = true; list.forEach(o => { if (o !== c) o.timeScale().setVisibleLogicalRange(r); }); syncing = false; } });
      c.subscribeCrosshairMove(p => { if (!syncing) { syncing = true; list.forEach(o => { if (o !== c) { if (!p.time) o.clearCrosshairPosition(); else o.setCrosshairPosition(0 as any, p.time as any, null as any); } }); syncing = false; } });
    });

    pc.timeScale().setVisibleLogicalRange({ from: ohlc.length - 253, to: ohlc.length + 19 });

    return () => list.forEach(c => c.remove());
  }, [data, showPivots, showTargets]);

  useEffect(() => {
    const resize = () => {
      Object.entries(charts.current).forEach(([id, chart]) => {
        const ref: any = { price: pRef, volume: vRef, breadth: bRef, breakout: boRef, correlation: cRef }[id];
        if (chart && ref.current) chart.applyOptions({ width: ref.current.clientWidth, height: ref.current.clientHeight });
      });
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [priceHeight, showVolume, showBreadth, showBreakout, showCorrelation]);

  const activeCount = [showVolume, showBreadth, showBreakout, showCorrelation].filter(Boolean).length;
  const indicatorFlex = activeCount > 0 ? (100 - priceHeight) / activeCount : 0;

  return (
    <div ref={containerRef} className="tv-chart-wrapper" style={{ display: 'flex', flexDirection: 'column' }}>
      <div ref={pRef} style={{ flex: `0 0 ${activeCount > 0 ? priceHeight : 100}%`, minHeight: '100px' }} />
      
      <div className="pane-resizer" onMouseDown={() => { isDragging.current = true; }} style={{ display: activeCount > 0 ? 'block' : 'none', height: '6px', cursor: 'ns-resize', background: SOLAR_BASE1, flexShrink: 0 }} />
      
      <div ref={vRef} style={{ display: showVolume ? 'block' : 'none', flex: `0 0 ${indicatorFlex}%`, minHeight: '50px' }} />
      <div ref={bRef} style={{ display: showBreadth ? 'block' : 'none', flex: `0 0 ${indicatorFlex}%`, minHeight: '50px', borderTop: showVolume ? `1px solid ${SOLAR_BASE1}` : 'none' }} />
      <div ref={boRef} style={{ display: showBreakout ? 'block' : 'none', flex: `0 0 ${indicatorFlex}%`, minHeight: '50px', borderTop: (showVolume || showBreadth) ? `1px solid ${SOLAR_BASE1}` : 'none' }} />
      <div ref={cRef} style={{ display: showCorrelation ? 'block' : 'none', flex: `0 0 ${indicatorFlex}%`, minHeight: '50px', borderTop: (showVolume || showBreadth || showBreakout) ? `1px solid ${SOLAR_BASE1}` : 'none' }} />
    </div>
  );
};
