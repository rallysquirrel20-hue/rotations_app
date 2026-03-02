import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, CrosshairMode, LineType, IChartApi } from 'lightweight-charts';

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
  rangeUpdateTrigger?: RangeTrigger | null;
  exportTrigger?: number;
  symbolName?: string;
}

const parseTime = (dateStr: string) => {
  if (typeof dateStr === 'string' && dateStr.includes('T')) {
    // NOMINAL TIME FIX:
    // We treat the incoming "YYYY-MM-DDTHH:mm:ss" string as if it were UTC.
    // This prevents the browser from shifting the New York hours based on the user's local timezone.
    const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
    return Math.floor(d.getTime() / 1000) as any;
  }
  return dateStr;
};

export const TVChart: React.FC<TVChartProps> = ({ 
  data, liveUpdate, showPivots, showTargets, showVolume, rangeUpdateTrigger, exportTrigger, symbolName 
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const ohlcDataRef = useRef<any[]>([]);
  const lastExportTriggerRef = useRef<number>(exportTrigger || 0);

  const applyRange = (chart: IChartApi, ohlcData: any[], trigger?: RangeTrigger | null) => {
    if (ohlcData.length === 0) return;
    try {
      const timeScale = chart.timeScale();
      const lastIndex = ohlcData.length - 1;
      if (trigger?.reset1Y || !trigger) {
        timeScale.setVisibleLogicalRange({ from: lastIndex - 252, to: lastIndex + 20 });
      } else if (trigger.from || trigger.to) {
        const from = trigger.from ? parseTime(trigger.from) : ohlcData[0].time;
        const to = trigger.to ? parseTime(trigger.to) : ohlcData[lastIndex].time;
        timeScale.setVisibleRange({ from: from as any, to: to as any });
      }
    } catch (e) { console.error("Error setting range:", e); }
  };

  // FIX: Export handling - only fire if trigger INCREASES
  useEffect(() => {
    if (exportTrigger && exportTrigger > lastExportTriggerRef.current && chartRef.current) {
      const canvas = chartRef.current.takeScreenshot();
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `${symbolName || 'chart'}_${new Date().toISOString().split('T')[0]}.png`;
      link.href = dataUrl;
      link.click();
    }
    lastExportTriggerRef.current = exportTrigger || 0;
  }, [exportTrigger, symbolName]);

  useEffect(() => {
    if (chartRef.current && ohlcDataRef.current.length > 0 && rangeUpdateTrigger) {
      applyRange(chartRef.current, ohlcDataRef.current, rangeUpdateTrigger);
    }
  }, [rangeUpdateTrigger]);

  useEffect(() => {
    if (liveUpdate && candlestickSeriesRef.current) {
      const parsedTime = parseTime(liveUpdate.time);
      const parsedUpdate = { ...liveUpdate, time: parsedTime };

      try {
        candlestickSeriesRef.current.update(parsedUpdate);
        if (showVolume && volumeSeriesRef.current && liveUpdate.volume !== undefined) {
          volumeSeriesRef.current.update({
            time: parsedTime,
            value: liveUpdate.volume,
            color: 'rgba(0, 0, 0, 0.1)',
          });
        }
      } catch (e) {
        console.error("Error updating live data:", e);
      }
    }
  }, [liveUpdate, showVolume]);

  useEffect(() => {
    if (!chartContainerRef.current || data.length === 0) return;

    const uniqueDataMap = new Map();
    data.forEach(item => { if (item.Date) uniqueDataMap.set(item.Date, item); });
    const sortedData = Array.from(uniqueDataMap.values()).sort((a, b) => a.Date.localeCompare(b.Date));

    const ohlcData = sortedData
      .filter(d => d.Open != null && d.High != null && d.Low != null && d.Close != null)
      .map((d) => ({
        time: parseTime(d.Date),
        open: Number(d.Open),
        high: Number(d.High),
        low: Number(d.Low),
        close: Number(d.Close),
      }))
      .filter(d => !isNaN(d.open) && !isNaN(d.high) && !isNaN(d.low) && !isNaN(d.close));

    if (ohlcData.length === 0) return;
    
    // Sort array by time to prevent Lightweight Charts errors
    ohlcData.sort((a, b) => (a.time as number) - (b.time as number));
    
    ohlcDataRef.current = ohlcData;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#D3D3D3' }, 
        textColor: '#FFFFFF',
      },
      watermark: { visible: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { 
        borderColor: '#AAAAAA', 
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.35 }, // Price restricted to top ~65%
      },
      leftPriceScale: { 
        visible: false,
        scaleMargins: { top: 0.8, bottom: 0 }, // Volume restricted to bottom 20%
      },
      timeScale: { borderColor: '#AAAAAA', timeVisible: true, rightOffset: 20, fixLeftEdge: false, fixRightEdge: false },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
    });
    chartRef.current = chart;

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: 'transparent', downColor: '#FFFFFF', borderVisible: true,
      borderUpColor: '#FFFFFF', borderDownColor: '#FFFFFF', wickUpColor: '#FFFFFF', wickDownColor: '#FFFFFF',
    });
    candlestickSeries.setData(ohlcData);
    candlestickSeriesRef.current = candlestickSeries;

    if (showVolume) {
      const volumeSeries = chart.addHistogramSeries({ 
        color: 'rgba(0, 0, 0, 0.15)', 
        priceFormat: { type: 'volume' },
        priceScaleId: 'left', // Use the hidden left scale for the separate pane
      });
      const volData = sortedData.filter(d => d.Volume != null).map((d) => ({
        time: parseTime(d.Date), value: Number(d.Volume), color: 'rgba(0, 0, 0, 0.1)',
      })).filter(d => !isNaN(d.value));
      volData.sort((a, b) => (a.time as number) - (b.time as number));
      volumeSeries.setData(volData);
      volumeSeriesRef.current = volumeSeries;
    }

    if (showPivots) {
      // Discrete dots using setMarkers on transparent series
      const resSeries = chart.addLineSeries({ color: 'transparent', lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      const supSeries = chart.addLineSeries({ color: 'transparent', lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });

      const resPoints: any[] = [];
      const resMarkers: any[] = [];
      const supPoints: any[] = [];
      const supMarkers: any[] = [];

      sortedData.forEach(d => {
        if (d.Resistance_Pivot != null && d.Is_Up_Rotation !== true) {
          const val = Number(d.Resistance_Pivot);
          if (!isNaN(val)) {
            const time = parseTime(d.Date);
            resPoints.push({ time, value: val });
            resMarkers.push({ time, position: 'inBar', color: 'rgba(255, 50, 150, 0.5)', shape: 'circle', size: 0.1 });
          }
        }
        if (d.Support_Pivot != null && d.Is_Down_Rotation !== true) {
          const val = Number(d.Support_Pivot);
          if (!isNaN(val)) {
            const time = parseTime(d.Date);
            supPoints.push({ time, value: val });
            supMarkers.push({ time, position: 'inBar', color: 'rgba(50, 50, 255, 0.5)', shape: 'circle', size: 0.1 });
          }
        }
      });

      if (resPoints.length > 0) { 
        resPoints.sort((a, b) => (a.time as number) - (b.time as number));
        resMarkers.sort((a, b) => (a.time as number) - (b.time as number));
        resSeries.setData(resPoints); 
        resSeries.setMarkers(resMarkers); 
      }
      if (supPoints.length > 0) { 
        supPoints.sort((a, b) => (a.time as number) - (b.time as number));
        supMarkers.sort((a, b) => (a.time as number) - (b.time as number));
        supSeries.setData(supPoints); 
        supSeries.setMarkers(supMarkers); 
      }
    }

    if (showTargets) {
      const createTargetSeries = (color: string) => chart.addLineSeries({
        color, lineWidth: 2, lineType: LineType.WithSteps,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      });
      const upperData = sortedData.filter(d => d.Upper_Target != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Upper_Target) })).filter(d => !isNaN(d.value));
      const lowerData = sortedData.filter(d => d.Lower_Target != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Lower_Target) })).filter(d => !isNaN(d.value));
      if (upperData.length > 0) {
        upperData.sort((a, b) => (a.time as number) - (b.time as number));
        createTargetSeries('#3232FF').setData(upperData);
      }
      if (lowerData.length > 0) {
        lowerData.sort((a, b) => (a.time as number) - (b.time as number));
        createTargetSeries('#FF3296').setData(lowerData);
      }
    }

    setTimeout(() => { if (chartRef.current) applyRange(chartRef.current, ohlcData, rangeUpdateTrigger); }, 50);
    const handleResize = () => { chart.applyOptions({ width: chartContainerRef.current?.clientWidth }); };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); chart.remove(); chartRef.current = null; };
  }, [data, showPivots, showTargets, showVolume]);

  return <div ref={chartContainerRef} className="tv-chart-wrapper" />;
};
