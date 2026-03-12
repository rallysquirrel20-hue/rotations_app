import { useEffect, useState, useRef, useMemo, Component, ReactNode } from 'react'
import axios from 'axios'
import { TVChart } from './components/TVChart'
import { BasketSummary } from './components/BasketSummary'

// DYNAMIC API BASE:
// Automatically uses the hostname of the machine you are browsing from.
// This allows mobile devices to talk to the PC backend automatically.
const API_HOSTNAME = window.location.hostname;
const API_BASE = `http://${API_HOSTNAME}:8000/api`

// Convert quarter strings to date range
function quarterToDateRange(start: string, end: string) {
  const qToDate = (q: string, isEnd: boolean) => {
    const y = q.slice(0, 4), qn = parseInt(q.slice(6))
    if (isEnd) {
      const m = qn * 3
      return `${y}-${String(m).padStart(2, '0')}-${new Date(+y, m, 0).getDate()}`
    }
    return `${y}-${String((qn - 1) * 3 + 1).padStart(2, '0')}-01`
  }
  return { from: qToDate(start, false), to: qToDate(end, true) }
}

class ErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean, error: Error | null}> {
  constructor(props: {children: ReactNode}) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{color: '#212529', padding: '40px', background: '#f8f9fa', height: '100vh'}}>
          <h1>Something went wrong.</h1>
          <pre style={{background: '#eee', padding: '10px'}}>{this.state.error?.toString()}</pre>
          <button onClick={() => window.location.reload()}>Reload Page</button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface BasketsData { Themes: string[]; Sectors: string[]; Industries: string[]; }
interface TickerWeight { symbol: string; weight: number; }
interface LiveSignalTicker { symbol: string; signals: string[]; }
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
interface BasketSummaryData {
  open_signals: OpenSignal[]
  correlation: CorrelationData
  cumulative_returns: CumulativeReturnsData
}
type ViewType = 'Themes' | 'Sectors' | 'Industries' | 'Tickers' | 'LiveSignals';
type SearchCategory = 'all' | 'Themes' | 'Sectors' | 'Industries' | 'Tickers';
interface SearchResult { name: string; category: ViewType; displayName: string; }
interface TickerSignalSummary { lt_trend: string | null; st_trend: string | null; mean_rev: string | null; pct_change: number | null; dollar_vol: number | null; }
type SignalSortCol = 'ticker' | 'wt' | 'lt' | 'st' | 'mr' | 'pct'

function getSigSortVal(ticker: string, col: SignalSortCol, sigs: Record<string, TickerSignalSummary>): string | number {
  if (col === 'ticker') return ticker
  const sig = sigs[ticker]
  if (!sig) return col === 'pct' ? -Infinity : ''
  switch (col) {
    case 'lt': return sig.lt_trend || ''
    case 'st': return sig.st_trend || ''
    case 'mr': return sig.mean_rev || ''
    case 'wt': return sig.dollar_vol ?? -Infinity
    case 'pct': return sig.pct_change ?? -Infinity
    default: return ''
  }
}

function applySortFilter(tickers: string[], sortCol: SignalSortCol, sortDir: 1|-1,
                         fLT: string|null, fST: string|null, fMR: string|null,
                         sigs: Record<string, TickerSignalSummary>): string[] {
  let list = tickers
  if (fLT) list = list.filter(t => sigs[t]?.lt_trend === fLT)
  if (fST) list = list.filter(t => sigs[t]?.st_trend === fST)
  if (fMR) list = list.filter(t => sigs[t]?.mean_rev === fMR)
  return [...list].sort((a, b) => {
    const va = getSigSortVal(a, sortCol, sigs)
    const vb = getSigSortVal(b, sortCol, sigs)
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sortDir
    return String(va).localeCompare(String(vb)) * sortDir
  })
}

function App() {
  const [baskets, setBaskets] = useState<BasketsData>({ Themes: [], Sectors: [], Industries: [] })
  const [tickers, setTickers] = useState<string[]>([])
  const [liveSignalTickers, setLiveSignalTickers] = useState<LiveSignalTicker[]>([])
  const [basketBreadth, setBasketBreadth] = useState<Record<string, { uptrend_pct?: number; breakout_pct?: number }>>({})
  const [viewType, setViewType] = useState<ViewType>('LiveSignals')
  const [expandedViews, setExpandedViews] = useState<Set<ViewType>>(new Set(['LiveSignals']))
  const [expandedBasket, setExpandedBasket] = useState<string | null>(null)

  const [selectedItem, setSelectedItem] = useState<string>('')
  const [activeTicker, setActiveTicker] = useState<string | null>(null)
  const [chartData, setChartData] = useState<any[]>([])
  const [liveUpdate, setLiveUpdate] = useState<any>(null)
  const [composition, setComposition] = useState<TickerWeight[]>([])
  const [loading, setLoading] = useState(false)
  const [showPivots, setShowPivots] = useState(true)
  const [showTargets, setShowTargets] = useState(true)
  const [showVolume, setShowVolume] = useState(true)
  const [showBreadth, setShowBreadth] = useState(true)
  const [showBreakout, setShowBreakout] = useState(true)
  const [showCorrelation, setShowCorrelation] = useState(true)
  const [showCandleDetail, setShowCandleDetail] = useState(true)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rangeUpdateTrigger, setRangeUpdateTrigger] = useState<{from?: string, to?: string, reset1Y?: boolean} | null>(null)
  const [exportTrigger, setExportTrigger] = useState<number>(0)
  const [showSummary, setShowSummary] = useState(false)
  const [summaryData, setSummaryData] = useState<BasketSummaryData | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const contentStackRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchFilter, setSearchFilter] = useState<SearchCategory>('all')
  const [searchHighlight, setSearchHighlight] = useState(0)
  const [tickerSignals, setTickerSignals] = useState<Record<string, TickerSignalSummary>>({})
  const [tSortCol, setTSortCol] = useState<SignalSortCol>('wt')
  const [tSortDir, setTSortDir] = useState<1 | -1>(-1)
  const [tFilterLT, setTFilterLT] = useState<string | null>(null)
  const [tFilterST, setTFilterST] = useState<string | null>(null)
  const [tFilterMR, setTFilterMR] = useState<string | null>(null)
  const [lsSortCol, setLsSortCol] = useState<SignalSortCol>('wt')
  const [lsSortDir, setLsSortDir] = useState<1 | -1>(-1)
  const [lsFilterLT, setLsFilterLT] = useState<string | null>(null)
  const [lsFilterST, setLsFilterST] = useState<string | null>(null)
  const [lsFilterMR, setLsFilterMR] = useState<string | null>(null)
  const [cSortCol, setCSortCol] = useState<SignalSortCol>('wt')
  const [cSortDir, setCSortDir] = useState<1 | -1>(-1)
  const [cFilterLT, setCFilterLT] = useState<string | null>(null)
  const [cFilterST, setCFilterST] = useState<string | null>(null)
  const [cFilterMR, setCFilterMR] = useState<string | null>(null)
  const [tFilterOpen, setTFilterOpen] = useState<SignalSortCol | null>(null)
  const [cFilterOpen, setCFilterOpen] = useState<SignalSortCol | null>(null)
  const [lsFilterOpen, setLsFilterOpen] = useState<SignalSortCol | null>(null)

  // Quarter universe state
  const [quarterData, setQuarterData] = useState<Record<string, string[]>>({})
  const [quarterKeys, setQuarterKeys] = useState<string[]>([])
  const [quarterStart, setQuarterStart] = useState('')
  const [quarterEnd, setQuarterEnd] = useState('')
  const [quarterActive, setQuarterActive] = useState(false)
  const [basketCompositions, setBasketCompositions] = useState<Record<string, Record<string, string[]>>>({})
  const [viewQuarter, setViewQuarter] = useState('')

  // Single derived flag: is quarter mode on?
  const isQuarterMode = quarterActive && !!quarterStart && !!quarterEnd

  const isTicker = viewType === 'Tickers' || viewType === 'LiveSignals'
  const isBasketView = !isTicker && !activeTicker
  const canShowSummary = isBasketView


  // Quarters within the selected range (oldest-first for button display)
  const rangeQuarters = useMemo(() => {
    if (!quarterStart || !quarterEnd) return []
    return [...quarterKeys].reverse().filter(q => q >= quarterStart && q <= quarterEnd)
  }, [quarterStart, quarterEnd, quarterKeys])

  // Auto-set viewQuarter to first in range when range changes
  useEffect(() => {
    if (rangeQuarters.length > 0 && !rangeQuarters.includes(viewQuarter)) {
      setViewQuarter(rangeQuarters[0])
    } else if (rangeQuarters.length === 0) {
      setViewQuarter('')
    }
  }, [rangeQuarters])

  // Basket composition for the currently viewed quarter
  const quarterBasketTickers = useMemo(() => {
    if (!viewQuarter || !isQuarterMode) return null
    return (basketName: string): string[] => {
      const slug = basketName.replace(/ /g, '_')
      const comp = basketCompositions[slug]
      if (!comp) return []
      return comp[viewQuarter] || []
    }
  }, [viewQuarter, basketCompositions, isQuarterMode])

  // Ticker universe: quarter-filtered or current
  const quarterFilteredTickers = useMemo<Set<string> | null>(() => {
    if (!isQuarterMode) return null
    const union = new Set<string>()
    for (const q of quarterKeys) {
      if (q >= quarterStart && q <= quarterEnd) {
        const list = quarterData[q]
        if (list) for (const t of list) union.add(t)
      }
    }
    return union.size > 0 ? union : null
  }, [isQuarterMode, quarterStart, quarterEnd, quarterKeys, quarterData])

  const filteredTickers = useMemo(() => {
    if (!quarterFilteredTickers) return tickers
    return [...quarterFilteredTickers].sort()
  }, [tickers, quarterFilteredTickers])

  // Merge live signal overrides into ticker signals so LT/ST/MR reflect live state
  const [effectiveSignals, liveOverrides] = useMemo(() => {
    const merged = { ...tickerSignals }
    const overrides: Record<string, Set<string>> = {}
    for (const lst of liveSignalTickers) {
      const existing = merged[lst.symbol]
      if (!existing) continue
      const copy = { ...existing }
      const cols = new Set<string>()
      for (const sig of lst.signals) {
        if (sig === 'Up_Rot') { copy.st_trend = 'Up'; cols.add('st') }
        if (sig === 'Down_Rot') { copy.st_trend = 'Dn'; cols.add('st') }
        if (sig === 'Breakout') { copy.lt_trend = 'BO'; cols.add('lt') }
        if (sig === 'Breakdown') { copy.lt_trend = 'BD'; cols.add('lt') }
        if (sig === 'BTFD') { copy.mean_rev = 'BTFD'; cols.add('mr') }
        if (sig === 'STFR') { copy.mean_rev = 'STFR'; cols.add('mr') }
      }
      merged[lst.symbol] = copy
      if (cols.size > 0) overrides[lst.symbol] = cols
    }
    return [merged, overrides] as const
  }, [tickerSignals, liveSignalTickers])

  const sortedTickers = useMemo(() =>
    applySortFilter(filteredTickers, tSortCol, tSortDir, tFilterLT, tFilterST, tFilterMR, effectiveSignals),
    [filteredTickers, effectiveSignals, tSortCol, tSortDir, tFilterLT, tFilterST, tFilterMR]
  )

  const sortedLiveSignals = useMemo(() =>
    applySortFilter(liveSignalTickers.map(t => t.symbol), lsSortCol, lsSortDir, lsFilterLT, lsFilterST, lsFilterMR, effectiveSignals),
    [liveSignalTickers, effectiveSignals, lsSortCol, lsSortDir, lsFilterLT, lsFilterST, lsFilterMR]
  )

  const searchResults = useMemo(() => {
    const results: SearchResult[] = []
    const q = searchQuery.toLowerCase().trim()
    if (!q) return results
    const add = (items: string[], category: ViewType) => {
      if (searchFilter !== 'all' && searchFilter !== category) return
      for (const item of items) {
        const display = item.replace(/_/g, ' ')
        if (item.toLowerCase().includes(q) || display.toLowerCase().includes(q)) {
          results.push({ name: item, category, displayName: display })
        }
      }
    }
    add(baskets.Themes, 'Themes')
    add(baskets.Sectors, 'Sectors')
    add(baskets.Industries, 'Industries')
    add(filteredTickers, 'Tickers')
    return results.slice(0, 25)
  }, [searchQuery, searchFilter, baskets, filteredTickers])

  const handleSearchSelect = (result: SearchResult) => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchHighlight(0)
    if (result.category === 'Tickers') {
      setViewType('Tickers')
      setSelectedItem(result.name)
      setActiveTicker(null)
      setShowSummary(false)
      setSummaryData(null)
      setExpandedBasket(null)
      setExpandedViews(prev => new Set(prev).add('Tickers'))
    } else {
      setViewType(result.category)
      setSelectedItem(result.name)
      setActiveTicker(null)
      setShowSummary(false)
      setSummaryData(null)
      setExpandedBasket(result.name)
      setExpandedViews(prev => new Set(prev).add(result.category))
    }
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); searchInputRef.current?.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSearchHighlight(prev => Math.min(prev + 1, searchResults.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchHighlight(prev => Math.max(prev - 1, 0)); }
    else if (e.key === 'Enter' && searchResults.length > 0) { handleSearchSelect(searchResults[searchHighlight]); }
  }

  // Derive min/max dates from loaded chart data for date picker bounds
  const dateBounds = useMemo(() => {
    if (!chartData || chartData.length === 0) return { min: '', max: '' }
    const dates = chartData.map((d: any) => String(d.Date).slice(0, 10)).filter(Boolean).sort()
    return { min: dates[0] || '', max: dates[dates.length - 1] || '' }
  }, [chartData])

  // Fetch all reference data on mount
  useEffect(() => {
    axios.get(`${API_BASE}/baskets`).then(res => {
      setBaskets(res.data);
    }).catch(err => console.error(err));
    axios.get(`${API_BASE}/tickers`).then(res => setTickers(res.data)).catch(err => console.error(err));
    axios.get(`${API_BASE}/tickers/quarters`).then(res => {
      setQuarterData(res.data.tickers_by_quarter || {})
      setQuarterKeys(res.data.quarters || [])
    }).catch(err => console.error(err));
    axios.get(`${API_BASE}/baskets/compositions`).then(res => setBasketCompositions(res.data || {})).catch(err => console.error(err));
    axios.get(`${API_BASE}/baskets/breadth`).then(res => setBasketBreadth(res.data || {})).catch(err => console.error(err));
    axios.get(`${API_BASE}/live-signals`).then(res => setLiveSignalTickers(res.data)).catch(err => console.error(err));
    axios.get(`${API_BASE}/ticker-signals`).then(res => setTickerSignals(res.data)).catch(err => console.error(err));
  }, [])

  // Load chart data when selection changes
  useEffect(() => {
    if (!selectedItem) {
      setChartData([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLiveUpdate(null);
    const isViewingBasketConstituent = activeTicker && !isTicker;
    const targetItem = isViewingBasketConstituent ? activeTicker : selectedItem;

    let endpoint = (isTicker || isViewingBasketConstituent) ? `tickers/${encodeURIComponent(targetItem as string)}` : `baskets/${encodeURIComponent(targetItem as string)}`;

    axios.get(`${API_BASE}/${endpoint}`).then(res => {
      setChartData(res.data.chart_data);
      if (endpoint.startsWith('baskets')) setComposition(res.data.tickers || []);
    }).catch(() => {
      setChartData([]);
      if (endpoint.startsWith('baskets')) setComposition([]);
    }).finally(() => setLoading(false));

    // Setup WebSocket for live updates if viewing a ticker
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    if ((isTicker || isViewingBasketConstituent) && targetItem) {
      const wsUrl = `ws://${API_HOSTNAME}:8000/ws/live/${encodeURIComponent(targetItem as string)}`;

      const connect = () => {
        if (cancelled) return;
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (!data.error) {
            setLiveUpdate(data);
          }
        };
        ws.onerror = (err) => console.error("WebSocket error:", err);
        ws.onclose = () => {
          if (!cancelled) reconnectTimeout = setTimeout(connect, 3000);
        };
      };

      connect();
    }

    return () => {
      cancelled = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [selectedItem, viewType, activeTicker])

  // Apply date range: quarter range if active, else 1Y
  useEffect(() => {
    if (!chartData || chartData.length === 0) return
    if (isQuarterMode) {
      const { from, to } = quarterToDateRange(quarterStart, quarterEnd)
      setStartDate(from)
      setEndDate(to)
      setRangeUpdateTrigger({ from, to })
    } else {
      setStartDate('')
      setEndDate('')
      setRangeUpdateTrigger({ reset1Y: true })
    }
  }, [chartData, isQuarterMode, quarterStart, quarterEnd])

  useEffect(() => {
    if (!canShowSummary) {
      setShowSummary(false)
      setSummaryData(null)
      setSummaryLoading(false)
      return
    }
    if (!showSummary || !selectedItem) return

    let cancelled = false
    setSummaryData(null)
    setSummaryLoading(true)
    const params = new URLSearchParams()
    if (isQuarterMode) {
      const { from, to } = quarterToDateRange(quarterStart, quarterEnd)
      params.set('start', from)
      params.set('end', to)
    }
    const qs = params.toString()
    axios.get(`${API_BASE}/baskets/${encodeURIComponent(selectedItem)}/summary${qs ? '?' + qs : ''}`)
      .then(res => {
        if (!cancelled) setSummaryData(res.data)
      })
      .catch(() => {
        if (!cancelled) setSummaryData(null)
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [canShowSummary, selectedItem, showSummary, isQuarterMode, quarterStart, quarterEnd])

  // Auto-select first live signal ticker once data arrives
  useEffect(() => {
    if (viewType === 'LiveSignals' && liveSignalTickers.length > 0 && !selectedItem) {
      setSelectedItem(liveSignalTickers[0].symbol);
    }
  }, [liveSignalTickers, viewType, selectedItem])

  const toggleView = (view: ViewType) => {
    setExpandedViews(prev => {
      const next = new Set(prev)
      if (next.has(view)) next.delete(view)
      else next.add(view)
      return next
    })
  }

  const handleBasketSelect = (item: string, view: ViewType) => {
    if (selectedItem === item && viewType === view && !activeTicker) {
      setExpandedBasket(prev => prev === item ? null : item)
    } else {
      setViewType(view)
      setSelectedItem(item)
      setActiveTicker(null)
      setShowSummary(false)
      setSummaryData(null)
      setExpandedBasket(item)
    }
  }

  const handleItemSelect = (item: string, view: ViewType) => {
    setViewType(view)
    setSelectedItem(item)
    setActiveTicker(null)
    setShowSummary(false)
    setSummaryData(null)
    setExpandedBasket(null)
  }

  const doSort = (col: SignalSortCol, curCol: SignalSortCol, curDir: 1|-1,
                  setCol: (c: SignalSortCol) => void, setDir: (d: 1|-1) => void) => {
    if (curCol === col) setDir(curDir === 1 ? -1 : 1)
    else { setCol(col); setDir(col === 'pct' || col === 'wt' ? -1 : 1) }
  }

  const renderColHeader = (
    sortCol: SignalSortCol, sortDir: 1|-1,
    setCol: (c: SignalSortCol) => void, setDir: (d: 1|-1) => void,
    filterLT: string|null, filterST: string|null, filterMR: string|null,
    setFLT: (v: string|null) => void, setFST: (v: string|null) => void, setFMR: (v: string|null) => void,
    filterOpen: SignalSortCol|null, setFilterOpen: (v: SignalSortCol|null) => void,
    showWeight?: boolean,
    showDV?: boolean
  ) => {
    const arrow = (col: SignalSortCol) => sortCol === col ? (sortDir === 1 ? ' \u25B2' : ' \u25BC') : ''
    const hasFilter = !!(filterLT || filterST || filterMR)

    const handleClick = (col: SignalSortCol) => {
      if (col === 'ticker' || col === 'pct' || col === 'wt') {
        doSort(col, sortCol, sortDir, setCol, setDir)
        setFilterOpen(null)
      } else {
        setFilterOpen(filterOpen === col ? null : col)
      }
    }

    const filterCfg: Record<string, {vals: [string,string], cur: string|null, set: (v:string|null)=>void}> = {
      lt: { vals: ['BO','BD'], cur: filterLT, set: setFLT },
      st: { vals: ['Up','Dn'], cur: filterST, set: setFST },
      mr: { vals: ['BTFD','STFR'], cur: filterMR, set: setFMR },
    }

    const renderDropdown = (col: string) => {
      const c = filterCfg[col]
      if (!c) return null
      const handleCheck = (val: string) => {
        const other = val === c.vals[0] ? c.vals[1] : c.vals[0]
        c.set(c.cur === null ? other : null)
      }
      return (
        <>
          <div className="col-filter-backdrop" onClick={(e) => { e.stopPropagation(); setFilterOpen(null) }}></div>
          <div className="col-filter-dropdown" onClick={(e) => e.stopPropagation()}>
            <button className="cfd-btn" onClick={() => { doSort(col as SignalSortCol, sortCol, sortDir, setCol, setDir); setFilterOpen(null) }}>
              Sort {sortCol === col && sortDir === 1 ? 'Z\u2192A' : 'A\u2192Z'}
            </button>
            <div className="cfd-sep"></div>
            {c.vals.map((v, i) => (
              <label key={v} className="cfd-check">
                <input type="checkbox" checked={c.cur === null || c.cur === v} onChange={() => handleCheck(v)} />
                <span className={i === 0 ? 'sig-bull' : 'sig-bear'}>{v}</span>
              </label>
            ))}
            {c.cur && (
              <>
                <div className="cfd-sep"></div>
                <button className="cfd-btn" onClick={() => { c.set(null); setFilterOpen(null) }}>Clear Filter</button>
              </>
            )}
          </div>
        </>
      )
    }

    return (
      <div className={`signal-col-header ${showWeight ? 'indent-constituent' : ''}`}>
        <span className={`col-ticker col-hdr ${sortCol === 'ticker' ? 'active' : ''}`} onClick={() => handleClick('ticker')}>
          Ticker{arrow('ticker')}
        </span>
        {(showWeight || showDV) && (
          <span className={`col-wt col-hdr ${sortCol === 'wt' ? 'active' : ''}`} onClick={() => handleClick('wt')}>
            {showWeight ? 'Wt' : 'DV'}{arrow('wt')}
          </span>
        )}
        <span className={`col-lt col-hdr ${sortCol === 'lt' ? 'active' : ''} ${filterLT ? 'filtered' : ''}`}
              onClick={() => handleClick('lt')} style={{position:'relative'}}>
          LT{arrow('lt')}{filterOpen === 'lt' && renderDropdown('lt')}
        </span>
        <span className={`col-st col-hdr ${sortCol === 'st' ? 'active' : ''} ${filterST ? 'filtered' : ''}`}
              onClick={() => handleClick('st')} style={{position:'relative'}}>
          ST{arrow('st')}{filterOpen === 'st' && renderDropdown('st')}
        </span>
        <span className={`col-mr col-hdr ${sortCol === 'mr' ? 'active' : ''} ${filterMR ? 'filtered' : ''}`}
              onClick={() => handleClick('mr')} style={{position:'relative'}}>
          MR{arrow('mr')}{filterOpen === 'mr' && renderDropdown('mr')}
        </span>
        <span className={`col-pct col-hdr ${sortCol === 'pct' ? 'active' : ''}`} onClick={() => handleClick('pct')}>
          Chg{arrow('pct')}
        </span>
        {hasFilter && <span className="col-clear-x" onClick={(e) => { e.stopPropagation(); setFLT(null); setFST(null); setFMR(null) }}>{'\u00D7'}</span>}
      </div>
    )
  }

  const fmtDV = (dv: number) => {
    if (dv >= 1e9) return `${(dv / 1e9).toFixed(1)}B`
    if (dv >= 1e6) return `${(dv / 1e6).toFixed(0)}M`
    if (dv >= 1e3) return `${(dv / 1e3).toFixed(0)}K`
    return `${dv}`
  }

  const renderSignalCols = (ticker: string, weight?: number, showDV?: boolean) => {
    const sig = effectiveSignals[ticker]
    const live = liveOverrides[ticker]
    return (
      <>
        {weight !== undefined && (
          <span className="col-wt">{weight > 0 ? `${(weight * 100).toFixed(1)}%` : ''}</span>
        )}
        {showDV && weight === undefined && (
          <span className="col-wt">{sig?.dollar_vol != null ? fmtDV(sig.dollar_vol) : ''}</span>
        )}
        <span className={`col-lt ${sig?.lt_trend ? (sig.lt_trend === 'BO' ? 'sig-bull' : 'sig-bear') : ''}${live?.has('lt') ? ' sig-live' : ''}`}>
          {sig?.lt_trend || ''}
        </span>
        <span className={`col-st ${sig?.st_trend ? (sig.st_trend === 'Up' ? 'sig-bull' : 'sig-bear') : ''}${live?.has('st') ? ' sig-live' : ''}`}>
          {sig?.st_trend || ''}
        </span>
        <span className={`col-mr ${sig?.mean_rev ? (sig.mean_rev === 'BTFD' ? 'sig-bull' : 'sig-bear') : ''}${live?.has('mr') ? ' sig-live' : ''}`}>
          {sig?.mean_rev || ''}
        </span>
        <span className={`col-pct ${sig?.pct_change != null ? (sig.pct_change >= 0 ? 'sig-bull' : 'sig-bear') : ''}`}>
          {sig?.pct_change != null ? `${sig.pct_change >= 0 ? '+' : ''}${sig.pct_change.toFixed(1)}%` : ''}
        </span>
      </>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app-container">
        <div className="sidebar navigation-sidebar">
          <div className="sidebar-header">
            <div className="sidebar-brand">
              <img src="/usamlogo.webp" alt="U.S. Asset Management" className="sidebar-logo" />
            </div>
          </div>
          <div className="sidebar-scrollable-content">
            <div className="accordion-section">
              <button className="accordion-header" onClick={() => toggleView('LiveSignals')}>
                <span className={`accordion-chevron ${expandedViews.has('LiveSignals') ? 'expanded' : ''}`}>{'>'}</span>
                Live Signals
              </button>
              {expandedViews.has('LiveSignals') && (
                <>
                  {renderColHeader(lsSortCol, lsSortDir, setLsSortCol, setLsSortDir, lsFilterLT, lsFilterST, lsFilterMR, setLsFilterLT, setLsFilterST, setLsFilterMR, lsFilterOpen, setLsFilterOpen, false, true)}
                  {sortedLiveSignals.length === 0 ? (
                    <div className="accordion-item" style={{color: 'var(--text-muted)', fontStyle: 'italic'}}>
                      {liveSignalTickers.length === 0 ? 'No live signals available' : 'No matches for filter'}
                    </div>
                  ) : sortedLiveSignals.map(t => (
                    <div
                      key={t}
                      className={`accordion-item accordion-item-flex ${selectedItem === t && viewType === 'LiveSignals' && !activeTicker ? 'active' : ''}`}
                      onClick={() => handleItemSelect(t, 'LiveSignals')}
                    >
                      <span className="col-ticker ticker-symbol">{t}</span>
                      {renderSignalCols(t, undefined, true)}
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="accordion-section">
              <button className="accordion-header" onClick={() => toggleView('Tickers')}>
                <span className={`accordion-chevron ${expandedViews.has('Tickers') ? 'expanded' : ''}`}>{'>'}</span>
                Tickers
              </button>
              {expandedViews.has('Tickers') && (
                <>
                  {renderColHeader(tSortCol, tSortDir, setTSortCol, setTSortDir, tFilterLT, tFilterST, tFilterMR, setTFilterLT, setTFilterST, setTFilterMR, tFilterOpen, setTFilterOpen, false, true)}
                  {sortedTickers.map(t => (
                    <div
                      key={t}
                      className={`accordion-item accordion-item-flex ${selectedItem === t && viewType === 'Tickers' && !activeTicker ? 'active' : ''}`}
                      onClick={() => handleItemSelect(t, 'Tickers')}
                    >
                      <span className="col-ticker ticker-symbol">{t}</span>
                      {renderSignalCols(t, undefined, true)}
                    </div>
                  ))}
                </>
              )}
            </div>
            {(['Themes', 'Sectors', 'Industries'] as const).map(view => (
              <div key={view} className="accordion-section">
                <button className="accordion-header" onClick={() => toggleView(view)}>
                  <span className={`accordion-chevron ${expandedViews.has(view) ? 'expanded' : ''}`}>{'>'}</span>
                  {view}
                </button>
                {expandedViews.has(view) && baskets[view].map(item => (
                  <div key={item}>
                    <div
                      className={`accordion-basket-header ${selectedItem === item && viewType === view && !activeTicker ? 'active' : ''}`}
                      onClick={() => handleBasketSelect(item, view)}
                    >
                      <span className={`accordion-chevron ${expandedBasket === item && viewType === view ? 'expanded' : ''}`}>{'>'}</span>
                      <span className="basket-name-text">{item.replace(/_/g, ' ')}</span>
                      {basketBreadth[item] && (
                        <>
                          <span className={`col-breadth ${(basketBreadth[item].breakout_pct ?? 0) >= 50 ? 'sig-bull' : 'sig-bear'}`}>
                            {basketBreadth[item].breakout_pct != null ? `${basketBreadth[item].breakout_pct}%` : ''}
                          </span>
                          <span className={`col-breadth ${(basketBreadth[item].uptrend_pct ?? 0) >= 50 ? 'sig-bull' : 'sig-bear'}`}>
                            {basketBreadth[item].uptrend_pct != null ? `${basketBreadth[item].uptrend_pct}%` : ''}
                          </span>
                        </>
                      )}
                    </div>
                    {expandedBasket === item && viewType === view && (() => {
                      const qTickers = quarterBasketTickers ? quarterBasketTickers(item) : []
                      const showQuarterView = isQuarterMode && qTickers.length > 0
                      const allConstituents = showQuarterView
                        ? qTickers.map(s => ({ symbol: s, weight: 0 }))
                        : composition
                      const weightMap = Object.fromEntries(allConstituents.map(c => [c.symbol, c.weight]))
                      let cSymbols = allConstituents.map(c => c.symbol)
                      if (cFilterLT) cSymbols = cSymbols.filter(s => effectiveSignals[s]?.lt_trend === cFilterLT)
                      if (cFilterST) cSymbols = cSymbols.filter(s => effectiveSignals[s]?.st_trend === cFilterST)
                      if (cFilterMR) cSymbols = cSymbols.filter(s => effectiveSignals[s]?.mean_rev === cFilterMR)
                      cSymbols = [...cSymbols].sort((a, b) => {
                        if (cSortCol === 'wt') return ((weightMap[a]||0) - (weightMap[b]||0)) * cSortDir
                        const va = getSigSortVal(a, cSortCol, effectiveSignals)
                        const vb = getSigSortVal(b, cSortCol, effectiveSignals)
                        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * cSortDir
                        return String(va).localeCompare(String(vb)) * cSortDir
                      })
                      const constituents = cSymbols.map(s => ({ symbol: s, weight: weightMap[s] || 0 }))
                      return allConstituents.length > 0 && (
                        <div className="accordion-constituents">
                          {showQuarterView && (
                            <div className="quarter-nav-bar">
                              <span className="quarter-nav-label">Tickers</span>
                              {rangeQuarters.map(q => (
                                <button
                                  key={q}
                                  className={`quarter-nav-btn ${viewQuarter === q ? 'active' : ''}`}
                                  onClick={() => setViewQuarter(q)}
                                >{q}</button>
                              ))}
                            </div>
                          )}
                          {renderColHeader(cSortCol, cSortDir, setCSortCol, setCSortDir, cFilterLT, cFilterST, cFilterMR, setCFilterLT, setCFilterST, setCFilterMR, cFilterOpen, setCFilterOpen, true)}
                          {constituents.map(t => (
                            <div
                              key={t.symbol}
                              className={`accordion-constituent ${activeTicker === t.symbol ? 'active' : ''}`}
                              onClick={() => { setActiveTicker(t.symbol); setSummaryData(null); }}
                            >
                              <span className="col-ticker ticker-symbol">{t.symbol}</span>
                              {renderSignalCols(t.symbol, t.weight)}
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="main-content">
          {loading && <div className="loading-overlay"><span className="loading-text">Loading...</span></div>}
          <div className="main-header">
            <div className="search-container">
              <div className="search-input-wrapper" onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); }}>
                {searchOpen ? (
                  <input
                    ref={searchInputRef}
                    className="search-input"
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setSearchHighlight(0); }}
                    onKeyDown={handleSearchKeyDown}
                    onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
                    placeholder={activeTicker || selectedItem.replace(/_/g, ' ')}
                    autoFocus
                  />
                ) : (
                  <h2 className="main-title">{activeTicker || selectedItem.replace(/_/g, ' ')}</h2>
                )}
              </div>
              {searchOpen && searchQuery.trim() && (
                <div className="search-dropdown">
                  <div className="search-filters">
                    {(['all', 'Themes', 'Sectors', 'Industries', 'Tickers'] as const).map(f => (
                      <button
                        key={f}
                        className={`search-filter-btn ${searchFilter === f ? 'active' : ''}`}
                        onMouseDown={e => { e.preventDefault(); setSearchFilter(f); }}
                      >
                        {f === 'all' ? 'All' : f}
                      </button>
                    ))}
                  </div>
                  <div className="search-results">
                    {searchResults.map((r, i) => (
                      <div
                        key={`${r.category}-${r.name}`}
                        className={`search-result-item ${i === searchHighlight ? 'highlighted' : ''}`}
                        onMouseDown={() => handleSearchSelect(r)}
                        onMouseEnter={() => setSearchHighlight(i)}
                      >
                        <span className="search-result-name">{r.displayName}</span>
                        <span className="search-result-tag">{r.category}</span>
                      </div>
                    ))}
                    {searchResults.length === 0 && (
                      <div className="search-result-empty">No matches</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="header-toggles">
              <label className="overlay-checkbox"><input type="checkbox" checked={showPivots} onChange={e => setShowPivots(e.target.checked)} /> Pivots</label>
              <label className="overlay-checkbox"><input type="checkbox" checked={showTargets} onChange={e => setShowTargets(e.target.checked)} /> Targets</label>
              {!isBasketView && (
                <label className="overlay-checkbox"><input type="checkbox" checked={showVolume} onChange={e => setShowVolume(e.target.checked)} /> Volume</label>
              )}
              {isBasketView && (
                <>
                  <label className="overlay-checkbox"><input type="checkbox" checked={showBreadth} onChange={e => setShowBreadth(e.target.checked)} /> Breadth%</label>
                  <label className="overlay-checkbox"><input type="checkbox" checked={showBreakout} onChange={e => setShowBreakout(e.target.checked)} /> Breakout%</label>
                  <label className="overlay-checkbox"><input type="checkbox" checked={showCorrelation} onChange={e => setShowCorrelation(e.target.checked)} /> Correlation%</label>
                  <label className="overlay-checkbox"><input type="checkbox" checked={showCandleDetail} onChange={e => setShowCandleDetail(e.target.checked)} /> Constituents</label>
                </>
              )}
            </div>
            <div className="header-actions">
              {canShowSummary && (
                <button
                  className={`control-btn ${showSummary ? 'primary' : ''}`}
                  onClick={() => setShowSummary(prev => !prev)}
                >
                  Basket Analysis
                </button>
              )}
              <button className="control-btn" onClick={() => setRangeUpdateTrigger({ reset1Y: true })}>Reset 1Y</button>
              <button className="control-btn" onClick={() => setExportTrigger(p => p + 1)}>Export Image</button>
            </div>
            <div className="header-right-stack">
              {quarterKeys.length > 0 && (
                <div className="header-quarter-row">
                  <span className="range-label">Universe:</span>
                  <div className="range-inputs">
                    <select className="quarter-select" value={quarterStart} onChange={e => setQuarterStart(e.target.value)}>
                      <option value="">From</option>
                      {quarterKeys.map(q => (
                        <option key={q} value={q}>{q}</option>
                      ))}
                    </select>
                    <span className="date-separator">to</span>
                    <select className="quarter-select" value={quarterEnd} onChange={e => setQuarterEnd(e.target.value)}>
                      <option value="">To</option>
                      {quarterKeys.map(q => (
                        <option key={q} value={q}>{q}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    className={`range-action-btn control-btn ${quarterActive ? 'primary' : ''}`}
                    onClick={() => {
                      const next = !quarterActive
                      setQuarterActive(next)
                      if (!next) {
                        setQuarterStart('')
                        setQuarterEnd('')
                        setStartDate('')
                        setEndDate('')
                        setRangeUpdateTrigger({ reset1Y: true })
                      }
                    }}
                    title={quarterActive ? 'Quarter filter active' : 'Quarter filter off'}
                  >
                    {quarterActive ? 'ON' : 'OFF'}
                  </button>
                </div>
              )}
              <div className="header-date-row">
                <span className="range-label">Date Range:</span>
                <div className="range-inputs">
                  <input type="date" className="date-input" value={startDate} min={dateBounds.min} max={dateBounds.max} onChange={e => setStartDate(e.target.value)} />
                  <span className="date-separator">to</span>
                  <input type="date" className="date-input" value={endDate} min={dateBounds.min} max={dateBounds.max} onChange={e => setEndDate(e.target.value)} />
                </div>
                <button className="range-action-btn control-btn primary" onClick={() => setRangeUpdateTrigger({ from: startDate, to: endDate })}>Go</button>
              </div>
            </div>
          </div>
          <div className="content-stack" ref={contentStackRef}>
            {showSummary ? (
              <BasketSummary data={summaryData} loading={summaryLoading} basketName={selectedItem} apiBase={API_BASE} quarterDateRange={isQuarterMode ? quarterToDateRange(quarterStart, quarterEnd) : null} />
            ) : (
            <div className="chart-container">
            {chartData && chartData.length > 0 ? (
              <TVChart
                key={`${viewType}_${activeTicker || selectedItem}`}
                data={chartData}
                liveUpdate={liveUpdate}
                showPivots={showPivots}
                showTargets={showTargets}
                showVolume={showVolume && !isBasketView}
                showBreadth={showBreadth && isBasketView}
                showBreakout={showBreakout && isBasketView}
                showCorrelation={showCorrelation && isBasketView}
                rangeUpdateTrigger={rangeUpdateTrigger}
                exportTrigger={exportTrigger}
                symbolName={activeTicker || selectedItem}
                isBasketView={isBasketView}
                basketName={isBasketView ? selectedItem : undefined}
                apiBase={API_BASE}
                showCandleDetail={showCandleDetail && isBasketView}
              />
            ) : (
              <div className="no-data">{selectedItem ? "No data found" : "Select an item"}</div>
            )}
            </div>
            )}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  )
}
export default App
