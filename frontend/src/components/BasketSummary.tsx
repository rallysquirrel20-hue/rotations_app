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
type TabType = 'breakout' | 'rotation' | 'btfd' | 'correlation' | 'returns'

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
    })
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

    const pad = { top: 20, right: 20, bottom: 50, left: 60 }
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
      ctx.fillStyle = '#6c757d'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'
      ctx.fillText((v * 100).toFixed(0) + '%', pad.left - 5, y + 3)
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
      let started = false
      s.values.forEach((v, i) => {
        if (v === null) return
        const x = xScale(i), y = yScale(v)
        if (!started) { ctx.moveTo(x, y); started = true }
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.globalAlpha = 1
    })
  }, [windowedData, dims, hoveredTicker, sortedSeries])

  return (
    <div className="returns-container">
      <div className="returns-legend-left">
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
      <div className="returns-right">
        <div className="analysis-date-controls">
          <input type="date" className="date-input" value={startDate} min={dateBoundsMin} max={dateBoundsMax} onChange={e => setStartDate(e.target.value)} />
          <span className="date-separator">to</span>
          <input type="date" className="date-input" value={endDate} min={dateBoundsMin} max={dateBoundsMax} onChange={e => setEndDate(e.target.value)} />
          <button className="control-btn" onClick={() => { setStartDate(defaultStart); setEndDate(defaultEnd) }}>Reset 1Y</button>
          <button className="control-btn" onClick={() => { setStartDate(dateBoundsMin); setEndDate(dateBoundsMax) }}>All</button>
        </div>
        <div className="returns-chart" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
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
      </div>
      <div className="summary-content">
        {tab === 'breakout' && <SignalsTable signals={breakoutSignals} />}
        {tab === 'rotation' && <SignalsTable signals={rotationSignals} />}
        {tab === 'btfd' && <SignalsTable signals={btfdSignals} />}
        {tab === 'correlation' && <CorrelationHeatmap data={data.correlation} basketName={basketName} apiBase={apiBase} />}
        {tab === 'returns' && <ReturnsChart data={data.cumulative_returns} />}
      </div>
    </div>
  )
}
