import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import axios from 'axios'
import { createChart, ColorType, CrosshairMode, LineStyle, IChartApi } from 'lightweight-charts'

interface BacktestFilter {
  metric: string
  condition: string
  value: number | string
  source: string
}

interface Trade {
  ticker?: string
  entry_date: string
  exit_date: string
  entry_price: number | null
  exit_price: number | null
  change: number | null
  mfe: number | null
  mae: number | null
  bars_held: number
  regime_pass: boolean
}

interface Stats {
  trades: number
  win_rate: number
  avg_winner: number
  avg_loser: number
  ev: number
  profit_factor: number
  max_dd: number
  avg_bars: number
}

interface BacktestResult {
  trades: Trade[]
  trade_paths: number[][]
  equity_curve: { dates: string[]; filtered: number[]; unfiltered: number[]; buy_hold: number[] }
  stats: { filtered: Stats; unfiltered: Stats }
  date_range: { min: string; max: string }
  blew_up?: { date: string; trade_index: number; equity: string }
}

interface BacktestPanelProps {
  target: string
  targetType: 'basket' | 'ticker'
  apiBase: string
  availableBaskets: string[]
  showPivots: boolean
  showTargets: boolean
  showVolume: boolean
  showBreadth: boolean
  showBreakout: boolean
  showCorrelation: boolean
  exportTrigger?: number
}

const ENTRY_SIGNALS = ['Up_Rot', 'Down_Rot', 'Breakout', 'Breakdown', 'BTFD', 'STFR']
const EXIT_MAP: Record<string, string> = {
  Up_Rot: 'Down_Rot', Down_Rot: 'Up_Rot',
  Breakout: 'Breakdown', Breakdown: 'Breakout',
  BTFD: 'Breakdown', STFR: 'Breakout',
}

const PCT_METRICS = ['Uptrend_Pct', 'Breakout_Pct', 'Correlation_Pct', 'RV_EMA']
const BOOL_METRICS = ['Is_Breakout_Sequence', 'Trend', 'BTFD_Triggered', 'STFR_Triggered']
const POS_PRESETS = [5, 10, 25, 50, 100]

type TradeSortCol = 'ticker' | 'entry_date' | 'exit_date' | 'entry_price' | 'exit_price' | 'change' | 'mfe' | 'mae' | 'bars_held' | 'regime_pass'
type ResultTab = 'equity' | 'trades' | 'distribution' | 'chart' | 'path'
type HistMetric = 'change' | 'mfe' | 'mae'

const LIGHT_PINK = 'rgb(255, 183, 226)'
const LIGHT_BLUE = 'rgb(179, 222, 255)'

const LONG_SIGNALS = new Set(['Up_Rot', 'Breakout', 'BTFD'])

const parseTime = (dateStr: string) => {
  const s = dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00'
  const d = new Date(s.endsWith('Z') ? s : s + 'Z')
  return Math.floor(d.getTime() / 1000) as any
}

const HIST_COLORS: Record<HistMetric, { fill: string; stroke: string; label: string }> = {
  mae:    { fill: LIGHT_PINK,           stroke: 'rgb(255, 50, 150)', label: 'MAE' },
  change: { fill: 'rgb(200, 210, 220)', stroke: '#586e75',           label: 'Change' },
  mfe:    { fill: LIGHT_BLUE,           stroke: 'rgb(50, 50, 255)', label: 'MFE' },
}

function pctFmt(v: number | null): string {
  if (v === null) return '--'
  return (v * 100).toFixed(2) + '%'
}

function dollarFmt(v: number): string {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M'
  if (abs >= 1_000) return sign + '$' + (abs / 1_000).toFixed(0) + 'K'
  return sign + '$' + abs.toFixed(0)
}

export function BacktestPanel({ target, targetType, apiBase, availableBaskets, showPivots, showTargets, showVolume, showBreadth, showBreakout, showCorrelation, exportTrigger }: BacktestPanelProps) {
  // Config state
  const [entrySignal, setEntrySignal] = useState('Breakout')
  const [filters, setFilters] = useState<BacktestFilter[]>([])
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [dataRange, setDataRange] = useState<{ min: string; max: string } | null>(null)
  const [initialEquity, setInitialEquity] = useState(100000)
  const [positionSize, setPositionSize] = useState(100)
  const [maxLeverage, setMaxLeverage] = useState(250)
  const [useConstituents, setUseConstituents] = useState(false)

  // Results state
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showResults, setShowResults] = useState(false)

  // Results sub-state
  const [resultTab, setResultTab] = useState<ResultTab>('equity')
  const [sortCol, setSortCol] = useState<TradeSortCol>('entry_date')
  const [sortAsc, setSortAsc] = useState(true)
  const [histVisible, setHistVisible] = useState<Set<HistMetric>>(new Set(['change', 'mfe', 'mae']))
  const [hoveredCurve, setHoveredCurve] = useState<HistMetric | null>(null)
  const [showFiltered, setShowFiltered] = useState(true)
  const [showUnfiltered, setShowUnfiltered] = useState(true)
  const [showBuyHold, setShowBuyHold] = useState(false)

  // Canvas refs — equity curve
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 800, h: 400 })

  // Canvas refs — histogram
  const histCanvasRef = useRef<HTMLCanvasElement>(null)
  const histContainerRef = useRef<HTMLDivElement>(null)
  const [histDims, setHistDims] = useState({ w: 800, h: 400 })
  // Chart tab refs
  const priceChartRef = useRef<HTMLDivElement>(null)
  const chartInstanceRef = useRef<IChartApi | null>(null)
  const [tradeIndex, setTradeIndex] = useState(0)

  // Path tab refs
  const pathCanvasRef = useRef<HTMLCanvasElement>(null)
  const pathContainerRef = useRef<HTMLDivElement>(null)
  const [pathDims, setPathDims] = useState({ w: 800, h: 400 })
  const [hoveredPath, setHoveredPath] = useState<number | null>(null)

  // Chart ticker navigation (for basket_tickers mode)
  const [chartTickerIdx, setChartTickerIdx] = useState(0)

  // Store computed curve pixel paths + legend rects for mouse hit-testing
  const histHitRef = useRef<{
    curves: { metric: HistMetric; pxPoints: { x: number; y: number }[] }[]
    legendRows: { metric: HistMetric; x: number; y: number; w: number; h: number }[]
    baseline: number // y pixel of the bottom of the plot area
  }>({ curves: [], legendRows: [], baseline: 0 })

  // Export current tab when exportTrigger changes
  const prevExportTrigger = useRef(exportTrigger || 0)
  useEffect(() => {
    if (!exportTrigger || exportTrigger === prevExportTrigger.current) {
      prevExportTrigger.current = exportTrigger || 0
      return
    }
    prevExportTrigger.current = exportTrigger

    const tabLabel = resultTab
    const filename = `${target}_${entrySignal}_${tabLabel}.png`

    const downloadCanvas = (canvas: HTMLCanvasElement) => {
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
      }, 'image/png')
    }

    if (resultTab === 'chart') {
      const chart = chartInstanceRef.current
      if (chart) {
        try { downloadCanvas(chart.takeScreenshot()) } catch {}
      }
    } else if (resultTab === 'equity') {
      if (canvasRef.current) downloadCanvas(canvasRef.current)
    } else if (resultTab === 'distribution') {
      if (histCanvasRef.current) downloadCanvas(histCanvasRef.current)
    } else if (resultTab === 'path') {
      if (pathCanvasRef.current) downloadCanvas(pathCanvasRef.current)
    }
  }, [exportTrigger])

  // Fetch available date range when target changes
  useEffect(() => {
    let cancelled = false
    axios.get(`${apiBase}/date-range/${targetType}/${target}`)
      .then(res => {
        if (cancelled) return
        setDataRange(res.data)
        setStartDate(res.data.min)
        setEndDate(res.data.max)
      })
      .catch(() => {
        if (!cancelled) setDataRange(null)
      })
    return () => { cancelled = true }
  }, [target, targetType, apiBase])

  const addFilter = () => {
    setFilters(prev => [...prev, { metric: 'Uptrend_Pct', condition: 'above', value: 50, source: 'self' }])
  }

  const removeFilter = (i: number) => {
    setFilters(prev => prev.filter((_, idx) => idx !== i))
  }

  const updateFilter = (i: number, field: string, val: string | number) => {
    setFilters(prev => prev.map((f, idx) => {
      if (idx !== i) return f
      const updated = { ...f, [field]: val }
      // Reset condition when switching metric type
      if (field === 'metric') {
        if (BOOL_METRICS.includes(val as string)) {
          updated.condition = 'equals_true'
          updated.value = ''
        } else {
          updated.condition = 'above'
          updated.value = 50
        }
      }
      return updated
    }))
  }

  const runBacktest = async () => {
    setLoading(true)
    setError(null)
    try {
      const effectiveType = (targetType === 'basket' && useConstituents) ? 'basket_tickers' : targetType
      const body = {
        target,
        target_type: effectiveType,
        entry_signal: entrySignal,
        filters: filters.map(f => ({
          metric: f.metric,
          condition: f.condition,
          value: BOOL_METRICS.includes(f.metric) ? null : Number(f.value),
          source: f.source,
        })),
        start_date: startDate || null,
        end_date: endDate || null,
        initial_equity: initialEquity,
        position_size: positionSize / 100,
        max_leverage: maxLeverage / 100,
      }
      const res = await axios.post(`${apiBase}/backtest`, body)
      setResult(res.data)
      setShowResults(true)
      setResultTab('equity')
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Backtest failed')
    } finally {
      setLoading(false)
    }
  }

  // Sorted trades
  const sortedTrades = useMemo(() => {
    if (!result) return []
    const arr = [...result.trades]
    arr.sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol]
      if (typeof av === 'string' && typeof bv === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
      if (typeof av === 'boolean' && typeof bv === 'boolean') return sortAsc ? (av === bv ? 0 : av ? -1 : 1) : (av === bv ? 0 : av ? 1 : -1)
      const an = av === null || av === undefined ? -Infinity : Number(av)
      const bn = bv === null || bv === undefined ? -Infinity : Number(bv)
      return sortAsc ? an - bn : bn - an
    })
    return arr
  }, [result, sortCol, sortAsc])

  // Unique tickers from trades (for multi-ticker chart navigation)
  const chartTickers = useMemo(() => {
    if (!result) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of result.trades) {
      if (t.ticker && !seen.has(t.ticker)) { seen.add(t.ticker); out.push(t.ticker) }
    }
    return out.sort()
  }, [result])

  const handleSort = (col: TradeSortCol) => {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(col === 'entry_date' || col === 'exit_date') }
  }

  // ResizeObserver for equity canvas
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setDims({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [resultTab, showResults])

  // ResizeObserver for histogram canvas
  useEffect(() => {
    const el = histContainerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setHistDims({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [resultTab, showResults])

  // ResizeObserver for path canvas
  useEffect(() => {
    const el = pathContainerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setPathDims({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [resultTab, showResults])

  // Draw equity curve (dollar-based)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !result || resultTab !== 'equity') return
    const { dates, filtered, unfiltered, buy_hold } = result.equity_curve
    if (!dates.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = dims.w * dpr
    canvas.height = dims.h * dpr
    ctx.scale(dpr, dpr)

    const pad = { top: 20, right: 70, bottom: 50, left: 20 }
    const plotW = dims.w - pad.left - pad.right
    const plotH = dims.h - pad.top - pad.bottom

    // Y range from visible series only
    let yMin = initialEquity, yMax = initialEquity
    if (showFiltered) for (const v of filtered) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v) }
    if (showUnfiltered) for (const v of unfiltered) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v) }
    if (showBuyHold && buy_hold) for (const v of buy_hold) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v) }
    const yPad = (yMax - yMin) * 0.1 || initialEquity * 0.1
    yMin -= yPad; yMax += yPad

    const n = dates.length
    const xScale = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2)
    const yScale = (v: number) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH

    ctx.clearRect(0, 0, dims.w, dims.h)
    ctx.fillStyle = '#fdf6e3'
    ctx.fillRect(0, 0, dims.w, dims.h)

    // Grid
    ctx.strokeStyle = '#e9ecef'
    ctx.lineWidth = 1
    const nTicks = 6
    for (let i = 0; i <= nTicks; i++) {
      const v = yMin + (yMax - yMin) * (i / nTicks)
      const y = yScale(v)
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(dims.w - pad.right, y); ctx.stroke()
      ctx.fillStyle = '#6c757d'; ctx.font = '10px monospace'; ctx.textAlign = 'left'
      ctx.fillText(dollarFmt(v), dims.w - pad.right + 5, y + 3)
    }

    // Breakeven line at initial equity
    const beY = yScale(initialEquity)
    ctx.strokeStyle = '#adb5bd'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(pad.left, beY); ctx.lineTo(dims.w - pad.right, beY); ctx.stroke()
    ctx.setLineDash([])

    // X axis labels
    const labelInterval = Math.max(1, Math.floor(n / 8))
    ctx.fillStyle = '#6c757d'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
    for (let i = 0; i < n; i += labelInterval) {
      ctx.fillText(dates[i].slice(0, 7), xScale(i), dims.h - pad.bottom + 15)
    }

    // Draw buy-and-hold line (green dotted)
    if (showBuyHold && buy_hold && buy_hold.length === n) {
      ctx.strokeStyle = '#859900'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = xScale(i), y = yScale(buy_hold[i])
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Draw unfiltered line (gray dashed)
    if (showUnfiltered) {
      ctx.strokeStyle = '#adb5bd'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = xScale(i), y = yScale(unfiltered[i])
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Draw filtered line (blue solid)
    if (showFiltered) {
      ctx.strokeStyle = 'rgb(50, 50, 255)'
      ctx.lineWidth = 2
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = xScale(i), y = yScale(filtered[i])
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // Legend
    const legendItems: { label: string; value: string; color: string; dash: number[]; lw: number }[] = []
    if (showFiltered) {
      const v = filtered[n - 1]
      const ret = (v - initialEquity) / initialEquity
      legendItems.push({ label: 'Filtered', value: `${dollarFmt(v)} (${pctFmt(ret)})`, color: 'rgb(50, 50, 255)', dash: [], lw: 2 })
    }
    if (showUnfiltered) {
      const v = unfiltered[n - 1]
      const ret = (v - initialEquity) / initialEquity
      legendItems.push({ label: 'All', value: `${dollarFmt(v)} (${pctFmt(ret)})`, color: '#adb5bd', dash: [6, 4], lw: 1.5 })
    }
    if (showBuyHold && buy_hold && buy_hold.length === n) {
      const v = buy_hold[n - 1]
      const ret = (v - initialEquity) / initialEquity
      legendItems.push({ label: 'Buy&Hold', value: `${dollarFmt(v)} (${pctFmt(ret)})`, color: '#859900', dash: [4, 3], lw: 1.5 })
    }

    if (legendItems.length > 0) {
      const lx = pad.left + 10, ly = pad.top + 10
      const rowH = 16
      const boxH = legendItems.length * rowH + 2
      ctx.fillStyle = '#fdf6e3'
      ctx.fillRect(lx - 4, ly - 10, 250, boxH)
      ctx.strokeStyle = '#93a1a1'; ctx.lineWidth = 1
      ctx.strokeRect(lx - 4, ly - 10, 250, boxH)
      legendItems.forEach((item, idx) => {
        const iy = ly + idx * rowH
        ctx.strokeStyle = item.color; ctx.lineWidth = item.lw; ctx.setLineDash(item.dash)
        ctx.beginPath(); ctx.moveTo(lx, iy); ctx.lineTo(lx + 20, iy); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = '#586e75'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left'
        ctx.fillText(`${item.label} ${item.value}`, lx + 24, iy + 3)
      })
    }

  }, [result, resultTab, dims, initialEquity, showFiltered, showUnfiltered, showBuyHold])

  // Draw overlaid KDE density curves
  useEffect(() => {
    const canvas = histCanvasRef.current
    if (!canvas || !result || resultTab !== 'distribution') return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = histDims.w * dpr
    canvas.height = histDims.h * dpr
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, histDims.w, histDims.h)
    ctx.fillStyle = '#fdf6e3'
    ctx.fillRect(0, 0, histDims.w, histDims.h)

    // Collect values for all visible metrics
    const metrics = (['mae', 'change', 'mfe'] as HistMetric[]).filter(m => histVisible.has(m))
    if (metrics.length === 0) return

    const allValsByMetric: Record<string, number[]> = {}
    let globalMin = Infinity, globalMax = -Infinity
    for (const m of metrics) {
      const vals = result.trades.map(t => t[m]).filter((v): v is number => v !== null && v !== undefined)
      allValsByMetric[m] = vals
      for (const v of vals) { globalMin = Math.min(globalMin, v); globalMax = Math.max(globalMax, v) }
    }

    if (globalMin === Infinity) {
      ctx.fillStyle = '#6c757d'; ctx.font = '14px monospace'; ctx.textAlign = 'center'
      ctx.fillText('No data', histDims.w / 2, histDims.h / 2)
      return
    }

    // Extend range slightly for padding
    const range = globalMax - globalMin || 0.01
    const xMin = globalMin - range * 0.08
    const xMax = globalMax + range * 0.08

    const pad = { top: 30, right: 30, bottom: 50, left: 20 }
    const plotW = histDims.w - pad.left - pad.right
    const plotH = histDims.h - pad.top - pad.bottom
    const nPoints = Math.min(200, plotW)

    // KDE: Gaussian kernel with Silverman bandwidth
    function kde(vals: number[]): { xs: number[]; ys: number[] } {
      const n = vals.length
      const mean = vals.reduce((a, b) => a + b, 0) / n
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || range * 0.1
      const h = 1.06 * std * Math.pow(n, -0.2)
      const invH = 1 / h
      const coeff = 1 / (n * h * Math.sqrt(2 * Math.PI))
      const xs: number[] = []
      const ys: number[] = []
      for (let i = 0; i < nPoints; i++) {
        const x = xMin + (i / (nPoints - 1)) * (xMax - xMin)
        let density = 0
        for (const v of vals) {
          const z = (x - v) * invH
          density += Math.exp(-0.5 * z * z)
        }
        xs.push(x)
        ys.push(density * coeff)
      }
      return { xs, ys }
    }

    // Compute KDE for each metric
    const curves: { metric: HistMetric; xs: number[]; ys: number[]; mean: number; std: number }[] = []
    let maxDensity = 0
    for (const m of metrics) {
      const vals = allValsByMetric[m]
      if (vals.length < 2) continue
      const { xs, ys } = kde(vals)
      for (const y of ys) maxDensity = Math.max(maxDensity, y)
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
      curves.push({ metric: m, xs, ys, mean, std })
    }

    if (maxDensity === 0) return

    // Scales
    const xScale = (v: number) => pad.left + ((v - xMin) / (xMax - xMin)) * plotW
    const yScale = (d: number) => pad.top + plotH - (d / maxDensity) * plotH

    // Store pixel points for hit-testing
    const hitCurves: typeof histHitRef.current.curves = []
    for (const { metric, xs, ys } of curves) {
      hitCurves.push({ metric, pxPoints: xs.map((x, i) => ({ x: xScale(x), y: yScale(ys[i]) })) })
    }

    // Grid lines
    ctx.strokeStyle = '#e9ecef'; ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH * i) / 4
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke()
    }

    // Draw order: non-hovered first (dimmed), hovered last (on top)
    const drawOrder = hoveredCurve
      ? [...curves.filter(c => c.metric !== hoveredCurve), ...curves.filter(c => c.metric === hoveredCurve)]
      : curves

    for (const { metric, xs, ys } of drawOrder) {
      const colors = HIST_COLORS[metric]
      const dimmed = hoveredCurve !== null && metric !== hoveredCurve
      const alpha = dimmed ? 0.2 : 1.0

      ctx.globalAlpha = alpha
      // Filled area
      ctx.beginPath()
      ctx.moveTo(xScale(xs[0]), pad.top + plotH)
      for (let i = 0; i < xs.length; i++) ctx.lineTo(xScale(xs[i]), yScale(ys[i]))
      ctx.lineTo(xScale(xs[xs.length - 1]), pad.top + plotH)
      ctx.closePath()
      ctx.fillStyle = colors.fill
      ctx.fill()

      // Stroke line
      ctx.beginPath()
      for (let i = 0; i < xs.length; i++) {
        const px = xScale(xs[i]), py = yScale(ys[i])
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
      }
      ctx.strokeStyle = colors.stroke
      ctx.lineWidth = dimmed ? 1 : 2
      ctx.stroke()
      ctx.globalAlpha = 1.0
    }

    // X axis labels
    const nLabels = 8
    ctx.fillStyle = '#6c757d'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
    for (let i = 0; i <= nLabels; i++) {
      const v = xMin + (i / nLabels) * (xMax - xMin)
      ctx.fillText((v * 100).toFixed(1) + '%', xScale(v), histDims.h - pad.bottom + 15)
    }

    // Zero line
    if (xMin < 0 && xMax > 0) {
      const zx = xScale(0)
      ctx.strokeStyle = '#586e75'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(zx, pad.top); ctx.lineTo(zx, pad.top + plotH); ctx.stroke()
      ctx.setLineDash([])
    }

    // Mean lines per metric
    for (const { metric, mean } of drawOrder) {
      const colors = HIST_COLORS[metric]
      const dimmed = hoveredCurve !== null && metric !== hoveredCurve
      ctx.globalAlpha = dimmed ? 0.15 : 1.0
      const mx = xScale(mean)
      ctx.strokeStyle = colors.stroke; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(mx, pad.top); ctx.lineTo(mx, pad.top + plotH); ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1.0
    }

    // Legend — top right
    const legendW = 260
    const rowH = 16
    const legendH = 12 + curves.length * rowH
    const lx = histDims.w - pad.right - legendW - 4
    const ly = pad.top + 4
    ctx.fillStyle = '#fdf6e3'
    ctx.fillRect(lx - 4, ly - 10, legendW, legendH)
    ctx.strokeStyle = '#93a1a1'; ctx.lineWidth = 1
    ctx.strokeRect(lx - 4, ly - 10, legendW, legendH)
    const legendRows: typeof histHitRef.current.legendRows = []
    for (let i = 0; i < curves.length; i++) {
      const { metric, mean, std } = curves[i]
      const colors = HIST_COLORS[metric]
      const rowY = ly + i * rowH
      const isHovered = hoveredCurve === metric
      // Color swatch
      ctx.fillStyle = colors.fill
      ctx.fillRect(lx, rowY - 4, 14, 10)
      ctx.strokeStyle = colors.stroke; ctx.lineWidth = 1
      ctx.strokeRect(lx, rowY - 4, 14, 10)
      // Label
      ctx.fillStyle = isHovered ? colors.stroke : '#586e75'
      ctx.font = (isHovered ? 'bold ' : '') + '10px monospace'; ctx.textAlign = 'left'
      ctx.fillText(`${colors.label}  mean ${(mean * 100).toFixed(2)}%`, lx + 18, rowY + 4)
      legendRows.push({ metric, x: lx - 4, y: rowY - 10, w: legendW, h: rowH })
    }

    histHitRef.current = { curves: hitCurves, legendRows, baseline: pad.top + plotH }

  }, [result, resultTab, histVisible, histDims, hoveredCurve])

  // Mouse handler for histogram legend hover
  const handleHistMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = histCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    for (const row of histHitRef.current.legendRows) {
      if (mx >= row.x && mx <= row.x + row.w && my >= row.y && my <= row.y + row.h) {
        if (hoveredCurve !== row.metric) setHoveredCurve(row.metric)
        return
      }
    }
    if (hoveredCurve !== null) setHoveredCurve(null)
  }

  const handleHistMouseLeave = () => { setHoveredCurve(null) }

  // Draw path chart (trade paths from 0% to exit)
  useEffect(() => {
    const canvas = pathCanvasRef.current
    if (!canvas || !result || resultTab !== 'path') return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = pathDims.w * dpr
    canvas.height = pathDims.h * dpr
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, pathDims.w, pathDims.h)
    ctx.fillStyle = '#fdf6e3'
    ctx.fillRect(0, 0, pathDims.w, pathDims.h)

    const paths = result.trade_paths
    if (!paths || paths.length === 0) {
      ctx.fillStyle = '#6c757d'; ctx.font = '14px monospace'; ctx.textAlign = 'center'
      ctx.fillText('No trade paths', pathDims.w / 2, pathDims.h / 2)
      return
    }

    // Find max bars and Y range
    let maxBars = 0
    let yMin = 0, yMax = 0
    for (const p of paths) {
      maxBars = Math.max(maxBars, p.length)
      for (const v of p) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v) }
    }
    if (maxBars < 2) return
    const yPad = (yMax - yMin) * 0.1 || 0.05
    yMin -= yPad; yMax += yPad

    const pad = { top: 20, right: 60, bottom: 50, left: 20 }
    const plotW = pathDims.w - pad.left - pad.right
    const plotH = pathDims.h - pad.top - pad.bottom

    const xScale = (i: number) => pad.left + (i / (maxBars - 1)) * plotW
    const yScale = (v: number) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH

    // Grid
    ctx.strokeStyle = '#e9ecef'; ctx.lineWidth = 1
    const nTicks = 6
    for (let i = 0; i <= nTicks; i++) {
      const v = yMin + (yMax - yMin) * (i / nTicks)
      const y = yScale(v)
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pathDims.w - pad.right, y); ctx.stroke()
      ctx.fillStyle = '#6c757d'; ctx.font = '10px monospace'; ctx.textAlign = 'left'
      ctx.fillText((v * 100).toFixed(1) + '%', pathDims.w - pad.right + 5, y + 3)
    }

    // Zero line
    const zeroY = yScale(0)
    ctx.strokeStyle = '#adb5bd'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(pathDims.w - pad.right, zeroY); ctx.stroke()
    ctx.setLineDash([])

    // X axis labels (bars)
    const labelInterval = Math.max(1, Math.floor(maxBars / 10))
    ctx.fillStyle = '#6c757d'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
    for (let i = 0; i < maxBars; i += labelInterval) {
      ctx.fillText(String(i), xScale(i), pathDims.h - pad.bottom + 15)
    }

    // Rank paths by final return (best first) for color gradient
    const ranked = paths.map((p, i) => ({ p, i, ret: p.length > 0 ? p[p.length - 1] : 0 }))
      .filter(d => d.p.length >= 2)
      .sort((a, b) => b.ret - a.ret)
    const totalRanked = ranked.length

    // Blue (best) -> Purple (mid) -> Pink (worst) gradient
    const rankColor = (rank: number, total: number): string => {
      if (total <= 1) return 'rgb(50, 50, 255)'
      const t = rank / (total - 1)
      if (t <= 0.5) {
        const s = t * 2
        return `rgb(${Math.round(50 + 102 * s)}, 50, ${Math.round(255 - 53 * s)})`
      } else {
        const s = (t - 0.5) * 2
        return `rgb(${Math.round(152 + 103 * s)}, 50, ${Math.round(202 - 52 * s)})`
      }
    }

    // Draw non-hovered paths first, then hovered on top
    for (let ri = 0; ri < totalRanked; ri++) {
      const { p, i: pi } = ranked[ri]
      if (pi === hoveredPath) continue
      const isOther = hoveredPath !== null
      ctx.strokeStyle = isOther ? '#dee2e6' : rankColor(ri, totalRanked)
      ctx.lineWidth = 1.2
      ctx.globalAlpha = isOther ? 0.3 : 1
      ctx.beginPath()
      for (let i = 0; i < p.length; i++) {
        const x = xScale(i), y = yScale(p[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // Draw hovered path on top
    if (hoveredPath !== null) {
      const hovRank = ranked.findIndex(d => d.i === hoveredPath)
      const entry = ranked[hovRank]
      if (entry && entry.p.length >= 2) {
        ctx.strokeStyle = rankColor(hovRank, totalRanked)
        ctx.lineWidth = 2.5
        ctx.globalAlpha = 1
        ctx.beginPath()
        for (let i = 0; i < entry.p.length; i++) {
          const x = xScale(i), y = yScale(entry.p[i])
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

  }, [result, resultTab, pathDims, hoveredPath])

  // Navigate chart to a specific trade (uses visible trades for current ticker)
  const navigateToTrade = useCallback((idx: number) => {
    if (!result || !chartInstanceRef.current) return
    const currentTkr = chartTickers.length > 0 ? chartTickers[Math.min(chartTickerIdx, chartTickers.length - 1)] : null
    const visibleTrades = currentTkr ? result.trades.filter(t => t.ticker === currentTkr) : result.trades
    if (visibleTrades.length === 0) return
    const clamped = Math.max(0, Math.min(idx, visibleTrades.length - 1))
    setTradeIndex(clamped)
    const t = visibleTrades[clamped]
    const entryTime = new Date(t.entry_date + 'T00:00:00Z').getTime()
    const from = new Date(entryTime - 90 * 86400000)
    const to = new Date(entryTime + 270 * 86400000)
    chartInstanceRef.current.timeScale().setVisibleRange({
      from: (Math.floor(from.getTime() / 1000)) as any,
      to: (Math.floor(to.getTime() / 1000)) as any,
    })
  }, [result, chartTickers, chartTickerIdx])

  // Price chart with trade markers + indicators
  useEffect(() => {
    if (resultTab !== 'chart' || !result || !priceChartRef.current) return

    // Clean up previous chart
    if (chartInstanceRef.current) {
      chartInstanceRef.current.remove()
      chartInstanceRef.current = null
    }

    const isLong = LONG_SIGNALS.has(entrySignal)
    const isMulti = chartTickers.length > 0
    const currentTicker = isMulti ? chartTickers[Math.min(chartTickerIdx, chartTickers.length - 1)] : null

    // In multi-ticker mode, fetch the current ticker's OHLC; otherwise fetch basket/ticker
    const endpoint = isMulti
      ? `tickers/${encodeURIComponent(currentTicker!)}`
      : targetType === 'basket'
        ? `baskets/${encodeURIComponent(target)}`
        : `tickers/${encodeURIComponent(target)}`

    // Filter trades to current ticker in multi-ticker mode
    const visibleTrades = isMulti
      ? result.trades.filter(t => t.ticker === currentTicker)
      : result.trades

    axios.get(`${apiBase}/${endpoint}`).then(res => {
      if (!priceChartRef.current) return
      const rawData: any[] = res.data.chart_data || []
      if (rawData.length === 0) return

      const sorted = [...rawData].sort((a, b) => String(a.Date).localeCompare(String(b.Date)))
      const times = sorted.map(d => parseTime(d.Date))
      const ohlc = sorted
        .map((d, i) => ({ time: times[i], open: Number(d.Open), high: Number(d.High), low: Number(d.Low), close: Number(d.Close) }))
        .filter(d => !isNaN(d.open))

      const chart = createChart(priceChartRef.current!, {
        layout: { background: { type: ColorType.Solid, color: '#fdf6e3' }, textColor: '#586e75' },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { minimumWidth: 70 },
        timeScale: { borderColor: '#93a1a1', timeVisible: true, rightOffset: 10 },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
        autoSize: true,
      })
      chartInstanceRef.current = chart

      const candleSeries = chart.addCandlestickSeries({
        upColor: 'transparent', downColor: '#586e75',
        borderVisible: true,
        borderUpColor: '#586e75', borderDownColor: '#586e75',
        wickUpColor: '#586e75', wickDownColor: '#586e75',
      })
      candleSeries.setData(ohlc)

      // Pivots
      if (showPivots) {
        const rs = chart.addLineSeries({ color: 'transparent', priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1, lineVisible: false } as any)
        const ss = chart.addLineSeries({ color: 'transparent', priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1, lineVisible: false } as any)
        const rp: any[] = [], sp: any[] = []
        sorted.forEach((d, i) => {
          if (d.Resistance_Pivot != null && !d.Trend) rp.push({ time: times[i], value: Number(d.Resistance_Pivot), color: 'rgb(255, 50, 150)' })
          if (d.Support_Pivot != null && d.Trend) sp.push({ time: times[i], value: Number(d.Support_Pivot), color: 'rgb(50, 50, 255)' })
        })
        rs.setData(rp)
        ss.setData(sp)
      }

      // Targets
      if (showTargets) {
        const uT = sorted.filter(d => d.Upper_Target != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Upper_Target) }))
        const lT = sorted.filter(d => d.Lower_Target != null).map(d => ({ time: parseTime(d.Date), value: Number(d.Lower_Target) }))
        if (uT.length) chart.addLineSeries({ color: 'rgb(50, 50, 255)', lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false }).setData(uT)
        if (lT.length) chart.addLineSeries({ color: 'rgb(255, 50, 150)', lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false }).setData(lT)
      }

      // Dotted lines connecting entry to exit price per trade
      for (const t of visibleTrades) {
        if (t.entry_price == null || t.exit_price == null) continue
        const isWinner = (t.change ?? 0) > 0
        const color = isWinner ? 'rgb(50, 50, 255)' : 'rgb(255, 50, 150)'
        const s = chart.addLineSeries({
          color,
          lineWidth: 3,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
        })
        s.setData([
          { time: parseTime(t.entry_date), value: t.entry_price },
          { time: parseTime(t.exit_date), value: t.exit_price },
        ])
      }

      // Build entry + exit markers from visible trades
      const markers: any[] = []
      for (const t of visibleTrades) {
        markers.push({
          time: parseTime(t.entry_date),
          position: isLong ? 'belowBar' : 'aboveBar',
          color: isLong ? 'rgb(50, 50, 255)' : 'rgb(255, 50, 150)',
          shape: isLong ? 'arrowUp' : 'arrowDown',
          size: 2,
          text: '',
        })
        markers.push({
          time: parseTime(t.exit_date),
          position: isLong ? 'aboveBar' : 'belowBar',
          color: isLong ? 'rgb(255, 50, 150)' : 'rgb(50, 50, 255)',
          shape: isLong ? 'arrowDown' : 'arrowUp',
          size: 2,
          text: '',
        })
      }
      markers.sort((a, b) => a.time - b.time)
      candleSeries.setMarkers(markers)

      // Default view: 1yr centered on first visible trade (3mo before, 9mo after)
      if (visibleTrades.length > 0) {
        const firstEntry = new Date(visibleTrades[0].entry_date + 'T00:00:00Z').getTime()
        const from = new Date(firstEntry - 90 * 86400000)
        const to = new Date(firstEntry + 270 * 86400000)
        chart.timeScale().setVisibleRange({
          from: (Math.floor(from.getTime() / 1000)) as any,
          to: (Math.floor(to.getTime() / 1000)) as any,
        })
      } else {
        chart.timeScale().fitContent()
      }
    })

    return () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.remove()
        chartInstanceRef.current = null
      }
    }
  }, [resultTab, result, target, targetType, entrySignal, apiBase, showPivots, showTargets, chartTickers, chartTickerIdx])

  // Config mode
  if (!showResults) {
    return (
      <div className="backtest-panel">
        <div className="backtest-config">
          <div className="backtest-section">
            <label className="backtest-label">Entry Signal</label>
            <select className="backtest-select" value={entrySignal} onChange={e => setEntrySignal(e.target.value)}>
              {ENTRY_SIGNALS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <span className="backtest-hint">Exit: {EXIT_MAP[entrySignal]?.replace(/_/g, ' ')}</span>
          </div>

          {targetType === 'basket' && (
            <div className="backtest-section">
              <label className="backtest-label">Trade Source</label>
              <div className="backtest-pos-presets">
                <button className={`backtest-pos-preset ${!useConstituents ? 'active' : ''}`}
                  onClick={() => setUseConstituents(false)}>Basket Signal</button>
                <button className={`backtest-pos-preset ${useConstituents ? 'active' : ''}`}
                  onClick={() => setUseConstituents(true)}>Constituent Tickers</button>
              </div>
            </div>
          )}

          <div className="backtest-section">
            <label className="backtest-label">Position Sizing</label>
            <div className="backtest-filter-row">
              <span className="backtest-hint">Equity $</span>
              <input type="number" className="backtest-input" value={initialEquity}
                onChange={e => setInitialEquity(Number(e.target.value))} style={{ width: 100 }} />
              <span className="backtest-hint">Size %</span>
              <input type="number" className="backtest-input" value={positionSize}
                onChange={e => setPositionSize(Number(e.target.value))} style={{ width: 60 }} />
              <span className="backtest-hint">Max Lev %</span>
              <input type="number" className="backtest-input" value={maxLeverage}
                onChange={e => setMaxLeverage(Number(e.target.value))} style={{ width: 60 }} />
            </div>
            <div className="backtest-pos-presets">
              {POS_PRESETS.map(p => (
                <button key={p}
                  className={`backtest-pos-preset ${positionSize === p ? 'active' : ''}`}
                  onClick={() => setPositionSize(p)}>{p}%</button>
              ))}
            </div>
          </div>

          <div className="backtest-section">
            <label className="backtest-label">Regime Filters</label>
            {filters.map((f, i) => {
              const isBool = BOOL_METRICS.includes(f.metric)
              return (
                <div key={i} className="backtest-filter-row">
                  <select className="backtest-select" value={f.metric}
                    onChange={e => updateFilter(i, 'metric', e.target.value)}>
                    <optgroup label="Percentage">
                      {PCT_METRICS.map(m => <option key={m} value={m}>{m}</option>)}
                    </optgroup>
                    <optgroup label="Boolean">
                      {BOOL_METRICS.map(m => <option key={m} value={m}>{m}</option>)}
                    </optgroup>
                  </select>
                  <select className="backtest-select" value={f.condition}
                    onChange={e => updateFilter(i, 'condition', e.target.value)}>
                    {isBool ? (
                      <>
                        <option value="equals_true">= True</option>
                        <option value="equals_false">= False</option>
                      </>
                    ) : (
                      <>
                        <option value="above">Above</option>
                        <option value="below">Below</option>
                        <option value="increasing">Increasing</option>
                        <option value="decreasing">Decreasing</option>
                      </>
                    )}
                  </select>
                  {!isBool && f.condition !== 'increasing' && f.condition !== 'decreasing' && (
                    <input type="number" className="backtest-input" value={f.value}
                      onChange={e => updateFilter(i, 'value', e.target.value)} />
                  )}
                  {targetType === 'ticker' && (
                    <select className="backtest-select" value={f.source}
                      onChange={e => updateFilter(i, 'source', e.target.value)}>
                      <option value="self">Self</option>
                      {availableBaskets.map(b => <option key={b} value={b}>{b.replace(/_/g, ' ')}</option>)}
                    </select>
                  )}
                  <button className="backtest-remove-btn" onClick={() => removeFilter(i)}>X</button>
                </div>
              )
            })}
            <button className="control-btn" onClick={addFilter}>+ Add Filter</button>
          </div>

          <div className="backtest-section">
            <label className="backtest-label">Date Range</label>
            <div className="backtest-filter-row">
              <input type="date" className="backtest-input" value={startDate}
                min={dataRange?.min} max={endDate || dataRange?.max}
                onChange={e => setStartDate(e.target.value)} style={{ width: 130 }} />
              <span className="backtest-hint">to</span>
              <input type="date" className="backtest-input" value={endDate}
                min={startDate || dataRange?.min} max={dataRange?.max}
                onChange={e => setEndDate(e.target.value)} style={{ width: 130 }} />
            </div>
            {dataRange && (
              <span className="backtest-hint">Data: {dataRange.min} to {dataRange.max}</span>
            )}
          </div>

          <button className="control-btn primary" onClick={runBacktest} disabled={loading}>
            {loading ? 'Running...' : 'Run Backtest'}
          </button>
          {error && <div className="backtest-error">{error}</div>}
        </div>
      </div>
    )
  }

  // Results mode
  const stats = result!.stats

  const isMultiTicker = result?.trades.some(t => t.ticker) ?? false
  const tradeColumns: { key: TradeSortCol; label: string }[] = [
    ...(isMultiTicker ? [{ key: 'ticker' as TradeSortCol, label: 'Ticker' }] : []),
    { key: 'entry_date', label: 'Entry Date' },
    { key: 'exit_date', label: 'Exit Date' },
    { key: 'entry_price', label: 'Entry $' },
    { key: 'exit_price', label: 'Exit $' },
    { key: 'change', label: 'Change%' },
    { key: 'mfe', label: 'MFE' },
    { key: 'mae', label: 'MAE' },
    { key: 'bars_held', label: 'Bars' },
    { key: 'regime_pass', label: 'Filter' },
  ]

  const statRows: { label: string; filt: string; unfilt: string; filtColor?: string; unfiltColor?: string }[] = [
    { label: 'Trades', filt: String(stats.filtered.trades), unfilt: String(stats.unfiltered.trades) },
    { label: 'Win Rate', filt: pctFmt(stats.filtered.win_rate), unfilt: pctFmt(stats.unfiltered.win_rate) },
    { label: 'Avg Winner', filt: pctFmt(stats.filtered.avg_winner), unfilt: pctFmt(stats.unfiltered.avg_winner), filtColor: 'rgb(50,50,255)', unfiltColor: 'rgb(50,50,255)' },
    { label: 'Avg Loser', filt: pctFmt(stats.filtered.avg_loser), unfilt: pctFmt(stats.unfiltered.avg_loser), filtColor: 'rgb(255,50,150)', unfiltColor: 'rgb(255,50,150)' },
    { label: 'EV', filt: pctFmt(stats.filtered.ev), unfilt: pctFmt(stats.unfiltered.ev),
      filtColor: stats.filtered.ev >= 0 ? 'rgb(50,50,255)' : 'rgb(255,50,150)',
      unfiltColor: stats.unfiltered.ev >= 0 ? 'rgb(50,50,255)' : 'rgb(255,50,150)' },
    { label: 'PF', filt: stats.filtered.profit_factor.toFixed(2), unfilt: stats.unfiltered.profit_factor.toFixed(2) },
    { label: 'Max DD', filt: pctFmt(stats.filtered.max_dd), unfilt: pctFmt(stats.unfiltered.max_dd), filtColor: 'rgb(255,50,150)', unfiltColor: 'rgb(255,50,150)' },
    { label: 'Avg Bars', filt: stats.filtered.avg_bars.toFixed(1), unfilt: stats.unfiltered.avg_bars.toFixed(1) },
  ]

  return (
    <div className="backtest-panel">
      <div className="backtest-results-header">
        <button className="control-btn" onClick={() => setShowResults(false)}>Back</button>
        <span className="backtest-results-title">
          {target.replace(/_/g, ' ')}{isMultiTicker ? ' Tickers' : ''} -- {entrySignal.replace(/_/g, ' ')} Backtest
        </span>
        {result?.date_range && (
          <span className="backtest-hint">
            {result.date_range.min} to {result.date_range.max}
          </span>
        )}
      </div>

      {result?.blew_up && (
        <div className="backtest-blowup">
          BLEW UP on {result.blew_up.date} ({result.blew_up.equity} equity went to zero)
        </div>
      )}

      <div className="backtest-body">
        <div className="backtest-stats-sidebar">
          <table className="backtest-stats-table">
            <thead>
              <tr>
                <th className="backtest-stats-th"></th>
                <th className="backtest-stats-th">Filtered</th>
                <th className="backtest-stats-th">All</th>
              </tr>
            </thead>
            <tbody>
              {statRows.map(r => (
                <tr key={r.label}>
                  <td className="backtest-stats-td label">{r.label}</td>
                  <td className="backtest-stats-td" style={{ color: r.filtColor }}><b>{r.filt}</b></td>
                  <td className="backtest-stats-td" style={{ color: r.unfiltColor }}><b>{r.unfilt}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="backtest-main">
          <div className="summary-tabs">
            <button className={`summary-tab ${resultTab === 'equity' ? 'active' : ''}`} onClick={() => setResultTab('equity')}>Equity</button>
            <button className={`summary-tab ${resultTab === 'distribution' ? 'active' : ''}`} onClick={() => setResultTab('distribution')}>Distribution</button>
            <button className={`summary-tab ${resultTab === 'chart' ? 'active' : ''}`} onClick={() => setResultTab('chart')}>Chart</button>
            <button className={`summary-tab ${resultTab === 'path' ? 'active' : ''}`} onClick={() => setResultTab('path')}>Path</button>
            <button className={`summary-tab ${resultTab === 'trades' ? 'active' : ''}`} onClick={() => setResultTab('trades')}>Trades</button>
          </div>

          <div className="backtest-content">
            {resultTab === 'equity' ? (
              <>
                <div className="backtest-eq-toggles">
                  <button className={`summary-tab ${showFiltered ? 'active' : ''}`}
                    style={showFiltered ? { borderBottomColor: 'rgb(50,50,255)', color: 'rgb(50,50,255)' } : {}}
                    onClick={() => setShowFiltered(v => !v)}>Filtered</button>
                  <button className={`summary-tab ${showUnfiltered ? 'active' : ''}`}
                    style={showUnfiltered ? { borderBottomColor: '#adb5bd', color: '#586e75' } : {}}
                    onClick={() => setShowUnfiltered(v => !v)}>All</button>
                  <button className={`summary-tab ${showBuyHold ? 'active' : ''}`}
                    style={showBuyHold ? { borderBottomColor: '#859900', color: '#859900' } : {}}
                    onClick={() => setShowBuyHold(v => !v)}>Buy &amp; Hold</button>
                </div>
                <div className="backtest-chart" ref={containerRef}>
                  <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
                </div>
              </>
            ) : resultTab === 'chart' ? (
              <div className="backtest-chart" style={{ position: 'relative' }}>
                <div ref={priceChartRef} style={{ width: '100%', height: '100%' }} />
                {result && result.trades.length > 0 && (
                  <div className="backtest-chart-nav">
                    {chartTickers.length > 0 && (
                      <>
                        <button className="backtest-nav-btn" onClick={() => { setChartTickerIdx(i => Math.max(0, i - 1)); setTradeIndex(0) }} disabled={chartTickerIdx <= 0}>&larr;</button>
                        <select className="backtest-nav-select" value={chartTickerIdx}
                          onChange={e => { setChartTickerIdx(Number(e.target.value)); setTradeIndex(0) }}>
                          {chartTickers.map((tkr, i) => <option key={tkr} value={i}>{tkr}</option>)}
                        </select>
                        <button className="backtest-nav-btn" onClick={() => { setChartTickerIdx(i => Math.min(chartTickers.length - 1, i + 1)); setTradeIndex(0) }} disabled={chartTickerIdx >= chartTickers.length - 1}>&rarr;</button>
                        <span style={{ borderLeft: '1px solid var(--border-color)', height: 16, margin: '0 4px' }} />
                      </>
                    )}
                    {(() => {
                      const currentTkr = chartTickers.length > 0 ? chartTickers[Math.min(chartTickerIdx, chartTickers.length - 1)] : null
                      const tickerTrades = currentTkr ? result.trades.filter(t => t.ticker === currentTkr) : result.trades
                      const count = tickerTrades.length
                      return (
                        <>
                          <button className="backtest-nav-btn" onClick={() => navigateToTrade(tradeIndex - 1)} disabled={tradeIndex <= 0}>&larr;</button>
                          <select className="backtest-nav-select" value={tradeIndex}
                            onChange={e => navigateToTrade(Number(e.target.value))}>
                            {tickerTrades.map((t, i) => <option key={i} value={i}>{t.entry_date}</option>)}
                          </select>
                          <button className="backtest-nav-btn" onClick={() => navigateToTrade(tradeIndex + 1)} disabled={tradeIndex >= count - 1}>&rarr;</button>
                        </>
                      )
                    })()}
                  </div>
                )}
              </div>
            ) : resultTab === 'distribution' ? (
              <>
                <div className="backtest-hist-toggles">
                  {(['mae', 'change', 'mfe'] as HistMetric[]).map(m => (
                    <button key={m}
                      className={`summary-tab ${histVisible.has(m) ? 'active' : ''}`}
                      style={histVisible.has(m) ? { borderBottomColor: HIST_COLORS[m].stroke, color: HIST_COLORS[m].stroke } : {}}
                      onClick={() => setHistVisible(prev => {
                        const next = new Set(prev)
                        if (next.has(m)) next.delete(m); else next.add(m)
                        return next
                      })}>{HIST_COLORS[m].label}</button>
                  ))}
                </div>
                <div className="backtest-chart" ref={histContainerRef}>
                  <canvas ref={histCanvasRef} style={{ display: 'block', width: '100%', height: '100%' }}
                    onMouseMove={handleHistMouseMove} onMouseLeave={handleHistMouseLeave} />
                </div>
              </>
            ) : resultTab === 'path' ? (
              <div className="backtest-path-container">
                <div className="backtest-chart" ref={pathContainerRef}>
                  <canvas ref={pathCanvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
                </div>
                <div className="backtest-path-legend">
                  {(() => {
                    if (!result) return null
                    const pathRankColor = (rank: number, total: number): string => {
                      if (total <= 1) return 'rgb(50, 50, 255)'
                      const t = rank / (total - 1)
                      if (t <= 0.5) {
                        const s = t * 2
                        return `rgb(${Math.round(50 + 102 * s)}, 50, ${Math.round(255 - 53 * s)})`
                      } else {
                        const s = (t - 0.5) * 2
                        return `rgb(${Math.round(152 + 103 * s)}, 50, ${Math.round(202 - 52 * s)})`
                      }
                    }
                    const ranked = result.trades.map((t, i) => ({
                      t, i, ret: (result.trade_paths[i] ?? []).slice(-1)[0] ?? 0
                    })).sort((a, b) => b.ret - a.ret)
                    return ranked.map(({ t, i, ret }, rank) => (
                      <div key={i}
                        className={`returns-legend-item ${hoveredPath === i ? 'highlighted' : ''}`}
                        style={{ color: pathRankColor(rank, ranked.length) }}
                        onMouseEnter={() => setHoveredPath(i)}
                        onMouseLeave={() => setHoveredPath(null)}>
                        {t.ticker ? `${t.ticker} ` : ''}{t.entry_date.slice(2)} <span className="returns-legend-val">{(ret * 100).toFixed(1)}%</span>
                      </div>
                    ))
                  })()}
                </div>
              </div>
            ) : (
              <div className="summary-table-wrapper">
                <table className="summary-table">
                  <thead>
                    <tr>
                      {tradeColumns.map(col => (
                        <th key={col.key} className="summary-th" onClick={() => handleSort(col.key)} style={{ cursor: 'pointer' }}>
                          {col.label} {sortCol === col.key ? (sortAsc ? '\u25B2' : '\u25BC') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTrades.map((t, i) => {
                      const isWinner = t.change !== null && t.change > 0
                      const rowBg = isWinner ? 'rgba(50, 50, 255, 0.06)' : 'rgba(255, 50, 150, 0.06)'
                      return (
                        <tr key={i} style={{ backgroundColor: rowBg }}>
                          {isMultiTicker && <td className="summary-td" style={{ fontWeight: 'bold' }}>{t.ticker}</td>}
                          <td className="summary-td">{t.entry_date}</td>
                          <td className="summary-td">{t.exit_date}</td>
                          <td className="summary-td">{t.entry_price !== null ? '$' + t.entry_price.toFixed(2) : '--'}</td>
                          <td className="summary-td">{t.exit_price !== null ? '$' + t.exit_price.toFixed(2) : '--'}</td>
                          <td className="summary-td" style={{ color: isWinner ? 'rgb(50,50,255)' : 'rgb(255,50,150)', fontWeight: 'bold' }}>
                            {pctFmt(t.change)}
                          </td>
                          <td className="summary-td">{pctFmt(t.mfe)}</td>
                          <td className="summary-td">{pctFmt(t.mae)}</td>
                          <td className="summary-td">{t.bars_held}</td>
                          <td className="summary-td" style={{ color: t.regime_pass ? 'rgb(50,50,255)' : 'rgb(255,50,150)', fontWeight: 'bold' }}>
                            {t.regime_pass ? '\u2713' : '\u2717'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {sortedTrades.length === 0 && <div className="summary-empty">No trades found</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
