import { useEffect, useState, useRef, useMemo, Component, ReactNode } from 'react'
import axios from 'axios'
import { TVChart } from './components/TVChart'
import { BasketSummary } from './components/BasketSummary'

// DYNAMIC API BASE: 
// Automatically uses the hostname of the machine you are browsing from.
// This allows mobile devices to talk to the PC backend automatically.
const API_HOSTNAME = window.location.hostname;
const API_BASE = `http://${API_HOSTNAME}:8000/api`

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

function App() {
  const [baskets, setBaskets] = useState<BasketsData>({ Themes: [], Sectors: [], Industries: [] })
  const [tickers, setTickers] = useState<string[]>([])
  const [liveSignalTickers, setLiveSignalTickers] = useState<LiveSignalTicker[]>([])
  const [liveSignalFilter, setLiveSignalFilter] = useState<string | null>(null)
  const [liveSignalSort, setLiveSignalSort] = useState<'ticker' | 'signal'>('signal')
  const [viewType, setViewType] = useState<ViewType>('Themes')

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

  const isTicker = viewType === 'Tickers' || viewType === 'LiveSignals'
  const isBasketView = !isTicker && !activeTicker
  const canShowSummary = isBasketView

  const ALL_SIGNAL_TYPES = ['Breakout', 'Up_Rot', 'BTFD', 'STFR', 'Down_Rot', 'Breakdown']

  const filteredLiveSignals = useMemo(() => {
    let list = liveSignalTickers
    if (liveSignalFilter) {
      list = list.filter(t => t.signals.includes(liveSignalFilter))
    }
    if (liveSignalSort === 'signal') {
      const order: Record<string, number> = {}
      ALL_SIGNAL_TYPES.forEach((s, i) => order[s] = i)
      list = [...list].sort((a, b) => {
        const aMin = Math.min(...a.signals.map(s => order[s] ?? 99))
        const bMin = Math.min(...b.signals.map(s => order[s] ?? 99))
        return aMin !== bMin ? aMin - bMin : a.symbol.localeCompare(b.symbol)
      })
    }
    return list
  }, [liveSignalTickers, liveSignalFilter, liveSignalSort])

  // Derive min/max dates from loaded chart data for date picker bounds
  const dateBounds = useMemo(() => {
    if (!chartData || chartData.length === 0) return { min: '', max: '' }
    const dates = chartData.map((d: any) => String(d.Date).slice(0, 10)).filter(Boolean).sort()
    return { min: dates[0] || '', max: dates[dates.length - 1] || '' }
  }, [chartData])

  useEffect(() => {
    axios.get(`${API_BASE}/baskets`).then(res => {
      setBaskets(res.data);
      if (res.data.Themes?.length > 0) setSelectedItem(res.data.Themes[0]);
    }).catch(err => console.error(err));
    axios.get(`${API_BASE}/tickers`).then(res => setTickers(res.data)).catch(err => console.error(err));
    axios.get(`${API_BASE}/live-signals`).then(res => setLiveSignalTickers(res.data)).catch(err => console.error(err));
  }, [])

  useEffect(() => {
    if (!selectedItem) {
      setChartData([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLiveUpdate(null); // Clear previous live updates
    const isViewingBasketConstituent = activeTicker && !isTicker;
    const targetItem = isViewingBasketConstituent ? activeTicker : selectedItem;

    let endpoint = (isTicker || isViewingBasketConstituent) ? `tickers/${encodeURIComponent(targetItem as string)}` : `baskets/${encodeURIComponent(targetItem as string)}`;
    

    axios.get(`${API_BASE}/${endpoint}`).then(res => {
      setChartData(res.data.chart_data);
      if (endpoint.startsWith('baskets')) setComposition(res.data.tickers || []);
      setRangeUpdateTrigger(null);
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
    axios.get(`${API_BASE}/baskets/${encodeURIComponent(selectedItem)}/summary`)
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
  }, [canShowSummary, selectedItem, showSummary])

  // Auto-select first live signal ticker once data arrives
  useEffect(() => {
    if (viewType === 'LiveSignals' && liveSignalTickers.length > 0 && !selectedItem) {
      setSelectedItem(liveSignalTickers[0].symbol);
    }
  }, [liveSignalTickers, viewType, selectedItem])

  const handleViewTypeChange = (type: ViewType) => {
    setViewType(type); setActiveTicker(null); setShowSummary(false); setSummaryData(null)
    if (type === 'Themes' && baskets.Themes.length > 0) setSelectedItem(baskets.Themes[0]);
    else if (type === 'Sectors' && baskets.Sectors.length > 0) setSelectedItem(baskets.Sectors[0]);
    else if (type === 'Industries' && baskets.Industries.length > 0) setSelectedItem(baskets.Industries[0]);
    else if (type === 'Tickers' && tickers.length > 0) setSelectedItem(tickers[0]);
    else if (type === 'LiveSignals') {
      if (liveSignalTickers.length > 0) setSelectedItem(liveSignalTickers[0].symbol);
      else setSelectedItem('');  // Clear stale selection while data loads
    }
  }

  const getItemsForView = (): string[] => {
    switch(viewType) {
      case 'Themes': return baskets.Themes;
      case 'Sectors': return baskets.Sectors;
      case 'Industries': return baskets.Industries;
      case 'Tickers': return tickers;
      case 'LiveSignals': return filteredLiveSignals.map(t => t.symbol);
      default: return [];
    }
  }

  return (
    <ErrorBoundary>
      <div className="app-container">
        <div className="sidebar navigation-sidebar">
          <div className="sidebar-header">
            <h1 className="sidebar-title">TradingApp</h1>
            <div className="sidebar-view-toggles">
              <button className={viewType === 'Themes' ? 'active' : ''} onClick={() => handleViewTypeChange('Themes')}>Themes</button>
              <button className={viewType === 'Sectors' ? 'active' : ''} onClick={() => handleViewTypeChange('Sectors')}>Sectors</button>
              <button className={viewType === 'Industries' ? 'active' : ''} onClick={() => handleViewTypeChange('Industries')}>Industries</button>
              <button className={viewType === 'Tickers' ? 'active' : ''} onClick={() => handleViewTypeChange('Tickers')}>Tickers</button>
              <button className={viewType === 'LiveSignals' ? 'active' : ''} onClick={() => handleViewTypeChange('LiveSignals')}>Live Signals</button>
            </div>
          </div>
          <div className="sidebar-scrollable-content">
            {viewType === 'LiveSignals' && (
              <div className="signal-filter-bar">
                <button className={`signal-filter-btn ${liveSignalFilter === null ? 'active' : ''}`}
                        onClick={() => setLiveSignalFilter(null)}>All</button>
                {ALL_SIGNAL_TYPES.map(s => (
                  <button key={s} className={`signal-filter-btn ${liveSignalFilter === s ? 'active' : ''}`}
                          onClick={() => setLiveSignalFilter(prev => prev === s ? null : s)}>{s.replace(/_/g, ' ')}</button>
                ))}
                <button className="signal-sort-btn"
                        onClick={() => setLiveSignalSort(prev => prev === 'ticker' ? 'signal' : 'ticker')}
                        title={`Sort by ${liveSignalSort === 'ticker' ? 'signal' : 'ticker'}`}>
                  {liveSignalSort === 'ticker' ? 'A-Z' : 'Sig'}
                </button>
              </div>
            )}
            <ul className="sidebar-list">
              {viewType === 'LiveSignals' ? (
                filteredLiveSignals.length === 0 ? (
                  <li className="sidebar-item" style={{color: 'var(--text-muted)', fontStyle: 'italic'}}>
                    {liveSignalTickers.length === 0 ? 'No live signals available' : 'No matches for filter'}
                  </li>
                ) : filteredLiveSignals.map(t => (
                  <li key={t.symbol} className={`sidebar-item composition-item ${selectedItem === t.symbol && !activeTicker ? 'active' : ''}`}
                      onClick={() => { setSelectedItem(t.symbol); setActiveTicker(null); setSummaryData(null); }}>
                    <span className="ticker-symbol">{t.symbol}</span>
                    <span className="signal-tags">{t.signals.join(', ').replace(/_/g, ' ')}</span>
                  </li>
                ))
              ) : (
                getItemsForView().map(item => (
                  <li key={item} className={`sidebar-item ${selectedItem === item && !activeTicker ? 'active' : ''}`}
                      onClick={() => { setSelectedItem(item); setActiveTicker(null); setSummaryData(null); }}>
                    {item.replace(/_/g, ' ')}
                  </li>
                ))
              )}
            </ul>
            {!isTicker && composition.length > 0 && (
              <div className="sidebar-composition-section">
                <h3 className="sidebar-group-title">Composition ({selectedItem.replace(/_/g, ' ')})</h3>
                <ul className="sidebar-list">
                  {composition.map(t => (
                    <li key={t.symbol} className={`sidebar-item composition-item ${activeTicker === t.symbol ? 'active' : ''}`}
                        onClick={() => { setActiveTicker(t.symbol); setSummaryData(null); }}>
                      <span className="ticker-symbol">{t.symbol}</span>
                      <span className="ticker-weight">{t.weight > 0 ? `${(t.weight * 100).toFixed(2)}%` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
        <div className="main-content">
          {loading && <div className="loading-overlay"><span className="loading-text">Loading...</span></div>}
          <div className="main-header">
            <h2 className="main-title">{activeTicker || selectedItem.replace(/_/g, ' ')}</h2>
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
            <div className="header-controls">
              <div className="date-range-group">
                <input type="date" className="date-input" value={startDate} min={dateBounds.min} max={dateBounds.max} onChange={e => setStartDate(e.target.value)} />
                <span className="date-separator">to</span>
                <input type="date" className="date-input" value={endDate} min={dateBounds.min} max={dateBounds.max} onChange={e => setEndDate(e.target.value)} />
                <button className="control-btn primary" onClick={() => setRangeUpdateTrigger({ from: startDate, to: endDate })}>Go</button>
              </div>
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
          </div>
          <div className="content-stack" ref={contentStackRef}>
            {showSummary ? (
              <BasketSummary data={summaryData} loading={summaryLoading} basketName={selectedItem} apiBase={API_BASE} />
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
