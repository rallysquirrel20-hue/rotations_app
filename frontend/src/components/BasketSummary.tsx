import { useState, useMemo, useRef, useEffect } from 'react'
import axios from 'axios'

interface OpenSignal {
  Ticker: string
  Signal_Type: string
  Entry_Date: string | null
  Close: number | null
  Entry_Price: number | null
  Current_Performance: number | null
  Win_Rate: number | null
  Avg_Winner: number | null
  Avg_Loser: number | null
  Avg_Winner_Bars: number | null
  Avg_Loser_Bars: number | null
  Avg_MFE: number | null
  Avg_MAE: number | null
  Std_Dev: number | null
  Historical_EV: number | null
  EV_Last_3: number | null
  Risk_Adj_EV: number | null
  Risk_Adj_EV_Last_3: number | null
  Count: number
  Is_Live?: boolean
}

interface CorrelationData {
  labels: string[]
  matrix: (number | null)[][]
  min_date?: string
  max_date?: string
}

interface CumulativeReturnsData {
  dates: string[]
  series: { ticker: string; values: (number | null)[]; join_date?: string | null }[]
}

interface BasketSummaryProps {
  data: {
    open_signals: OpenSignal[]
    correlation: CorrelationData
    cumulative_returns: CumulativeReturnsData
  } | null
  loading: boolean
  basketName: string
  apiBase: string
}

type SortKey = keyof OpenSignal
type TabType = 'breakout' | 'rotation' | 'btfd' | 'correlation' | 'returns' | 'contribution'

const SIGNAL_FILTERS: Record<'breakout' | 'rotation' | 'btfd', string[]> = {
  breakout: ['Breakout', 'Breakdown'],
  rotation: ['Up_Rot', 'Down_Rot'],
  btfd: ['BTFD', 'STFR'],
}
type CellValue = string | number | null

const COLORS = [
  '#2962ff', '#e91e63', '#00bcd4', '#ff9800', '#4caf50', '#9c27b0',
  '#f44336', '#3f51b5', '#009688', '#ff5722', '#607d8b', '#795548',
  '#8bc34a', '#ffc107', '#673ab7', '#03a9f4', '#cddc39', '#ff4081',
  '#00e676', '#ea80fc', '#1de9b6', '#ff6e40', '#76ff03', '#d500f9',
  '#64ffda', '#ffab40', '#b2ff59', '#e040fb',
]

function pctFmt(v: number | null): string {
  if (v === null) return '--'
  return (v * 100).toFixed(2) + '%'
}

function pctFmtCell(v: CellValue): string {
  return typeof v === 'number' ? pctFmt(v) : '--'
}

function colorForPerf(v: number | null): string {
  if (v === null) return '#6c757d'
  if (v > 0) return 'rgb(50, 50, 255)'
  if (v < 0) return 'rgb(255, 50, 150)'
  return '#6c757d'
}

function colorForPerfCell(v: CellValue): string {
  return typeof v === 'number' ? colorForPerf(v) : '#6c757d'
}

function dollarFmtCell(v: CellValue): string {
  return typeof v === 'number' ? '$' + v.toFixed(2) : '--'
}

function corrColor(v: number | null): string {
  if (v === null) return '#fdf6e3'
  // Blue (50,50,255) for positive, pink (255,50,150) for negative, white at 0
  const clamped = Math.max(-1, Math.min(1, v))
  const t = Math.abs(clamped)
  if (clamped >= 0) {
    return `rgb(${Math.round(255 - t * 205)}, ${Math.round(255 - t * 205)}, 255)`
  } else {
    return `rgb(255, ${Math.round(255 - t * 205)}, ${Math.round(255 - t * 105)})`
  }
}

const LIVE_ROW_COLORS: Record<string, string> = {
  Down_Rot: 'rgba(255, 50, 150, 0.12)',
  Up_Rot: 'rgba(50, 50, 255, 0.12)',
  BTFD: 'rgba(255, 50, 150, 0.12)',
  STFR: 'rgba(50, 50, 255, 0.12)',
  Breakdown: 'rgba(255, 50, 150, 0.12)',
  Breakout: 'rgba(50, 50, 255, 0.12)',
}

function SignalsTable({ signals }: { signals: OpenSignal[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('Ticker')
  const [sortAsc, setSortAsc] = useState(true)

  const sorted = useMemo(() => {
    const arr = [...signals]
    arr.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av)
      const an = av === null ? Number.NEGATIVE_INFINITY : Number(av)
      const bn = bv === null ? Number.NEGATIVE_INFINITY : Number(bv)
      return sortAsc ? an - bn : bn - an
    })
    return arr
  }, [signals, sortKey, sortAsc])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'Ticker' || key === 'Signal_Type') }
  }

  const columns: { key: SortKey; label: string; fmt?: (v: CellValue) => string; color?: (v: CellValue) => string }[] = [
    { key: 'Ticker', label: 'Ticker' },
    { key: 'Signal_Type', label: 'Signal' },
    { key: 'Entry_Date', label: 'Entry Date' },
    { key: 'Close', label: 'Close', fmt: dollarFmtCell },
    { key: 'Entry_Price', label: 'Entry', fmt: dollarFmtCell },
    { key: 'Current_Performance', label: 'Perf', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'Win_Rate', label: 'Win%', fmt: pctFmtCell },
    { key: 'Avg_Winner', label: 'Avg W', fmt: pctFmtCell },
    { key: 'Avg_Loser', label: 'Avg L', fmt: pctFmtCell },
    { key: 'Avg_Winner_Bars', label: 'W Bars' },
    { key: 'Avg_Loser_Bars', label: 'L Bars' },
    { key: 'Avg_MFE', label: 'MFE', fmt: pctFmtCell },
    { key: 'Avg_MAE', label: 'MAE', fmt: pctFmtCell },
    { key: 'Historical_EV', label: 'EV', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'EV_Last_3', label: 'EV L3', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'Risk_Adj_EV', label: 'R/A EV', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'Risk_Adj_EV_Last_3', label: 'R/A L3', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'Std_Dev', label: 'StdDev', fmt: pctFmtCell },
    { key: 'Count', label: 'Cnt' },
  ]

  return (
    <div className="summary-table-wrapper">
      <table className="summary-table">
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} onClick={() => handleSort(col.key)} className="summary-th">
                {col.label} {sortKey === col.key ? (sortAsc ? '\u25B2' : '\u25BC') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} className="summary-tr"
                style={row.Is_Live ? { backgroundColor: LIVE_ROW_COLORS[row.Signal_Type] || 'transparent' } : undefined}>
              {columns.map(col => {
                const val = row[col.key]
                const display = col.fmt ? col.fmt(val) : String(val)
                const color = col.color ? col.color(val) : undefined
                return (
                  <td key={col.key} className="summary-td" style={{ color }}>
                    {display}
                    {col.key === 'Signal_Type' && row.Is_Live && <span className="live-tag">LIVE</span>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <div className="summary-empty">No open signals for this basket</div>}
    </div>
  )
}

function CorrelationHeatmap({ data, basketName, apiBase }: { data: CorrelationData; basketName: string; apiBase: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 600, h: 400 })
  const [corrDate, setCorrDate] = useState('')
  const [liveData, setLiveData] = useState<CorrelationData | null>(null)
  const [dateBounds, setDateBounds] = useState<{ min: string; max: string }>({ min: '', max: '' })
  const [loading, setLoading] = useState(false)

  // Fetch date bounds on mount
  useEffect(() => {
    if (!basketName || !apiBase) return
    axios.get(`${apiBase}/baskets/${encodeURIComponent(basketName)}/correlation`)
      .then(res => {
        if (res.data.min_date && res.data.max_date) {
          setDateBounds({ min: res.data.min_date, max: res.data.max_date })
        }
      })
      .catch(() => {})
  }, [basketName, apiBase])

  // Fetch correlation for selected date
  useEffect(() => {
    if (!corrDate || !basketName || !apiBase) {
      setLiveData(null)
      return
    }
    setLoading(true)
    axios.get(`${apiBase}/baskets/${encodeURIComponent(basketName)}/correlation?date=${corrDate}`)
      .then(res => setLiveData(res.data))
      .catch(() => setLiveData(null))
      .finally(() => setLoading(false))
  }, [corrDate, basketName, apiBase])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setDims({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const active = liveData || data
  const { labels, matrix } = active

  if (!labels.length && !loading) return <div className="summary-empty">No correlation data</div>

  // Reserve space for row labels, header labels, and controls bar
  const controlBarHeight = 36
  const labelMargin = 60
  const legendHeight = 24
  const availW = dims.w - labelMargin
  const availH = dims.h - labelMargin - legendHeight - controlBarHeight
  const cellSize = labels.length ? Math.max(8, Math.min(40, Math.floor(Math.min(availW, availH) / labels.length))) : 20

  const showValues = cellSize >= 28

  return (
    <div className="corr-wrapper" ref={containerRef}>
      <div className="analysis-date-controls">
        <label className="analysis-date-label">As of:</label>
        <input
          type="date"
          className="date-input"
          value={corrDate}
          min={dateBounds.min}
          max={dateBounds.max}
          onChange={e => setCorrDate(e.target.value)}
        />
        {corrDate && <button className="control-btn" onClick={() => setCorrDate('')}>Reset</button>}
        {loading && <span className="analysis-loading-hint">Loading...</span>}
      </div>
      <div className="corr-scroll">
        <table className="corr-table" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th className="corr-corner"></th>
              {labels.map(l => (
                <th key={l} className="corr-header" style={{ width: cellSize, minWidth: cellSize }}>
                  <span className="corr-header-text">{l}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((rowLabel, ri) => (
              <tr key={rowLabel}>
                <td className="corr-row-label">{rowLabel}</td>
                {(matrix[ri] || []).map((val, ci) => (
                  <td key={ci} className="corr-cell"
                      style={{ backgroundColor: corrColor(val), width: cellSize, height: cellSize, fontSize: Math.max(8, cellSize * 0.35) }}
                      title={`${rowLabel} / ${labels[ci]}: ${val !== null ? val.toFixed(3) : 'N/A'}`}>
                    {showValues && val !== null ? val.toFixed(2) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="corr-legend">
        <span style={{ color: 'rgb(255, 50, 150)' }}>-1.0</span>
        <div className="corr-gradient"></div>
        <span style={{ color: 'rgb(50, 50, 255)' }}>+1.0</span>
      </div>
    </div>
  )
}

function ReturnsChart({ data }: { data: CumulativeReturnsData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredTicker, setHoveredTicker] = useState<string | null>(null)
  const [dims, setDims] = useState({ w: 800, h: 400 })
  const [presetMode, setPresetMode] = useState<'Q' | 'Y'>('Q')

  // Date range state — default to 1Y lookback
  const allDates = data.dates
  const defaultEnd = allDates.length > 0 ? allDates[allDates.length - 1] : ''
  const defaultStart = useMemo(() => {
    if (!allDates.length) return ''
    const end = new Date(allDates[allDates.length - 1])
    end.setFullYear(end.getFullYear() - 1)
    const target = end.toISOString().slice(0, 10)
    // Find the closest date in allDates that is >= target
    for (let i = 0; i < allDates.length; i++) {
      if (allDates[i] >= target) return allDates[i]
    }
    return allDates[0]
  }, [allDates])

  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Initialize defaults when data loads
  useEffect(() => {
    setStartDate(defaultStart)
    setEndDate(defaultEnd)
  }, [defaultStart, defaultEnd])

  const dateBoundsMin = allDates.length > 0 ? allDates[0] : ''
  const dateBoundsMax = allDates.length > 0 ? allDates[allDates.length - 1] : ''

  // Quarter presets — newest first
  const quarterPresets = useMemo(() => {
    if (!dateBoundsMin || !dateBoundsMax) return []
    const presets: { label: string; start: string; end: string }[] = []
    const minD = new Date(dateBoundsMin)
    const maxD = new Date(dateBoundsMax)
    let d = new Date(maxD)
    while (true) {
      const qMonth = Math.floor(d.getMonth() / 3) * 3
      const qStart = new Date(d.getFullYear(), qMonth, 1)
      const qEnd = new Date(d.getFullYear(), qMonth + 3, 0)
      if (qStart < minD && presets.length > 0) break
      const q = Math.floor(qMonth / 3) + 1
      presets.push({
        label: `${d.getFullYear()} Q${q}`,
        start: qStart.toISOString().slice(0, 10) < dateBoundsMin ? dateBoundsMin : qStart.toISOString().slice(0, 10),
        end: qEnd.toISOString().slice(0, 10) > dateBoundsMax ? dateBoundsMax : qEnd.toISOString().slice(0, 10),
      })
      d = new Date(qStart)
      d.setDate(d.getDate() - 1)
      if (d < minD) break
    }
    return presets
  }, [dateBoundsMin, dateBoundsMax])

  // Annual presets — newest first
  const annualPresets = useMemo(() => {
    if (!dateBoundsMin || !dateBoundsMax) return []
    const presets: { label: string; start: string; end: string }[] = []
    const minYear = new Date(dateBoundsMin).getFullYear()
    const maxYear = new Date(dateBoundsMax).getFullYear()
    for (let y = maxYear; y >= minYear; y--) {
      const yStart = `${y}-01-01` < dateBoundsMin ? dateBoundsMin : `${y}-01-01`
      const yEnd = `${y}-12-31` > dateBoundsMax ? dateBoundsMax : `${y}-12-31`
      presets.push({ label: `${y}`, start: yStart, end: yEnd })
    }
    return presets
  }, [dateBoundsMin, dateBoundsMax])

  const activePresets = presetMode === 'Q' ? quarterPresets : annualPresets

  // Slice data to selected date range and re-rebase to window start
  const windowedData = useMemo(() => {
    if (!allDates.length || !startDate || !endDate) return { dates: allDates, series: data.series }
    let si = 0, ei = allDates.length - 1
    for (let i = 0; i < allDates.length; i++) {
      if (allDates[i] >= startDate) { si = i; break }
    }
    for (let i = allDates.length - 1; i >= 0; i--) {
      if (allDates[i] <= endDate) { ei = i; break }
    }
    if (si > ei) return { dates: [], series: [] }
    const slicedDates = allDates.slice(si, ei + 1)
    const slicedSeries = data.series.map(s => {
      const vals = s.values.slice(si, ei + 1)
      // Find first non-null value in window to rebase from (0% at window start or join date)
      let baseVal: number | null = null
      for (let i = 0; i < vals.length; i++) {
        if (vals[i] !== null) { baseVal = vals[i]!; break }
      }
      if (baseVal === null || baseVal === 0) return { ...s, values: vals }
      // Rebase: convert from join-date-relative to window-start-relative
      const rebased = vals.map(v => {
        if (v === null) return null
        return (1 + v) / (1 + baseVal!) - 1
      })
      return { ...s, values: rebased }
    }).filter(s => s.values.some(v => v !== null))
    return { dates: slicedDates, series: slicedSeries }
  }, [allDates, data.series, startDate, endDate])

  // Sort series by latest return value in the windowed range
  const sortedSeries = useMemo(() => {
    const withLatest = windowedData.series.map((s, origIndex) => {
      let lastVal = 0
      for (let i = s.values.length - 1; i >= 0; i--) {
        if (s.values[i] !== null) { lastVal = s.values[i]!; break }
      }
      return { ...s, origIndex, lastVal }
    })
    withLatest.sort((a, b) => b.lastVal - a.lastVal)
    return withLatest
  }, [windowedData.series])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setDims({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !windowedData.dates.length || !windowedData.series.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = dims.w * dpr
    canvas.height = dims.h * dpr
    ctx.scale(dpr, dpr)

    const pad = { top: 20, right: 60, bottom: 50, left: 20 }
    const plotW = dims.w - pad.left - pad.right
    const plotH = dims.h - pad.top - pad.bottom

    // Find Y range from windowed data
    let yMin = 0, yMax = 0
    windowedData.series.forEach(s => s.values.forEach(v => {
      if (v !== null) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v) }
    }))
    const yPad = (yMax - yMin) * 0.1 || 0.05
    yMin -= yPad; yMax += yPad

    const numDates = windowedData.dates.length
    const xScale = (i: number) => pad.left + (numDates > 1 ? (i / (numDates - 1)) * plotW : plotW / 2)
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
      ctx.fillStyle = '#6c757d'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'
      ctx.fillText((v * 100).toFixed(0) + '%', dims.w - pad.right + 5, y + 3)
    }

    // Zero line
    const zeroY = yScale(0)
    ctx.strokeStyle = '#adb5bd'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(dims.w - pad.right, zeroY); ctx.stroke()
    ctx.setLineDash([])

    // X axis labels
    const labelInterval = Math.max(1, Math.floor(numDates / 8))
    ctx.fillStyle = '#6c757d'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'
    for (let i = 0; i < numDates; i += labelInterval) {
      const x = xScale(i)
      ctx.fillText(windowedData.dates[i].slice(0, 7), x, dims.h - pad.bottom + 15)
    }

    // Draw lines (use origIndex for consistent color mapping)
    sortedSeries.forEach(s => {
      const isHovered = hoveredTicker === s.ticker
      const isOther = hoveredTicker !== null && !isHovered
      ctx.strokeStyle = isOther ? '#dee2e6' : COLORS[s.origIndex % COLORS.length]
      ctx.lineWidth = isHovered ? 2.5 : 1.2
      ctx.globalAlpha = isOther ? 0.3 : 1
      ctx.beginPath()
      let inSegment = false
      s.values.forEach((v, i) => {
        if (v === null) { inSegment = false; return }
        const x = xScale(i), y = yScale(v)
        if (!inSegment) { ctx.moveTo(x, y); inSegment = true }
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.globalAlpha = 1
    })
  }, [windowedData, dims, hoveredTicker, sortedSeries])

  return (
    <div className="returns-container">
      <div className="returns-legend-left contrib-sidebar">
        <div className="returns-date-controls">
          <input type="date" className="date-input" value={startDate} min={dateBoundsMin} max={dateBoundsMax} onChange={e => setStartDate(e.target.value)} />
          <input type="date" className="date-input" value={endDate} min={dateBoundsMin} max={dateBoundsMax} onChange={e => setEndDate(e.target.value)} />
          <div className="returns-quick-btns">
            <button className="control-btn" onClick={() => { setStartDate(defaultStart); setEndDate(defaultEnd) }}>1Y</button>
            <button className="control-btn" onClick={() => { setStartDate(dateBoundsMin); setEndDate(dateBoundsMax) }}>All</button>
          </div>
        </div>
        <div className="contrib-preset-toggle">
          <button className={`contrib-toggle-btn ${presetMode === 'Q' ? 'active' : ''}`} onClick={() => setPresetMode('Q')}>Q</button>
          <button className={`contrib-toggle-btn ${presetMode === 'Y' ? 'active' : ''}`} onClick={() => setPresetMode('Y')}>Y</button>
        </div>
        <div className="contrib-quarter-presets">
          {activePresets.map(p => (
            <button
              key={p.label}
              className={`contrib-quarter-btn ${startDate === p.start && endDate === p.end ? 'active' : ''}`}
              onClick={() => { setStartDate(p.start); setEndDate(p.end) }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="returns-right">
        <div className="returns-chart" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
      <div className="returns-legend-right">
        {sortedSeries.map(s => (
          <div key={s.ticker}
               className={`returns-legend-item ${hoveredTicker === s.ticker ? 'highlighted' : ''}`}
               style={{ color: COLORS[s.origIndex % COLORS.length] }}
               onMouseEnter={() => setHoveredTicker(s.ticker)}
               onMouseLeave={() => setHoveredTicker(null)}>
            {s.ticker} <span className="returns-legend-val">{(s.lastVal * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface ContributionData {
  tickers: string[]
  total_contributions: number[]
  initial_weights: number[]
  final_weights: number[]
  first_dates: string[]
  last_dates: string[]
  current_weights: (number | null)[]
  equity_dates: string[]
  equity_values: number[]
  dates: string[]
  date_range: { min: string; max: string }
}

function ContributionChart({ basketName, apiBase }: { basketName: string; apiBase: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 800, h: 400 })
  const [contribData, setContribData] = useState<ContributionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [dateBounds, setDateBounds] = useState<{ min: string; max: string }>({ min: '', max: '' })
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [presetMode, setPresetMode] = useState<'Q' | 'Y'>('Q')

  // Fetch date bounds on mount
  useEffect(() => {
    if (!basketName || !apiBase) return
    axios.get(`${apiBase}/baskets/${encodeURIComponent(basketName)}/contributions`)
      .then(res => {
        if (res.data.date_range) {
          setDateBounds(res.data.date_range)
          // Default to current quarter
          const max = res.data.date_range.max
          if (max) {
            const d = new Date(max)
            const qMonth = Math.floor(d.getMonth() / 3) * 3
            const qStart = new Date(d.getFullYear(), qMonth, 1).toISOString().slice(0, 10)
            setStartDate(qStart)
            setEndDate(max)
          }
        }
      })
      .catch(() => {})
  }, [basketName, apiBase])

  // Fetch contribution data when date range changes
  useEffect(() => {
    if (!basketName || !apiBase || !startDate || !endDate) return
    setLoading(true)
    const params = new URLSearchParams()
    if (startDate) params.set('start', startDate)
    if (endDate) params.set('end', endDate)
    axios.get(`${apiBase}/baskets/${encodeURIComponent(basketName)}/contributions?${params}`)
      .then(res => setContribData(res.data))
      .catch(() => setContribData(null))
      .finally(() => setLoading(false))
  }, [basketName, apiBase, startDate, endDate])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setDims({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Quarter presets — all quarters, newest first
  const quarterPresets = useMemo(() => {
    if (!dateBounds.min || !dateBounds.max) return []
    const presets: { label: string; start: string; end: string }[] = []
    const minD = new Date(dateBounds.min)
    const maxD = new Date(dateBounds.max)
    let d = new Date(maxD)
    while (true) {
      const qMonth = Math.floor(d.getMonth() / 3) * 3
      const qStart = new Date(d.getFullYear(), qMonth, 1)
      const qEnd = new Date(d.getFullYear(), qMonth + 3, 0)
      if (qStart < minD && presets.length > 0) break
      const q = Math.floor(qMonth / 3) + 1
      presets.push({
        label: `${d.getFullYear()} Q${q}`,
        start: qStart.toISOString().slice(0, 10) < dateBounds.min ? dateBounds.min : qStart.toISOString().slice(0, 10),
        end: qEnd.toISOString().slice(0, 10) > dateBounds.max ? dateBounds.max : qEnd.toISOString().slice(0, 10),
      })
      d = new Date(qStart)
      d.setDate(d.getDate() - 1)
      if (d < minD) break
    }
    return presets
  }, [dateBounds])

  // Annual presets — newest first
  const annualPresets = useMemo(() => {
    if (!dateBounds.min || !dateBounds.max) return []
    const presets: { label: string; start: string; end: string }[] = []
    const minYear = new Date(dateBounds.min).getFullYear()
    const maxYear = new Date(dateBounds.max).getFullYear()
    for (let y = maxYear; y >= minYear; y--) {
      const yStart = `${y}-01-01` < dateBounds.min ? dateBounds.min : `${y}-01-01`
      const yEnd = `${y}-12-31` > dateBounds.max ? dateBounds.max : `${y}-12-31`
      presets.push({ label: `${y}`, start: yStart, end: yEnd })
    }
    return presets
  }, [dateBounds])

  const activePresets = presetMode === 'Q' ? quarterPresets : annualPresets

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !contribData || !contribData.tickers.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = dims.w * dpr
    canvas.height = dims.h * dpr
    ctx.scale(dpr, dpr)

    const { tickers, total_contributions, equity_dates, equity_values } = contribData
    const n = tickers.length
    const pad = { top: 12, right: 50, bottom: 80, left: 60 }
    const totalH = dims.h - pad.top - pad.bottom
    const hasEquity = equity_dates && equity_dates.length > 1
    const eqH = hasEquity ? Math.floor(totalH * 0.25) : 0
    const sepGap = hasEquity ? 10 : 0
    const barPlotH = totalH - eqH - sepGap

    ctx.clearRect(0, 0, dims.w, dims.h)
    ctx.fillStyle = '#fdf6e3'
    ctx.fillRect(0, 0, dims.w, dims.h)

    const plotW = dims.w - pad.left - pad.right

    // === Equity curve as % return area chart (top region) ===
    if (hasEquity) {
      const eqBot = pad.top + eqH
      // Convert cumulative equity to % return (starts at 0%)
      const pctReturns = equity_values.map(v => (v - 1) * 100)
      let eqMin = 0, eqMax = 0
      pctReturns.forEach(v => { eqMin = Math.min(eqMin, v); eqMax = Math.max(eqMax, v) })
      const eqRange = eqMax - eqMin || 1
      const eqPad = eqRange * 0.1
      eqMin -= eqPad; eqMax += eqPad
      const eqYScale = (v: number) => eqBot - ((v - eqMin) / (eqMax - eqMin)) * eqH
      const zeroEqY = eqYScale(0)

      // Compute x positions once
      const pts = pctReturns.map((v, i) => ({
        x: pad.left + (i / (pctReturns.length - 1)) * plotW,
        y: eqYScale(v),
        v,
      }))

      // Fill positive area (blue) — clip above zero line
      ctx.save()
      ctx.beginPath()
      ctx.rect(pad.left, pad.top, plotW, zeroEqY - pad.top)
      ctx.clip()
      ctx.fillStyle = 'rgba(50, 50, 255, 0.18)'
      ctx.beginPath()
      ctx.moveTo(pts[0].x, zeroEqY)
      pts.forEach(p => ctx.lineTo(p.x, p.y))
      ctx.lineTo(pts[pts.length - 1].x, zeroEqY)
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      // Fill negative area (pink) — clip below zero line
      ctx.save()
      ctx.beginPath()
      ctx.rect(pad.left, zeroEqY, plotW, eqBot - zeroEqY)
      ctx.clip()
      ctx.fillStyle = 'rgba(255, 50, 150, 0.18)'
      ctx.beginPath()
      ctx.moveTo(pts[0].x, zeroEqY)
      pts.forEach(p => ctx.lineTo(p.x, p.y))
      ctx.lineTo(pts[pts.length - 1].x, zeroEqY)
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      // Zero line
      ctx.strokeStyle = '#adb5bd'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(pad.left, zeroEqY); ctx.lineTo(dims.w - pad.right, zeroEqY); ctx.stroke()
      ctx.setLineDash([])

      // Grid lines + right Y-axis labels
      ctx.strokeStyle = '#e9ecef'; ctx.lineWidth = 1
      const eqTicks = 3
      for (let i = 0; i <= eqTicks; i++) {
        const v = eqMin + (eqMax - eqMin) * (i / eqTicks)
        const y = eqYScale(v)
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(dims.w - pad.right, y); ctx.stroke()
        ctx.fillStyle = '#6c757d'; ctx.font = '9px monospace'; ctx.textAlign = 'left'
        ctx.fillText(v.toFixed(1) + '%', dims.w - pad.right + 4, y + 3)
      }

      // Equity line — colored by sign: blue above zero, pink below
      ctx.lineWidth = 1.5
      for (let i = 1; i < pts.length; i++) {
        const endVal = pts[i].v
        ctx.strokeStyle = endVal >= 0 ? 'rgb(50, 50, 255)' : 'rgb(255, 50, 150)'
        ctx.beginPath()
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y)
        ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
      }

      // X-axis date labels for equity curve (show ~5 evenly spaced)
      const nLabels = Math.min(5, equity_dates.length)
      ctx.fillStyle = '#93a1a1'; ctx.font = '8px monospace'; ctx.textAlign = 'center'
      for (let i = 0; i < nLabels; i++) {
        const idx = Math.round(i * (equity_dates.length - 1) / (nLabels - 1))
        const x = pad.left + (idx / (equity_dates.length - 1)) * plotW
        ctx.fillText(equity_dates[idx].slice(5), x, eqBot + 9)
      }

      // Separator line
      ctx.strokeStyle = '#adb5bd'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(pad.left, eqBot + sepGap / 2); ctx.lineTo(dims.w - pad.right, eqBot + sepGap / 2); ctx.stroke()
      ctx.setLineDash([])
    }

    // === Bar chart (bottom region) ===
    const barTop = pad.top + eqH + sepGap
    const barW = Math.max(4, Math.min(40, (plotW / n) * 0.75))
    const gap = (plotW - barW * n) / (n + 1)

    let yMin = 0, yMax = 0
    total_contributions.forEach(v => { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v) })
    const yPad = (yMax - yMin) * 0.1 || 0.005
    yMin -= yPad; yMax += yPad

    const yScale = (v: number) => barTop + barPlotH - ((v - yMin) / (yMax - yMin)) * barPlotH
    const zeroY = yScale(0)

    // Grid
    ctx.strokeStyle = '#e9ecef'
    ctx.lineWidth = 1
    const nTicks = 6
    for (let i = 0; i <= nTicks; i++) {
      const v = yMin + (yMax - yMin) * (i / nTicks)
      const y = yScale(v)
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(dims.w - pad.right, y); ctx.stroke()
      ctx.fillStyle = '#6c757d'; ctx.font = '10px monospace'; ctx.textAlign = 'right'
      ctx.fillText((v * 100).toFixed(2) + '%', pad.left - 5, y + 3)
    }

    // Zero line
    ctx.strokeStyle = '#adb5bd'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(dims.w - pad.right, zeroY); ctx.stroke()
    ctx.setLineDash([])

    // Bars — sorted worst to best (data already sorted by backend)
    for (let i = 0; i < n; i++) {
      const x = pad.left + gap + i * (barW + gap)
      const val = total_contributions[i]
      const bTop = val >= 0 ? yScale(val) : zeroY
      const bBot = val >= 0 ? zeroY : yScale(val)
      const barHeight = Math.max(1, bBot - bTop)

      const isHovered = hoveredIdx === i
      if (val >= 0) {
        ctx.fillStyle = isHovered ? 'rgb(30, 30, 220)' : 'rgb(50, 50, 255)'
      } else {
        ctx.fillStyle = isHovered ? 'rgb(220, 30, 120)' : 'rgb(255, 50, 150)'
      }
      ctx.fillRect(x, bTop, barW, barHeight)
    }

    // X axis labels (angled tickers)
    ctx.save()
    ctx.fillStyle = '#586e75'
    ctx.font = `${Math.min(11, Math.max(8, barW * 0.8))}px monospace`
    ctx.textAlign = 'right'
    for (let i = 0; i < n; i++) {
      const x = pad.left + gap + i * (barW + gap) + barW / 2
      ctx.save()
      ctx.translate(x, dims.h - pad.bottom + 8)
      ctx.rotate(-Math.PI / 4)
      ctx.fillText(tickers[i], 0, 0)
      ctx.restore()
    }
    ctx.restore()

  }, [contribData, dims, hoveredIdx])

  // Mouse hover detection
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!contribData || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const n = contribData.tickers.length
    const pad = { left: 60, right: 20 }
    const plotW = dims.w - pad.left - pad.right
    const barW = Math.max(4, Math.min(40, (plotW / n) * 0.75))
    const gap = (plotW - barW * n) / (n + 1)

    let found = -1
    for (let i = 0; i < n; i++) {
      const x = pad.left + gap + i * (barW + gap)
      if (mx >= x && mx <= x + barW) { found = i; break }
    }
    setHoveredIdx(found >= 0 ? found : null)
  }

  const hovered = hoveredIdx !== null && contribData ? {
    ticker: contribData.tickers[hoveredIdx],
    contribution: contribData.total_contributions[hoveredIdx],
    initialW: contribData.initial_weights[hoveredIdx],
    finalW: contribData.final_weights[hoveredIdx],
    firstDate: contribData.first_dates?.[hoveredIdx] ?? null,
    lastDate: contribData.last_dates?.[hoveredIdx] ?? null,
    currentWeight: contribData.current_weights?.[hoveredIdx] ?? null,
  } : null

  return (
    <div className="returns-container">
      <div className="returns-legend-left contrib-sidebar">
        <div className="contrib-legend-header">
          {hovered ? (
            <>
              <div className="contrib-detail-ticker">{hovered.ticker}</div>
              <div className="contrib-detail-row">
                <span>Contrib:</span>
                <span style={{ color: hovered.contribution >= 0 ? 'rgb(50, 50, 255)' : 'rgb(255, 50, 150)' }}>
                  {(hovered.contribution * 100).toFixed(2)}%
                </span>
              </div>
              <div className="contrib-detail-row">
                <span>Init W:</span>
                <span>{(hovered.initialW * 100).toFixed(2)}%</span>
              </div>
              <div className="contrib-detail-row">
                <span>Final W:</span>
                <span>{(hovered.finalW * 100).toFixed(2)}%</span>
              </div>
              <div className="contrib-detail-row">
                <span>Drift:</span>
                <span style={{ color: hovered.finalW - hovered.initialW >= 0 ? 'rgb(50, 50, 255)' : 'rgb(255, 50, 150)' }}>
                  {((hovered.finalW - hovered.initialW) * 100).toFixed(2)}%
                </span>
              </div>
              {hovered.firstDate && (
                <div className="contrib-detail-row">
                  <span>Entry:</span>
                  <span>{hovered.firstDate}</span>
                </div>
              )}
              {hovered.lastDate && (
                <div className="contrib-detail-row">
                  <span>Exit:</span>
                  <span>{hovered.currentWeight !== null ? 'Active' : hovered.lastDate}</span>
                </div>
              )}
              {hovered.currentWeight !== null && (
                <div className="contrib-detail-row">
                  <span>Cur W:</span>
                  <span>{(hovered.currentWeight * 100).toFixed(2)}%</span>
                </div>
              )}
            </>
          ) : (
            <div className="contrib-hint">Hover a bar for details</div>
          )}
        </div>
        <div className="contrib-preset-toggle">
          <button className={`contrib-toggle-btn ${presetMode === 'Q' ? 'active' : ''}`} onClick={() => setPresetMode('Q')}>Q</button>
          <button className={`contrib-toggle-btn ${presetMode === 'Y' ? 'active' : ''}`} onClick={() => setPresetMode('Y')}>Y</button>
        </div>
        <div className="contrib-quarter-presets">
          {activePresets.map(p => (
            <button
              key={p.label}
              className={`contrib-quarter-btn ${startDate === p.start && endDate === p.end ? 'active' : ''}`}
              onClick={() => { setStartDate(p.start); setEndDate(p.end) }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="returns-right">
        <div className="analysis-date-controls">
          <input type="date" className="date-input" value={startDate} min={dateBounds.min} max={dateBounds.max} onChange={e => setStartDate(e.target.value)} />
          <span className="date-separator">to</span>
          <input type="date" className="date-input" value={endDate} min={dateBounds.min} max={dateBounds.max} onChange={e => setEndDate(e.target.value)} />
          {loading && <span className="analysis-loading-hint">Loading...</span>}
        </div>
        <div className="returns-chart" ref={containerRef}>
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%' }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoveredIdx(null)}
          />
        </div>
      </div>
    </div>
  )
}

export function BasketSummary({ data, loading, basketName, apiBase }: BasketSummaryProps) {
  const [tab, setTab] = useState<TabType>('breakout')

  if (loading) return <div className="summary-panel"><div className="summary-loading">Loading basket analysis...</div></div>
  if (!data) return <div className="summary-panel"><div className="summary-empty">No summary data</div></div>

  const filterSignals = (key: 'breakout' | 'rotation' | 'btfd') =>
    data.open_signals.filter(s => SIGNAL_FILTERS[key].includes(s.Signal_Type))

  const breakoutSignals = filterSignals('breakout')
  const rotationSignals = filterSignals('rotation')
  const btfdSignals = filterSignals('btfd')

  return (
    <div className="summary-panel">
      <div className="summary-tabs">
        <button className={`summary-tab ${tab === 'breakout' ? 'active' : ''}`} onClick={() => setTab('breakout')}>
          LT Trend ({breakoutSignals.length})
        </button>
        <button className={`summary-tab ${tab === 'rotation' ? 'active' : ''}`} onClick={() => setTab('rotation')}>
          ST Trend ({rotationSignals.length})
        </button>
        <button className={`summary-tab ${tab === 'btfd' ? 'active' : ''}`} onClick={() => setTab('btfd')}>
          BTFD/STFR ({btfdSignals.length})
        </button>
        <button className={`summary-tab ${tab === 'correlation' ? 'active' : ''}`} onClick={() => setTab('correlation')}>
          Correlation
        </button>
        <button className={`summary-tab ${tab === 'returns' ? 'active' : ''}`} onClick={() => setTab('returns')}>
          Returns
        </button>
        <button className={`summary-tab ${tab === 'contribution' ? 'active' : ''}`} onClick={() => setTab('contribution')}>
          Contribution
        </button>
      </div>
      <div className="summary-content">
        {tab === 'breakout' && <SignalsTable signals={breakoutSignals} />}
        {tab === 'rotation' && <SignalsTable signals={rotationSignals} />}
        {tab === 'btfd' && <SignalsTable signals={btfdSignals} />}
        {tab === 'correlation' && <CorrelationHeatmap data={data.correlation} basketName={basketName} apiBase={apiBase} />}
        {tab === 'returns' && <ReturnsChart data={data.cumulative_returns} />}
        {tab === 'contribution' && <ContributionChart basketName={basketName} apiBase={apiBase} />}
      </div>
    </div>
  )
}
