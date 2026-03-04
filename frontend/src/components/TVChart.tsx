import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CrosshairMode, LineType, IChartApi, ISeriesApi } from 'lightweight-charts';

interface RangeTrigger {
  from?: string;
  to?: string;
  reset1Y?: boolean;
}

interface TVChartProps {
  data: any[];
  liveUpdate?: any;
  showPivots: boolean;
  showTargets: boolean;
  showVolume: boolean;
  showBreadth?: boolean;
  showBreakout?: boolean;
  showCorrelation?: boolean;
  rangeUpdateTrigger?: RangeTrigger | null;
  exportTrigger?: number;
  symbolName?: string;
  layoutHeight?: number;
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

type PaneId = 'volume' | 'breadth' | 'breakout' | 'correlation';

const DEFAULT_PANE_HEIGHT = 80;
const MIN_PANE_HEIGHT = 40;

export const TVChart: React.FC<TVChartProps> = (props) => {
  const { data, showPivots, showTargets, showVolume, showBreadth, showBreakout, showCorrelation } = props;

  const pRef  = useRef<HTMLDivElement>(null);
  const vRef  = useRef<HTMLDivElement>(null);
  const bRef  = useRef<HTMLDivElement>(null);
  const boRef = useRef<HTMLDivElement>(null);
  const cRef  = useRef<HTMLDivElement>(null);

  const charts = useRef<Record<string, IChartApi | null>>({});
  const seriesRefs = useRef<Record<string, ISeriesApi<any> | null>>({});
  const dataLengthRef = useRef(0);
  const timesRef = useRef<any[]>([]);

  const [paneHeights, setPaneHeights] = useState<Record<PaneId, number>>({
    volume:      DEFAULT_PANE_HEIGHT,
    breadth:     DEFAULT_PANE_HEIGHT,
    breakout:    DEFAULT_PANE_HEIGHT,
    correlation: DEFAULT_PANE_HEIGHT,
  });

  const wrapperRef = useRef<HTMLDivElement>(null);
  const prevWrapperHeightRef = useRef<number | null>(null);

  // dragging state: track which resizer is being dragged
  const dragging = useRef<{
    isTopResizer: boolean;   // true = resizer between price and first indicator
    topId: PaneId;           // pane above the resizer (for between-indicator case) or pane below (for top resizer)
    bottomId?: PaneId;       // pane below the resizer (between-indicator case only)
    startY: number;
    startHeights: Record<PaneId, number>;
  } | null>(null);

  // Global mouse event handlers for dragging
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const { isTopResizer, topId, bottomId, startY, startHeights } = dragging.current;
      const deltaY = e.clientY - startY;

      setPaneHeights(prev => {
        const next = { ...prev };
        if (isTopResizer) {
          // Resizer between price pane and first indicator:
          // drag down => indicator shrinks (price grows via flex:1)
          // drag up   => indicator grows  (price shrinks via flex:1)
          next[topId] = Math.max(MIN_PANE_HEIGHT, startHeights[topId] - deltaY);
        } else if (bottomId) {
          // Resizer between two indicator panes:
          // drag down => top grows, bottom shrinks (total unchanged)
          const total = startHeights[topId] + startHeights[bottomId];
          const newTop = Math.max(MIN_PANE_HEIGHT, Math.min(total - MIN_PANE_HEIGHT, startHeights[topId] + deltaY));
          next[topId]    = newTop;
          next[bottomId] = Math.max(MIN_PANE_HEIGHT, total - newTop);
        }
        return next;
      });
    };

    const onMouseUp = () => {
      dragging.current = null;
      document.body.style.cursor = 'default';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Proportional scaling of indicator panes when the wrapper height changes
  useEffect(() => {
    const newH = wrapperRef.current?.clientHeight;
    if (!newH) return;
    const prevH = prevWrapperHeightRef.current;
    if (prevH && prevH !== newH) {
      const scale = newH / prevH;
      setPaneHeights(prev => {
        const next = { ...prev };
        for (const key of Object.keys(next) as PaneId[]) {
          next[key] = Math.max(MIN_PANE_HEIGHT, next[key] * scale);
        }
        return next;
      });
    }
    prevWrapperHeightRef.current = newH;
  }, [props.layoutHeight]);

  // Chart creation — runs when data/pivots/targets change
  useEffect(() => {
    if (!pRef.current || data.length === 0) return;

    const sortedData = [...data].sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
    const times = sortedData.map(d => parseTime(d.Date));
    const ohlc = sortedData
      .map((d, i) => ({ time: times[i], open: Number(d.Open), high: Number(d.High), low: Number(d.Low), close: Number(d.Close) }))
      .filter(d => !isNaN(d.open));

    dataLengthRef.current = ohlc.length;
    timesRef.current = times;

    const PRICE_SCALE_WIDTH = 70;
    const chartOptions = {
      layout: { background: { type: ColorType.Solid, color: SOLAR_BASE3 }, textColor: SOLAR_BASE01 },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { minimumWidth: PRICE_SCALE_WIDTH },
      timeScale: { borderColor: SOLAR_BASE1, timeVisible: true, rightOffset: 20, fixRightEdge: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    };

    const pc  = createChart(pRef.current,  chartOptions);
    const vc  = createChart(vRef.current!,  chartOptions);
    const bc  = createChart(bRef.current!,  chartOptions);
    const boc = createChart(boRef.current!, chartOptions);
    const cc  = createChart(cRef.current!,  chartOptions);
    charts.current = { price: pc, volume: vc, breadth: bc, breakout: boc, correlation: cc };

    // Price pane
    const candleS = pc.addCandlestickSeries({
      upColor: 'transparent', downColor: SOLAR_BASE01,
      borderVisible: true,
      borderUpColor: SOLAR_BASE01, borderDownColor: SOLAR_BASE01,
      wickUpColor: SOLAR_BASE01, wickDownColor: SOLAR_BASE01,
    });
    candleS.setData(ohlc);
    seriesRefs.current.price = candleS;

    if (showPivots) {
      const rs = pc.addLineSeries({ color: 'transparent', priceLineVisible: false, crosshairMarkerVisible: false });
      const ss = pc.addLineSeries({ color: 'transparent', priceLineVisible: false, crosshairMarkerVisible: false });
      const rp: any[] = [], sp: any[] = [], rm: any[] = [], sm: any[] = [];
      sortedData.forEach((d, i) => {
        if (d.Resistance_Pivot != null && !d.Trend) {
          rp.push({ time: times[i], value: Number(d.Resistance_Pivot) });
          rm.push({ time: times[i], position: 'inBar', color: COLOR_PINK, shape: 'circle', size: 0.1 });
        }
        if (d.Support_Pivot != null && d.Trend) {
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
      if (uT.length) pc.addLineSeries({ color: COLOR_BLUE, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false, crosshairMarkerVisible: false }).setData(uT);
      if (lT.length) pc.addLineSeries({ color: COLOR_PINK, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false, crosshairMarkerVisible: false }).setData(lT);
    }

    // Indicator panes — same pattern as volume for all
    const volSeries = vc.addHistogramSeries({ color: 'rgba(147, 161, 161, 0.5)', priceFormat: { type: 'volume' } });
    volSeries.setData(sortedData.filter(d => d.Volume != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Volume) })));
    seriesRefs.current.volume = volSeries;

    const breadthSeries = bc.addLineSeries({ color: COLOR_BLUE, lineWidth: 2, title: 'Breadth %' });
    breadthSeries.setData(sortedData.filter(d => d.Uptrend_Pct != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Uptrend_Pct) })));
    seriesRefs.current.breadth = breadthSeries;

    const breakoutSeries = boc.addLineSeries({ color: COLOR_PINK, lineWidth: 2, title: 'Breakout %' });
    breakoutSeries.setData(sortedData.filter(d => d.Breakout_Pct != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Breakout_Pct) })));
    seriesRefs.current.breakout = breakoutSeries;

    const corrSeries = cc.addLineSeries({ color: SOLAR_BASE01, lineWidth: 2, title: 'Correlation %' });
    corrSeries.setData(sortedData.filter(d => d.Correlation_Pct != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Correlation_Pct) * 100 })));
    seriesRefs.current.correlation = corrSeries;

    // Invisible alignment series: gives every indicator chart the full price-chart time scale
    // so setVisibleRange works even when the indicator has no (or fewer) data points.
    const alignData = ohlc.map(d => ({ time: d.time, value: d.close }));
    [vc, bc, boc, cc].forEach(ic => {
      ic.addLineSeries({ color: 'rgba(0,0,0,0)', priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, priceScaleId: '__align__' })
        .setData(alignData);
      ic.priceScale('__align__').applyOptions({ visible: false });
    });

    // Build time→value lookup maps for crosshair sync
    const seriesDataMaps: Record<string, Map<any, number>> = {};
    // Price: use close
    const priceMap = new Map<any, number>();
    ohlc.forEach(d => priceMap.set(d.time, d.close));
    seriesDataMaps['price'] = priceMap;
    // Volume
    const volMap = new Map<any, number>();
    sortedData.forEach((d, i) => { if (d.Volume != null) volMap.set(times[i], Number(d.Volume)); });
    seriesDataMaps['volume'] = volMap;
    // Breadth
    const breadthMap = new Map<any, number>();
    sortedData.forEach((d, i) => { if (d.Uptrend_Pct != null) breadthMap.set(times[i], Number(d.Uptrend_Pct)); });
    seriesDataMaps['breadth'] = breadthMap;
    // Breakout
    const breakoutMap = new Map<any, number>();
    sortedData.forEach((d, i) => { if (d.Breakout_Pct != null) breakoutMap.set(times[i], Number(d.Breakout_Pct)); });
    seriesDataMaps['breakout'] = breakoutMap;
    // Correlation
    const corrMap = new Map<any, number>();
    sortedData.forEach((d, i) => { if (d.Correlation_Pct != null) corrMap.set(times[i], Number(d.Correlation_Pct) * 100); });
    seriesDataMaps['correlation'] = corrMap;

    // Sync time scales and crosshairs across all charts
    const chartEntries: [string, IChartApi][] = [
      ['price', pc], ['volume', vc], ['breadth', bc], ['breakout', boc], ['correlation', cc],
    ];
    let rangeSyncing = false;
    let crosshairSyncing = false;
    chartEntries.forEach(([, source]) => {
      source.timeScale().subscribeVisibleLogicalRangeChange(r => {
        if (rangeSyncing || !r) return;
        rangeSyncing = true;
        chartEntries.forEach(([, target]) => { if (target !== source) target.timeScale().setVisibleLogicalRange(r); });
        rangeSyncing = false;
      });
      source.subscribeCrosshairMove(p => {
        if (crosshairSyncing) return;
        crosshairSyncing = true;
        chartEntries.forEach(([otherId, target]) => {
          if (target !== source) {
            const s = seriesRefs.current[otherId];
            if (!s) return;
            if (!p.time) {
              target.clearCrosshairPosition();
            } else {
              const val = seriesDataMaps[otherId]?.get(p.time);
              if (val !== undefined) {
                target.setCrosshairPosition(val, p.time as any, s);
              }
            }
          }
        });
        crosshairSyncing = false;
      });
    });

    const initRange = { from: ohlc.length - 252, to: ohlc.length + 20 };
    chartEntries.forEach(([, c]) => c.timeScale().setVisibleLogicalRange(initRange));

    return () => chartEntries.forEach(([, c]) => c.remove());
  }, [data, showPivots, showTargets]);

  // Resize charts whenever pane heights or visibility changes
  useEffect(() => {
    const refMap: Record<string, React.RefObject<HTMLDivElement>> = {
      price: pRef, volume: vRef, breadth: bRef, breakout: boRef, correlation: cRef,
    };
    const visMap: Record<string, boolean> = {
      price: true, volume: !!showVolume, breadth: !!showBreadth, breakout: !!showBreakout, correlation: !!showCorrelation,
    };

    const resize = () => {
      const priceChart = charts.current.price;
      const currentRange = priceChart?.timeScale().getVisibleLogicalRange();

      Object.entries(charts.current).forEach(([id, chart]) => {
        const ref = refMap[id];
        if (chart && ref.current && visMap[id]) {
          chart.applyOptions({ width: ref.current.clientWidth, height: ref.current.clientHeight });
          if (id !== 'price' && currentRange) {
            chart.timeScale().setVisibleLogicalRange(currentRange);
          }
        }
      });
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [paneHeights, showVolume, showBreadth, showBreakout, showCorrelation, props.layoutHeight]);

  // Handle rangeUpdateTrigger (Reset 1Y button and date range picker)
  useEffect(() => {
    if (!props.rangeUpdateTrigger) return;

    const setRange = (range: { from: number; to: number }) => {
      Object.values(charts.current).forEach(c => {
        if (c) c.timeScale().setVisibleLogicalRange(range);
      });
    };

    if (props.rangeUpdateTrigger.reset1Y) {
      setRange({ from: dataLengthRef.current - 252, to: dataLengthRef.current + 20 });
      return;
    }

    if (props.rangeUpdateTrigger.from || props.rangeUpdateTrigger.to) {
      const times = timesRef.current;
      const findBarIndex = (dateStr: string) => {
        const t = parseTime(dateStr);
        let lo = 0, hi = times.length - 1;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (times[mid] < t) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };
      const from = props.rangeUpdateTrigger.from ? findBarIndex(props.rangeUpdateTrigger.from) : 0;
      const to = props.rangeUpdateTrigger.to ? findBarIndex(props.rangeUpdateTrigger.to) : dataLengthRef.current + 20;
      setRange({ from, to });
    }
  }, [props.rangeUpdateTrigger]);

  // Ordered indicator pane definitions
  const allPanes: { id: PaneId; ref: React.RefObject<HTMLDivElement>; visible: boolean }[] = [
    { id: 'volume',      ref: vRef,  visible: !!showVolume },
    { id: 'breadth',     ref: bRef,  visible: !!showBreadth },
    { id: 'breakout',    ref: boRef, visible: !!showBreakout },
    { id: 'correlation', ref: cRef,  visible: !!showCorrelation },
  ];
  const activePanes = allPanes.filter(p => p.visible);

  return (
    <div ref={wrapperRef} className="tv-chart-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Price pane: flex:1 takes all space not consumed by indicator panes */}
      <div ref={pRef} style={{ flex: 1, minHeight: '100px' }} />

      {/* Unified pane loop — stable DOM identity regardless of visibility */}
      {allPanes.map((pane) => {
        const activeIdx = activePanes.findIndex(p => p.id === pane.id);
        const isActive = activeIdx !== -1;
        const prevPane = isActive && activeIdx > 0 ? activePanes[activeIdx - 1] : null;
        const isFirstActive = activeIdx === 0;
        return (
          <React.Fragment key={pane.id}>
            {isActive && (
              <div
                className="pane-resizer"
                style={{ height: '6px', cursor: 'ns-resize', background: SOLAR_BASE1, flexShrink: 0 }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  dragging.current = {
                    isTopResizer: isFirstActive,
                    topId:    isFirstActive ? pane.id : prevPane!.id,
                    bottomId: isFirstActive ? undefined : pane.id,
                    startY: e.clientY,
                    startHeights: { ...paneHeights },
                  };
                  document.body.style.cursor = 'ns-resize';
                }}
              />
            )}
            <div
              ref={pane.ref}
              style={{
                height: isActive ? `${paneHeights[pane.id]}px` : 0,
                minHeight: isActive ? `${MIN_PANE_HEIGHT}px` : 0,
                display: isActive ? undefined : 'none',
                flexShrink: 0,
              }}
            />
          </React.Fragment>
        );
      })}

    </div>
  );
};
