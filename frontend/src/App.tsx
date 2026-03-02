import { useEffect, useState, Component, ReactNode } from 'react'
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
type ViewType = 'Themes' | 'Sectors' | 'Industries' | 'Tickers';
type Timeframe = 'Daily' | '1m' | '5m' | '30m';

function App() {
  const [baskets, setBaskets] = useState<BasketsData>({ Themes: [], Sectors: [], Industries: [] })
  const [tickers, setTickers] = useState<string[]>([])
  const [viewType, setViewType] = useState<ViewType>('Themes')
  const [timeframe, setTimeframe] = useState<Timeframe>('Daily')
  const [selectedItem, setSelectedItem] = useState<string>('')
  const [activeTicker, setActiveTicker] = useState<string | null>(null)
  const [chartData, setChartData] = useState<any[]>([])
  const [liveUpdate, setLiveUpdate] = useState<any>(null)
  const [composition, setComposition] = useState<TickerWeight[]>([])
  const [loading, setLoading] = useState(false)
  const [showPivots, setShowPivots] = useState(true)
  const [showTargets, setShowTargets] = useState(true)
  const [showVolume, setShowVolume] = useState(true)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rangeUpdateTrigger, setRangeUpdateTrigger] = useState<{from?: string, to?: string, reset1Y?: boolean} | null>(null)
  const [exportTrigger, setExportTrigger] = useState<number>(0)
  const [showSummary, setShowSummary] = useState(false)
  const [summaryData, setSummaryData] = useState<BasketSummaryData | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)

  const isBasketView = viewType !== 'Tickers' && !activeTicker
  const canShowSummary = isBasketView && timeframe === 'Daily'

  useEffect(() => {
    axios.get(`${API_BASE}/baskets`).then(res => {
      setBaskets(res.data);
      if (res.data.Themes?.length > 0) setSelectedItem(res.data.Themes[0]);
    }).catch(err => console.error(err));
    axios.get(`${API_BASE}/tickers`).then(res => setTickers(res.data)).catch(err => console.error(err));
  }, [])

  useEffect(() => {
    if (!selectedItem) return;
    setLoading(true);
    setLiveUpdate(null); // Clear previous live updates
    const isViewingBasketConstituent = activeTicker && viewType !== 'Tickers';
    const targetItem = isViewingBasketConstituent ? activeTicker : selectedItem;
    
    let endpoint = (viewType === 'Tickers' || isViewingBasketConstituent) ? `tickers/${encodeURIComponent(targetItem as string)}` : `baskets/${encodeURIComponent(targetItem as string)}`;
    
    // Use intraday endpoint if timeframe is not Daily
    if (timeframe !== 'Daily' && (viewType === 'Tickers' || isViewingBasketConstituent)) {
      endpoint = `tickers/${encodeURIComponent(targetItem as string)}/intraday?interval=${timeframe}`;
    }

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
    if (viewType === 'Tickers' || isViewingBasketConstituent) {
      const wsUrl = `ws://${API_HOSTNAME}:8000/ws/live/${encodeURIComponent(targetItem as string)}`;
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (!data.error) {
          setLiveUpdate(data);
        }
      };
      ws.onerror = (err) => console.error("WebSocket error:", err);
    }

    return () => {
      if (ws) ws.close();
    };
  }, [selectedItem, viewType, activeTicker, timeframe])

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

  const handleViewTypeChange = (type: ViewType) => {
    setViewType(type); setActiveTicker(null); setTimeframe('Daily'); setShowSummary(false); setSummaryData(null)
    if (type === 'Themes' && baskets.Themes.length > 0) setSelectedItem(baskets.Themes[0]);
    else if (type === 'Sectors' && baskets.Sectors.length > 0) setSelectedItem(baskets.Sectors[0]);
    else if (type === 'Industries' && baskets.Industries.length > 0) setSelectedItem(baskets.Industries[0]);
    else if (type === 'Tickers' && tickers.length > 0) setSelectedItem(tickers[0]);
  }

  const getItemsForView = () => {
    switch(viewType) {
      case 'Themes': return baskets.Themes;
      case 'Sectors': return baskets.Sectors;
      case 'Industries': return baskets.Industries;
      case 'Tickers': return tickers;
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
            </div>
          </div>
          <div className="sidebar-scrollable-content">
            <ul className="sidebar-list">
              {getItemsForView().map(item => (
                <li key={item} className={`sidebar-item ${selectedItem === item && !activeTicker ? 'active' : ''}`}
                    onClick={() => { setSelectedItem(item); setActiveTicker(null); setSummaryData(null); }}>
                  {item.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
            {viewType !== 'Tickers' && composition.length > 0 && (
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
            <div className="header-controls">
              {(viewType === 'Tickers' || activeTicker) && (
                <div className="timeframe-selector" style={{ marginRight: '15px' }}>
                  <button className={`control-btn ${timeframe === 'Daily' ? 'primary' : ''}`} onClick={() => setTimeframe('Daily')}>Daily</button>
                  <button className={`control-btn ${timeframe === '1m' ? 'primary' : ''}`} onClick={() => setTimeframe('1m')}>1m</button>
                  <button className={`control-btn ${timeframe === '5m' ? 'primary' : ''}`} onClick={() => setTimeframe('5m')}>5m</button>
                  <button className={`control-btn ${timeframe === '30m' ? 'primary' : ''}`} onClick={() => setTimeframe('30m')}>30m</button>
                </div>
              )}
              <div className="date-range-group">
                <input type="date" className="date-input" value={startDate} onChange={e => setStartDate(e.target.value)} />
                <span className="date-separator">to</span>
                <input type="date" className="date-input" value={endDate} onChange={e => setEndDate(e.target.value)} />
                <button className="control-btn primary" onClick={() => setRangeUpdateTrigger({ from: startDate, to: endDate })}>Go</button>
              </div>
              {canShowSummary && (
                <button
                  className={`control-btn ${showSummary ? 'primary' : ''}`}
                  onClick={() => setShowSummary(prev => !prev)}
                >
                  Summary
                </button>
              )}
              <button className="control-btn" onClick={() => setRangeUpdateTrigger({ reset1Y: true })}>Reset 1Y</button>
              <button className="control-btn" onClick={() => setExportTrigger(p => p + 1)}>Export Image</button>
            </div>
          </div>
          <div className={`content-stack ${showSummary ? 'with-summary' : ''}`}>
            <div className="chart-container">
            <div className="chart-overlay-toggles">
              <label className="overlay-checkbox"><input type="checkbox" checked={showPivots} onChange={e => setShowPivots(e.target.checked)} /> Pivots</label>
              <label className="overlay-checkbox"><input type="checkbox" checked={showTargets} onChange={e => setShowTargets(e.target.checked)} /> Targets</label>
              <label className="overlay-checkbox"><input type="checkbox" checked={showVolume} onChange={e => setShowVolume(e.target.checked)} /> Volume</label>
            </div>
            {chartData && chartData.length > 0 ? (
              <TVChart data={chartData} liveUpdate={liveUpdate} showPivots={showPivots} showTargets={showTargets} showVolume={showVolume} rangeUpdateTrigger={rangeUpdateTrigger} exportTrigger={exportTrigger} symbolName={activeTicker || selectedItem} />
            ) : (
              <div className="no-data">{selectedItem ? "No data found" : "Select an item"}</div>
            )}
            </div>
            {showSummary && (
              <BasketSummary data={summaryData} loading={summaryLoading} />
            )}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  )
}
export default App
