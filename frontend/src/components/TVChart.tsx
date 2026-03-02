import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, CrosshairMode, LineType, IChartApi } from 'lightweight-charts';

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
  rangeUpdateTrigger?: RangeTrigger | null;
  exportTrigger?: number;
  symbolName?: string;
}

export const TVChart: React.FC<TVChartProps> = ({ 
  data, showPivots, showTargets, showVolume, rangeUpdateTrigger, exportTrigger, symbolName 
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
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
        const from = trigger.from || ohlcData[0].time;
        const to = trigger.to || ohlcData[lastIndex].time;
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
    if (!chartContainerRef.current || data.length === 0) return;

    const uniqueDataMap = new Map();
    data.forEach(item => { if (item.Date) uniqueDataMap.set(item.Date, item); });
    const sortedData = Array.from(uniqueDataMap.values()).sort((a, b) => a.Date.localeCompare(b.Date));

    const ohlcData = sortedData
      .filter(d => d.Open != null && d.High != null && d.Low != null && d.Close != null)
      .map((d) => ({
        time: d.Date,
        open: Number(d.Open),
        high: Number(d.High),
        low: Number(d.Low),
        close: Number(d.Close),
      }))
      .filter(d => !isNaN(d.open) && !isNaN(d.high) && !isNaN(d.low) && !isNaN(d.close));

    if (ohlcData.length === 0) return;
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

    if (showVolume) {
      const volumeSeries = chart.addHistogramSeries({ 
        color: 'rgba(0, 0, 0, 0.15)', 
        priceFormat: { type: 'volume' },
        priceScaleId: 'left', // Use the hidden left scale for the separate pane
      });
      const volData = sortedData.filter(d => d.Volume != null).map((d) => ({
        time: d.Date, value: Number(d.Volume), color: 'rgba(0, 0, 0, 0.1)',
      })).filter(d => !isNaN(d.value));
      volumeSeries.setData(volData);
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
            resPoints.push({ time: d.Date, value: val });
            resMarkers.push({ time: d.Date, position: 'inBar', color: 'rgba(255, 50, 150, 0.5)', shape: 'circle', size: 0.1 });
          }
        }
        if (d.Support_Pivot != null && d.Is_Down_Rotation !== true) {
          const val = Number(d.Support_Pivot);
          if (!isNaN(val)) {
            supPoints.push({ time: d.Date, value: val });
            supMarkers.push({ time: d.Date, position: 'inBar', color: 'rgba(50, 50, 255, 0.5)', shape: 'circle', size: 0.1 });
          }
        }
      });

      if (resPoints.length > 0) { resSeries.setData(resPoints); resSeries.setMarkers(resMarkers); }
      if (supPoints.length > 0) { supSeries.setData(supPoints); supSeries.setMarkers(supMarkers); }
    }

    if (showTargets) {
      const createTargetSeries = (color: string) => chart.addLineSeries({
        color, lineWidth: 2, lineType: LineType.WithSteps,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      });
      const upperData = sortedData.filter(d => d.Upper_Target != null).map(d => ({ time: d.Date, value: Number(d.Upper_Target) })).filter(d => !isNaN(d.value));
      const lowerData = sortedData.filter(d => d.Lower_Target != null).map(d => ({ time: d.Date, value: Number(d.Lower_Target) })).filter(d => !isNaN(d.value));
      if (upperData.length > 0) createTargetSeries('#3232FF').setData(upperData);
      if (lowerData.length > 0) createTargetSeries('#FF3296').setData(lowerData);
    }

    setTimeout(() => { if (chartRef.current) applyRange(chartRef.current, ohlcData, rangeUpdateTrigger); }, 50);
    const handleResize = () => { chart.applyOptions({ width: chartContainerRef.current?.clientWidth }); };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); chart.remove(); chartRef.current = null; };
  }, [data, showPivots, showTargets, showVolume]);

  return <div ref={chartContainerRef} className="tv-chart-wrapper" />;
};
