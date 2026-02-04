import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './LLMUsageTab.css';

const DEFAULT_REFRESH_MS = 2000;

const formatMetricsJson = (metrics) => JSON.stringify(metrics || {}, null, 2);

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const parsePhaseTypeCounters = (counters) => {
  if (!counters || typeof counters !== 'object') {
    return [];
  }

  return Object.entries(counters)
    .filter(([key]) => key.startsWith('phase_type:'))
    .map(([key, count]) => {
      const rest = key.slice('phase_type:'.length);
      const [phase, requestType] = rest.split('::');
      return {
        phase: phase || 'unknown',
        requestType: requestType || 'unknown',
        count: toNumber(count)
      };
    })
    .sort((a, b) => b.count - a.count);
};

const getKindCount = (counters, kind) => toNumber(counters?.[`kind:${kind}`]);

const LLMUsageTab = () => {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [copiedAt, setCopiedAt] = useState(null);
  const abortRef = useRef(null);

  const fetchMetrics = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/llm/request-metrics', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Failed to load LLM metrics (${response.status})`);
      }

      const payload = await response.json();
      if (!payload?.success) {
        throw new Error(payload?.error || 'Failed to load LLM metrics');
      }

      setMetrics(payload.metrics || null);
    } catch (fetchError) {
      if (fetchError?.name === 'AbortError') {
        return;
      }
      setError(fetchError?.message || 'Failed to load LLM metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  const resetMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/llm/request-metrics/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        throw new Error(`Failed to reset LLM metrics (${response.status})`);
      }

      const payload = await response.json();
      if (!payload?.success) {
        throw new Error(payload?.error || 'Failed to reset LLM metrics');
      }

      setMetrics(payload.metrics || null);
    } catch (resetError) {
      setError(resetError?.message || 'Failed to reset LLM metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCopyJson = useCallback(async () => {
    const text = formatMetricsJson(metrics);

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedAt(Date.now());
        return;
      }
    } catch {
      // fall through
    }

    try {
      window.prompt('Copy JSON metrics:', text);
      setCopiedAt(Date.now());
    } catch {
      // ignore
    }
  }, [metrics]);

  useEffect(() => {
    fetchMetrics();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [fetchMetrics]);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }

    const id = window.setInterval(() => {
      fetchMetrics();
    }, DEFAULT_REFRESH_MS);

    return () => {
      window.clearInterval(id);
    };
  }, [autoRefresh, fetchMetrics]);

  const counters = metrics?.counters || {};

  const summary = useMemo(
    () => ({
      requested: getKindCount(counters, 'requested'),
      outbound: getKindCount(counters, 'outbound')
    }),
    [counters]
  );

  const phaseTypeRows = useMemo(() => {
    const rows = parsePhaseTypeCounters(counters);
    const filter = filterText.trim().toLowerCase();
    if (!filter) {
      return rows;
    }

    return rows.filter((row) =>
      `${row.phase} ${row.requestType}`.toLowerCase().includes(filter)
    );
  }, [counters, filterText]);

  const startedAt = metrics?.startedAt;
  const now = metrics?.now;

  return (
    <div className="llm-usage-tab" data-testid="llm-usage-tab-content">
      <div className="llm-usage-header">
        <div>
          <h2>LLM Usage</h2>
          <div className="llm-usage-subtitle">
            Tracks requested calls vs outbound API calls.
          </div>
        </div>

        <div className="llm-usage-controls">
          <button
            type="button"
            className="llm-usage-btn"
            onClick={fetchMetrics}
            disabled={loading}
            data-testid="llm-usage-refresh"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="llm-usage-btn destructive"
            onClick={resetMetrics}
            disabled={loading}
            data-testid="llm-usage-reset"
          >
            Reset
          </button>
          <button
            type="button"
            className="llm-usage-btn"
            onClick={handleCopyJson}
            disabled={!metrics}
            data-testid="llm-usage-copy"
          >
            Copy JSON
          </button>
        </div>
      </div>

      <div className="llm-usage-meta">
        <label className="llm-usage-toggle">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(Boolean(e.target.checked))}
          />
          Auto-refresh
        </label>

        <input
          className="llm-usage-filter"
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter phases (e.g. classification, code_edit…)"
          aria-label="Filter metrics"
          data-testid="llm-usage-filter"
        />

        {copiedAt && (
          <span className="llm-usage-copied" data-testid="llm-usage-copied">
            Copied
          </span>
        )}

        <div className="llm-usage-time">
          <span>Started: {startedAt || '—'}</span>
          <span>Now: {now || '—'}</span>
        </div>
      </div>

      {error && (
        <div className="llm-usage-error" role="alert">
          {error}
        </div>
      )}

      <div className="llm-usage-summary">
        <div className="llm-usage-card">
          <div className="llm-usage-card-title">Requested</div>
          <div className="llm-usage-card-value" data-testid="llm-usage-requested">
            {summary.requested}
          </div>
          <div className="llm-usage-card-note">Calls into LLMClient</div>
        </div>

        <div className="llm-usage-card">
          <div className="llm-usage-card-title">Outbound</div>
          <div className="llm-usage-card-value" data-testid="llm-usage-outbound">
            {summary.outbound}
          </div>
          <div className="llm-usage-card-note">Actual provider requests</div>
        </div>
      </div>

      <div className="llm-usage-table">
        <div className="llm-usage-table-header">
          <span>Phase</span>
          <span>Request type</span>
          <span className="numeric">Count</span>
        </div>
        {phaseTypeRows.length ? (
          <div className="llm-usage-table-body" data-testid="llm-usage-phase-table">
            {phaseTypeRows.map((row) => (
              <div
                key={`${row.phase}::${row.requestType}`}
                className="llm-usage-table-row"
              >
                <span className="mono">{row.phase}</span>
                <span className="mono">{row.requestType}</span>
                <span className="numeric">{row.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="llm-usage-table-empty" data-testid="llm-usage-phase-empty">
            No phase metrics yet.
          </div>
        )}
      </div>
    </div>
  );
};

export default LLMUsageTab;

export const __testHooks = {
  formatMetricsJson
};
