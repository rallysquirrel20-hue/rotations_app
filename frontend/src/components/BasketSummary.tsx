import { useState, useMemo, useRef, useEffect } from 'react'

interface OpenSignal {
  Ticker: string
  Signal_Type: string
  Close: number | null
  Current_Performance: number | null
  Entry_Price: number | null
  Win_Rate: number | null
  Historical_EV: number | null
  Risk_Adj_EV: number | null
  Avg_Winner: number | null
  Avg_Loser: number | null
  Count: number
}

interface CorrelationData {
  labels: string[]
  matrix: (number | null)[][]
}

interface CumulativeReturnsData {
  dates: string[]
  series: { ticker: string; values: (number | null)[] }[]
}

interface BasketSummaryProps {
  data: {
    open_signals: OpenSignal[]
    correlation: CorrelationData
    cumulative_returns: CumulativeReturnsData
  } | null
  loading: boolean
}

type SortKey = keyof OpenSignal
type TabType = 'signals' | 'correlation' | 'returns'
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
  if (v > 0) return '#16a34a'
  if (v < 0) return '#dc2626'
  return '#6c757d'
}

function colorForPerfCell(v: CellValue): string {
  return typeof v === 'number' ? colorForPerf(v) : '#6c757d'
}

function dollarFmtCell(v: CellValue): string {
  return typeof v === 'number' ? '$' + v.toFixed(2) : '--'
}

function corrColor(v: number | null): string {
  if (v === null) return '#f8f9fa'
  // Blue for positive, red for negative, white at 0
  const clamped = Math.max(-1, Math.min(1, v))
  if (clamped >= 0) {
    const intensity = Math.round(clamped * 200)
    return `rgb(${255 - intensity}, ${255 - intensity * 0.3}, 255)`
  } else {
    const intensity = Math.round(-clamped * 200)
    return `rgb(255, ${255 - intensity * 0.5}, ${255 - intensity})`
  }
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
    { key: 'Signal_Type', label: 'Signal Type' },
    { key: 'Close', label: 'Close', fmt: dollarFmtCell },
    { key: 'Current_Performance', label: 'Current Perf', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'Entry_Price', label: 'Entry Price', fmt: dollarFmtCell },
    { key: 'Win_Rate', label: 'Win Rate', fmt: pctFmtCell },
    { key: 'Historical_EV', label: 'Hist EV', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'Risk_Adj_EV', label: 'Risk Adj EV', fmt: pctFmtCell, color: colorForPerfCell },
    { key: 'Avg_Winner', label: 'Avg Winner', fmt: pctFmtCell },
    { key: 'Avg_Loser', label: 'Avg Loser', fmt: pctFmtCell },
    { key: 'Count', label: 'Count' },
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
            <tr key={i} className="summary-tr">
              {columns.map(col => {
                const val = row[col.key]
                const display = col.fmt ? col.fmt(val) : String(val)
                const color = col.color ? col.color(val) : undefined
                return (
                  <td key={col.key} className="summary-td" style={{ color }}>
                    {display}
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

function CorrelationHeatmap({ data }: { data: CorrelationData }) {
  const { labels, matrix } = data
  if (!labels.length) return <div className="summary-empty">No correlation data</div>

  const cellSize = Math.max(20, Math.min(40, 600 / labels.length))

  return (
    <div className="corr-wrapper">
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
                      style={{ backgroundColor: corrColor(val), width: cellSize, height: cellSize }}
                      title={`${rowLabel} / ${labels[ci]}: ${val !== null ? val.toFixed(3) : 'N/A'}`}>
                    {labels.length <= 15 && val !== null ? val.toFixed(2) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="corr-legend">
        <span style={{ color: '#dc2626' }}>-1.0</span>
        <div className="corr-gradient"></div>
        <span style={{ color: '#2962ff' }}>+1.0</span>
      </div>
    </div>
  )
}

function ReturnsChart({ data }: { data: CumulativeReturnsData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredTicker, setHoveredTicker] = useState<string | null>(null)
  const [dims, setDims] = useState({ w: 800, h: 400 })

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
    if (!canvas || !data.dates.length || !data.series.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = dims.w * dpr
    canvas.height = dims.h * dpr
    ctx.scale(dpr, dpr)

    const pad = { top: 20, right: 20, bottom: 50, left: 60 }
    const plotW = dims.w - pad.left - pad.right
    const plotH = dims.h - pad.top - pad.bottom

    // Find Y range
    let yMin = 0, yMax = 0
    data.series.forEach(s => s.values.forEach(v => {
      if (v !== null) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v) }
    }))
    const yPad = (yMax - yMin) * 0.1 || 0.05
    yMin -= yPad; yMax += yPad

    const xScale = (i: number) => pad.left + (i / (data.dates.length - 1)) * plotW
    const yScale = (v: number) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH

    ctx.clearRect(0, 0, dims.w, dims.h)
    ctx.fillStyle = '#ffffff'
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
    const labelInterval = Math.max(1, Math.floor(data.dates.length / 8))
    ctx.fillStyle = '#6c757d'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'
    for (let i = 0; i < data.dates.length; i += labelInterval) {
      const x = xScale(i)
      ctx.fillText(data.dates[i].slice(0, 7), x, dims.h - pad.bottom + 15)
    }

    // Draw lines
    data.series.forEach((s, si) => {
      const isHovered = hoveredTicker === s.ticker
      const isOther = hoveredTicker !== null && !isHovered
      ctx.strokeStyle = isOther ? '#dee2e6' : COLORS[si % COLORS.length]
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
  }, [data, dims, hoveredTicker])

  return (
    <div className="returns-container">
      <div className="returns-chart" ref={containerRef}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      </div>
      <div className="returns-legend">
        {data.series.map((s, i) => (
          <span key={s.ticker} className={`returns-legend-item ${hoveredTicker === s.ticker ? 'highlighted' : ''}`}
                style={{ color: COLORS[i % COLORS.length] }}
                onMouseEnter={() => setHoveredTicker(s.ticker)}
                onMouseLeave={() => setHoveredTicker(null)}>
            {s.ticker}
          </span>
        ))}
      </div>
    </div>
  )
}

export function BasketSummary({ data, loading }: BasketSummaryProps) {
  const [tab, setTab] = useState<TabType>('signals')

  if (loading) return <div className="summary-panel"><div className="summary-loading">Loading summary...</div></div>
  if (!data) return <div className="summary-panel"><div className="summary-empty">No summary data</div></div>

  return (
    <div className="summary-panel">
      <div className="summary-tabs">
        <button className={`summary-tab ${tab === 'signals' ? 'active' : ''}`} onClick={() => setTab('signals')}>
          Signals ({data.open_signals.length})
        </button>
        <button className={`summary-tab ${tab === 'correlation' ? 'active' : ''}`} onClick={() => setTab('correlation')}>
          Correlation
        </button>
        <button className={`summary-tab ${tab === 'returns' ? 'active' : ''}`} onClick={() => setTab('returns')}>
          Returns
        </button>
      </div>
      <div className="summary-content">
        {tab === 'signals' && <SignalsTable signals={data.open_signals} />}
        {tab === 'correlation' && <CorrelationHeatmap data={data.correlation} />}
        {tab === 'returns' && <ReturnsChart data={data.cumulative_returns} />}
      </div>
    </div>
  )
}
