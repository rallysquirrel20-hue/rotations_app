import { useEffect, useState } from 'react'
import axios from 'axios'

interface SentimentInfo {
  label: 'positive' | 'negative' | 'neutral'
  score: number
}

interface NewsArticle {
  title: string
  url: string
  snippet: string
  source: string
  sentiment: SentimentInfo
  scraped_at: string
}

interface Props {
  ticker: string
  apiBase: string
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#2aa198',
  negative: '#dc322f',
  neutral: '#839496',
}

const SENTIMENT_LABELS: Record<string, string> = {
  positive: 'POS',
  negative: 'NEG',
  neutral: 'NEU',
}

export function NewsSentiment({ ticker, apiBase }: Props) {
  const [articles, setArticles] = useState<NewsArticle[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ticker) return
    setLoading(true)
    setError(null)
    axios.get(`${apiBase}/news/${ticker}`, { params: { limit: 10 } })
      .then(res => {
        setArticles(res.data.articles || [])
      })
      .catch(err => {
        const msg = err.response?.data?.detail || err.message
        setError(msg)
        setArticles([])
      })
      .finally(() => setLoading(false))
  }, [ticker, apiBase])

  if (loading) {
    return <div style={styles.container}><div style={styles.loading}>Loading news for {ticker}...</div></div>
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.error}>{error}</div>
      </div>
    )
  }

  if (articles.length === 0) {
    return <div style={styles.container}><div style={styles.empty}>No news found for {ticker}</div></div>
  }

  // Aggregate sentiment
  const counts = { positive: 0, negative: 0, neutral: 0 }
  for (const a of articles) counts[a.sentiment.label]++

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>News &mdash; {ticker}</span>
        <div style={styles.sentimentBar}>
          {(['positive', 'negative', 'neutral'] as const).map(s => (
            <span key={s} style={{ ...styles.sentimentChip, color: SENTIMENT_COLORS[s] }}>
              {SENTIMENT_LABELS[s]}: {counts[s]}
            </span>
          ))}
        </div>
      </div>
      <div style={styles.list}>
        {articles.map((article, i) => (
          <div key={i} style={styles.article}>
            <div style={styles.articleHeader}>
              <span
                style={{ ...styles.sentimentDot, background: SENTIMENT_COLORS[article.sentiment.label] }}
                title={`${article.sentiment.label} (${article.sentiment.score})`}
              />
              <a href={article.url} target="_blank" rel="noopener noreferrer" style={styles.articleTitle}>
                {article.title || article.url}
              </a>
            </div>
            {article.snippet && (
              <div style={styles.snippet}>{article.snippet.slice(0, 200)}{article.snippet.length > 200 ? '...' : ''}</div>
            )}
            <div style={styles.meta}>
              {article.source && <span style={styles.source}>{article.source}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
    fontSize: '12px',
    color: '#586e75',
    background: '#fdf6e3',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    borderBottom: '1px solid #eee8d5',
    flexShrink: 0,
  },
  title: {
    fontWeight: 700,
    color: '#073642',
    fontSize: '13px',
  },
  sentimentBar: {
    display: 'flex',
    gap: '10px',
  },
  sentimentChip: {
    fontWeight: 600,
    fontSize: '11px',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 0',
  },
  article: {
    padding: '8px 12px',
    borderBottom: '1px solid #eee8d5',
  },
  articleHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  sentimentDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  articleTitle: {
    color: '#268bd2',
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: '12px',
    lineHeight: '1.3',
  },
  snippet: {
    marginTop: '4px',
    color: '#839496',
    fontSize: '11px',
    lineHeight: '1.4',
    paddingLeft: '14px',
  },
  meta: {
    marginTop: '3px',
    display: 'flex',
    gap: '8px',
    paddingLeft: '14px',
  },
  source: {
    fontSize: '10px',
    color: '#93a1a1',
  },
  loading: {
    padding: '20px',
    textAlign: 'center',
    color: '#93a1a1',
  },
  error: {
    padding: '20px',
    color: '#dc322f',
    textAlign: 'center',
  },
  empty: {
    padding: '20px',
    textAlign: 'center',
    color: '#93a1a1',
  },
}
