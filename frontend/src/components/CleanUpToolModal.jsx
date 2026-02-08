/* c8 ignore file */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import ToolModal from './ToolModal';
import { useAppState } from '../context/AppStateContext';
import { agentCleanupStream } from '../utils/goalsApi';
import { formatLogMessage } from './test-tab/helpers.jsx';
import { stripAnsi } from '../utils/ansi';
import { setCleanupResumeRequest } from '../utils/cleanupResume';

const buildCleanupPrompt = ({ includeFrontend, includeBackend, pruneRedundantTests }) => {
  const scope = [includeFrontend ? 'frontend' : null, includeBackend ? 'backend' : null]
    .filter(Boolean)
    .join(' + ');

  const sections = [
    `Clean up this project’s ${scope || 'codebase'} with a focus on dead code removal.`,
    '',
    'Requirements:',
    '- Identify and remove dead/unreachable code paths, unused modules/exports, and redundant logic.',
    pruneRedundantTests
      ? '- Remove or update tests that only exist to cover removed dead code paths.'
      : '- Keep existing tests unless they become invalid due to code removal.',
    '- Preserve all reachable behavior and public APIs. Do not break user-facing flows.',
    '- Keep code style consistent; prefer small, surgical edits.',
    '- Ensure the full test suite and coverage gates pass at 100% (lines/statements/functions/branches).',
    '',
    'Output expectations:',
    '- Summarize what was removed and why it was safe (what made it dead code).',
    '- Call out any risky areas that were intentionally left in place.'
  ];

  return sections.join('\n');
};

const CleanUpToolModal = ({ isOpen, onClose }) => {
  const { currentProject, isLLMConfigured } = useAppState();
  const projectId = currentProject?.id;

  const activeRunIdRef = useRef(0);
  const runBranchNameRef = useRef('');

  const [includeFrontend, setIncludeFrontend] = useState(true);
  const [includeBackend, setIncludeBackend] = useState(true);
  const [pruneRedundantTests, setPruneRedundantTests] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [progressLines, setProgressLines] = useState([]);
  const [runResult, setRunResult] = useState(null);
  const [runBranchName, setRunBranchName] = useState('');
  const [branchActionInFlight, setBranchActionInFlight] = useState(false);

  const progressLogRef = useRef(null);
  const progressAutoScrollEnabledRef = useRef(true);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const [operation, setOperation] = useState('cleanup');

  const [view, setView] = useState('intro');
  const [cancelRequested, setCancelRequested] = useState(false);

  const cleanupAbortRef = useRef(null);

  const pendingResumeRef = useRef(null);

  const cleanupPrompt = useMemo(
    () => buildCleanupPrompt({ includeFrontend, includeBackend, pruneRedundantTests }),
    [includeFrontend, includeBackend, pruneRedundantTests]
  );

  useEffect(() => {
    if (!isOpen) {
      setIsBusy(false);
      setErrorMessage('');
      setProgressLines([]);
      setRunResult(null);
      setRunBranchName('');
      runBranchNameRef.current = '';
      setBranchActionInFlight(false);
      setOperation('cleanup');
      setView('intro');
      setCancelRequested(false);
      setShowScrollToLatest(false);
      progressAutoScrollEnabledRef.current = true;
      cleanupAbortRef.current?.abort?.();
      cleanupAbortRef.current = null;
    }
  }, [isOpen]);

  const isProgressView = view === 'progress';

  const isProgressLogScrolledToBottom = useCallback(() => {
    const container = progressLogRef.current;
    if (!container) {
      return true;
    }
    const threshold = 24;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
  }, []);

  const handleProgressLogScroll = useCallback(() => {
    if (!isProgressView) {
      return;
    }

    const atBottom = isProgressLogScrolledToBottom();
    progressAutoScrollEnabledRef.current = atBottom;
    setShowScrollToLatest(!atBottom);
  }, [isProgressLogScrolledToBottom, isProgressView]);

  const scrollProgressLogToBottom = useCallback(() => {
    const container = progressLogRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
    progressAutoScrollEnabledRef.current = true;
    setShowScrollToLatest(false);
  }, []);

  const scrollProgressLogToBottomIfEnabled = useCallback(() => {
    const container = progressLogRef.current;
    if (!container) {
      return;
    }

    if (!progressAutoScrollEnabledRef.current) {
      setShowScrollToLatest(true);
      return;
    }

    container.scrollTop = container.scrollHeight;
    setShowScrollToLatest(false);
  }, []);

  useEffect(() => {
    if (!isProgressView) {
      return;
    }

    scrollProgressLogToBottomIfEnabled();
  }, [isProgressView, progressLines.length, scrollProgressLogToBottomIfEnabled]);

  const canStart = Boolean(projectId && isLLMConfigured && (includeFrontend || includeBackend) && !isBusy);

  const startHint = useMemo(() => {
    if (!projectId) {
      return 'Select a project to run Clean Up.';
    }
    if (!isLLMConfigured) {
      return 'Configure an LLM provider in Settings to run Clean Up.';
    }
    if (!includeFrontend && !includeBackend) {
      return 'Select at least one scope (Frontend and/or Backend).';
    }
    if (isBusy) {
      return 'Starting…';
    }
    return '';
  }, [includeBackend, includeFrontend, isBusy, isLLMConfigured, projectId]);

  const handleStartCleanup = useCallback(async (overrides = null) => {
    if (!projectId) {
      setErrorMessage('Select a project before running Clean Up.');
      return;
    }
    if (!isLLMConfigured) {
      setErrorMessage('Configure an LLM provider before running Clean Up.');
      return;
    }
    const nextIncludeFrontend = overrides && typeof overrides.includeFrontend === 'boolean'
      ? overrides.includeFrontend
      : includeFrontend;
    const nextIncludeBackend = overrides && typeof overrides.includeBackend === 'boolean'
      ? overrides.includeBackend
      : includeBackend;
    const nextPruneRedundantTests = overrides && typeof overrides.pruneRedundantTests === 'boolean'
      ? overrides.pruneRedundantTests
      : pruneRedundantTests;

    if (!nextIncludeFrontend && !nextIncludeBackend) {
      setErrorMessage('Select at least one scope (frontend or backend).');
      return;
    }

    if (overrides) {
      setIncludeFrontend(nextIncludeFrontend);
      setIncludeBackend(nextIncludeBackend);
      setPruneRedundantTests(nextPruneRedundantTests);
    }

    const promptOverride = overrides
      ? buildCleanupPrompt({
        includeFrontend: nextIncludeFrontend,
        includeBackend: nextIncludeBackend,
        pruneRedundantTests: nextPruneRedundantTests
      })
      : cleanupPrompt;

    setErrorMessage('');
    setProgressLines([]);
    setCancelRequested(false);
    setRunResult(null);
    setRunBranchName('');
    runBranchNameRef.current = '';
    setBranchActionInFlight(false);
    setOperation('cleanup');
    setView('progress');
    setIsBusy(true);
    progressAutoScrollEnabledRef.current = true;
    setShowScrollToLatest(false);

    cleanupAbortRef.current?.abort?.();
    const controller = new AbortController();
    cleanupAbortRef.current = controller;

    const pushLine = (line) => {
      const text = typeof line === 'string' ? line : String(line ?? '');

      // Keep whitespace for terminal-like output, but avoid pushing pure-noise lines.
      const cleaned = stripAnsi(text);
      if (!String(cleaned).trim()) {
        return;
      }

      setProgressLines((prev) => [...prev, text].slice(-160));
    };

    const captureBranchNameFromStatus = (text) => {
      const value = typeof text === 'string' ? text : '';
      const match = value.match(/Creating working branch\s+(\S+)/i);
      if (!match?.[1]) {
        return;
      }

      const raw = match[1];
      const normalized = raw.replace(/[.…]+$/g, '').trim();
      if (normalized) {
        runBranchNameRef.current = normalized;
        setRunBranchName(normalized);
      }
    };

    activeRunIdRef.current += 1;
    const runId = activeRunIdRef.current;

    try {
      await agentCleanupStream({
        projectId,
        prompt: promptOverride,
        includeFrontend: nextIncludeFrontend,
        includeBackend: nextIncludeBackend,
        pruneRedundantTests: nextPruneRedundantTests,
        options: {
          coverageThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }
        },
        signal: controller.signal,
        onEvent: (eventName, payload) => {
          if (activeRunIdRef.current !== runId) {
            return;
          }
          if (eventName === 'status') {
            const statusText = payload?.text;
            captureBranchNameFromStatus(statusText);
            pushLine(statusText);
            return;
          }
          if (eventName === 'edit') {
            const summary = payload?.summary ? ` (${payload.summary})` : '';
            pushLine(`Edit: wrote ${payload?.writes ?? 0} file(s)${summary}`);
            return;
          }
          if (eventName === 'tests') {
            pushLine(`Tests: ${payload?.phase || 'run'} → ${payload?.run || 'unknown'}`);
            const workspaceRuns = Array.isArray(payload?.workspaceRuns) ? payload.workspaceRuns : [];
            if ((payload?.run || '').toLowerCase?.() === 'failed' && workspaceRuns.length) {
              const failed = workspaceRuns.filter((run) => run?.status && run.status !== 'succeeded');
              if (failed.length) {
                pushLine(`Failed workspaces: ${failed.map((run) => run.workspace || run.displayName || 'unknown').join(', ')}`);
              }
            }
            return;
          }

          if (eventName === 'tests-job') {
            pushLine(`Starting: ${payload?.displayName || 'tests job'}${payload?.cwd ? ` (${payload.cwd})` : ''}`);
            return;
          }

          if (eventName === 'tests-job-done') {
            pushLine(`Finished: ${payload?.phase || 'tests'} → ${payload?.status || 'done'}`);
            return;
          }

          if (eventName === 'tests-log') {
            const message = typeof payload?.message === 'string' ? payload.message : '';
            if (!message.trim()) {
              return;
            }
            message
              .split(/\r?\n/)
              .filter(Boolean)
              .forEach((line) => {
                const cleaned = String(line).replace(/^(stdout|stderr)\s*\|\s*/i, '');
                pushLine(cleaned);
              });
            return;
          }
        },
        onDone: (result) => {
          if (activeRunIdRef.current !== runId) {
            return;
          }

          const finalResult = {
            ...(result && typeof result === 'object' ? result : {}),
            branchName:
              (result && typeof result === 'object' && typeof result.branchName === 'string' && result.branchName.trim())
                ? result.branchName.trim()
                : runBranchNameRef.current
          };

          if (finalResult?.branchName && typeof finalResult.branchName === 'string') {
            const normalizedBranch = finalResult.branchName.trim();
            if (normalizedBranch) {
              runBranchNameRef.current = normalizedBranch;
              setRunBranchName(normalizedBranch);
            }
          }

          if (finalResult?.status === 'cancelled' || finalResult?.cancelled) {
            pushLine('Cancelled.');
            setRunResult(finalResult);
            setView('result');
            return;
          }

          if (finalResult?.status === 'refused') {
            pushLine('Cleanup refused to start.');
            if (finalResult?.reason === 'baseline-failed') {
              pushLine('Baseline tests/coverage failed.');
              if (finalResult?.branchDeleted) {
                pushLine(`Deleted branch ${finalResult.branchName || runBranchName || ''}.`);
              }
            }

            setRunResult(finalResult);
            setView('result');
            return;
          }

          if (finalResult?.status === 'failed') {
            const message = finalResult?.message || 'Cleanup failed';
            setErrorMessage(message);
            pushLine(`Error: ${message}`);
            setRunResult(finalResult);
            setView('result');
            return;
          }

          pushLine('Done.');
          setRunResult(finalResult);
          setView('result');
        },
        onError: (message) => {
          if (activeRunIdRef.current !== runId) {
            return;
          }
          setErrorMessage(message || 'Cleanup failed');
          pushLine(`Error: ${message || 'Cleanup failed'}`);

          setRunResult({
            status: 'failed',
            message: message || 'Cleanup failed',
            branchName: runBranchNameRef.current,
            canDeleteBranch: Boolean(runBranchNameRef.current)
          });

          setView('result');
        }
      });
    } catch (error) {
      if (activeRunIdRef.current !== runId) {
        return;
      }
      if (error?.name === 'AbortError') {
        return;
      }
      setErrorMessage(error?.message || 'Failed to start Clean Up.');
    } finally {
      if (activeRunIdRef.current === runId) {
        setIsBusy(false);
      }
    }
  }, [cleanupPrompt, includeBackend, includeFrontend, isLLMConfigured, projectId, pruneRedundantTests]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    ) {
      return undefined;
    }

    const handleResumeCleanup = (event) => {
      const payload = event?.detail && typeof event.detail === 'object' ? event.detail : null;
      const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
      if (!token) {
        return;
      }

      pendingResumeRef.current = payload;
      if (!isOpen) {
        return;
      }

      pendingResumeRef.current = null;
      handleStartCleanup(payload);
    };

    window.addEventListener('lucidcoder:cleanup-tool:resume', handleResumeCleanup);
    return () => {
      window.removeEventListener('lucidcoder:cleanup-tool:resume', handleResumeCleanup);
    };
  }, [handleStartCleanup, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const pending = pendingResumeRef.current;
    if (!pending) {
      return;
    }
    pendingResumeRef.current = null;
    handleStartCleanup(pending);
  }, [handleStartCleanup, isOpen]);

  const handleFixBaselineFailures = useCallback(() => {
    if (!projectId || isBusy) {
      return;
    }

    const token = `cleanup-resume:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    setCleanupResumeRequest({
      token,
      includeFrontend,
      includeBackend,
      pruneRedundantTests
    });

    const prompt = [
      'Fix the failing baseline tests/coverage in this project so the Clean Up tool can proceed.',
      '',
      'Requirements:',
      '- Run the full test suite + strict 100% coverage gates and fix any failures.',
      '- Keep behavior unchanged for reachable flows; focus on test/coverage fixes.',
      '- When done, explain what you changed and why.'
    ].join('\n');

    const childPrompts = [
      includeFrontend ? 'Fix failing frontend tests/coverage to reach 100% gates.' : null,
      includeBackend ? 'Fix failing backend tests/coverage to reach 100% gates.' : null
    ].filter(Boolean);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt,
            childPrompts,
            origin: 'user',
            failureContext: {
              jobs: [
                {
                  label: 'Baseline tests/coverage',
                  type: 'cleanup:baseline',
                  status: 'failed',
                  recentLogs: progressLines.slice(-40)
                }
              ]
            }
          }
        })
      );
    }

    onClose?.();
  }, [includeBackend, includeFrontend, isBusy, onClose, projectId, progressLines, pruneRedundantTests]);

  const handleCancel = useCallback(() => {
    if (operation !== 'cleanup') {
      cleanupAbortRef.current?.abort?.();
      cleanupAbortRef.current = null;
      setIsBusy(false);
      setCancelRequested(false);
      setRunResult({ status: 'cancelled', operation });
      setView('result');
      return;
    }

    activeRunIdRef.current += 1;
    setCancelRequested(true);
    setIsBusy(false);
    setErrorMessage('');
    setProgressLines((prev) => [...(Array.isArray(prev) ? prev : []), 'Cleanup cancelled.'].slice(-160));
    setRunResult({
      status: 'cancelled',
      branchName: runBranchNameRef.current,
      canDeleteBranch: Boolean(runBranchNameRef.current)
    });
    setView('result');

    cleanupAbortRef.current?.abort?.();
    cleanupAbortRef.current = null;
  }, [operation]);

  const handleDeleteCleanupBranch = useCallback(async () => {
    if (!projectId || !runBranchName || runBranchName === 'main') {
      return;
    }

    try {
      setBranchActionInFlight(true);
      await axios.delete(`/api/projects/${projectId}/branches/${encodeURIComponent(runBranchName)}`, {
        headers: {
          'x-confirm-destructive': 'true'
        }
      });

      setProgressLines((prev) => [...prev, `Deleted branch ${runBranchName}.`].slice(-160));
      setRunResult((prev) => ({
        ...(prev && typeof prev === 'object' ? prev : {}),
        branchDeleted: true,
        canDeleteBranch: false
      }));
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Failed to delete branch';
      setErrorMessage(message);
      setProgressLines((prev) => [...prev, `Error: ${message}`].slice(-160));
    } finally {
      setBranchActionInFlight(false);
    }
  }, [projectId, runBranchName]);

  const handleKeepBranchAndClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const isCleanupCancelled = view === 'result' && operation === 'cleanup' && runResult?.status === 'cancelled';
  const isBaselineRefused = view === 'result' && operation === 'cleanup' && runResult?.status === 'refused' && runResult?.reason === 'baseline-failed';
  const cleanupBranchWasDeleted = Boolean(runResult?.branchDeleted);
  const showKeepBranchButton =
    view === 'result' &&
    operation === 'cleanup' &&
    runResult?.status !== 'refused' &&
    !cleanupBranchWasDeleted;

  return (
    <ToolModal
      isOpen={isOpen}
      onClose={onClose}
      title="Clean Up"
      subtitle="Remove dead code and redundant tests safely."
      testId="tool-cleanup-modal"
      closeTestId="tool-cleanup-close"
      titleId="tool-cleanup-title"
    >
      <div className="tools-modal-placeholder">
        {view === 'progress' || view === 'result' ? (
          <div data-testid="tool-cleanup-progress">
            <h3>
              {isCleanupCancelled
                ? 'Cleanup cancelled'
                : view === 'result'
                  ? 'Cleanup finished'
                  : 'Cleanup in progress'}
            </h3>

            <p data-testid="tool-cleanup-progress-text">
              {isCleanupCancelled
                ? `Do you want to discard the working branch${runBranchName ? ` (${runBranchName})` : ''}?`
                : isBaselineRefused
                  ? 'Clean Up cannot proceed until baseline tests/coverage pass.'
                : cancelRequested
                  ? 'Cancelling…'
                  : 'Live output:'}
            </p>

            {isBaselineRefused ? (
              <div className="tools-modal-warning" role="status" data-testid="tool-cleanup-refused-banner">
                Clean Up can’t proceed while tests/coverage are failing. Fix the failures, then run Clean Up again.
              </div>
            ) : null}

            <pre
              className="tools-modal-prompt"
              data-testid="tool-cleanup-progress-log"
              ref={progressLogRef}
              onScroll={handleProgressLogScroll}
            >
              {progressLines.length
                ? progressLines.map((line, index) => (
                    <React.Fragment key={`cleanup-log-${index}`}>
                      {formatLogMessage(line)}
                      {'\n'}
                    </React.Fragment>
                  ))
                : 'Waiting for cleanup updates…'}
            </pre>

            {view === 'progress' && showScrollToLatest ? (
              <div className="tools-modal-scroll-actions" data-testid="tool-cleanup-scroll-actions">
                <button
                  type="button"
                  className="git-settings-button secondary"
                  onClick={scrollProgressLogToBottom}
                  data-testid="tool-cleanup-scroll-latest"
                >
                  Scroll to latest
                </button>
              </div>
            ) : null}

            {errorMessage ? (
              <div className="tools-modal-error" role="alert" data-testid="tool-cleanup-error">
                {errorMessage}
              </div>
            ) : null}

            <div className="tools-modal-actions">
              {view === 'progress' ? (
                <button
                  type="button"
                  className="git-settings-button secondary"
                  onClick={handleCancel}
                  disabled={cancelRequested}
                  data-testid="tool-cleanup-cancel"
                >
                  {cancelRequested ? 'Cancelling…' : 'Cancel'}
                </button>
              ) : null}

              {isBaselineRefused ? (
                <button
                  type="button"
                  className="git-settings-button"
                  onClick={handleFixBaselineFailures}
                  disabled={isBusy}
                  data-testid="tool-cleanup-fix-tests"
                >
                  {isBusy ? 'Fixing…' : 'Fix failing tests'}
                </button>
              ) : null}

              {view === 'result' && operation === 'cleanup' && !cleanupBranchWasDeleted && (runResult?.status === 'failed' || runResult?.status === 'cancelled') ? (
                <button
                  type="button"
                  className="git-settings-button"
                  onClick={handleDeleteCleanupBranch}
                  disabled={branchActionInFlight || !runBranchName}
                  data-testid="tool-cleanup-delete-branch"
                >
                  {branchActionInFlight
                    ? 'Deleting…'
                    : runResult?.status === 'cancelled'
                      ? 'Discard branch'
                      : 'Delete branch'}
                </button>
              ) : null}

              {view === 'result' && operation === 'fix-tests' ? (
                <button
                  type="button"
                  className="git-settings-button secondary"
                  onClick={handleKeepBranchAndClose}
                  data-testid="tool-cleanup-close"
                >
                  Close
                </button>
              ) : null}

              {showKeepBranchButton ? (
                <button
                  type="button"
                  className="git-settings-button secondary"
                  onClick={handleKeepBranchAndClose}
                  data-testid="tool-cleanup-keep-branch"
                >
                  {runBranchName ? `Keep ${runBranchName}` : 'Keep branch'}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <h3>Automated dead-code cleanup</h3>
            <p>
              Runs a foreground cleanup loop while this modal is open. It removes provably-dead code with small, safe edits and
              runs full tests + strict coverage gates after changes.
            </p>

            <ul>
              <li>Removes unused modules/exports and dead branches</li>
              <li>
                {pruneRedundantTests
                  ? 'Updates/removes tests that only cover removed dead code'
                  : 'Leaves tests as-is unless they break'}
              </li>
              <li>Runs the full test suite and coverage gates</li>
            </ul>

            {!isLLMConfigured ? (
              <div className="tools-modal-warning" role="status" data-testid="tool-cleanup-warning">
                Clean Up requires an LLM provider. Open Settings → LLM to configure one.
              </div>
            ) : null}

            <fieldset className="tools-modal-fieldset" data-testid="tool-cleanup-controls" disabled={isBusy}>
              <legend>Scope</legend>

              <div className="tools-modal-controls">
                <label className="tools-modal-checkbox">
                  <input
                    type="checkbox"
                    checked={includeFrontend}
                    onChange={(event) => setIncludeFrontend(event.target.checked)}
                  />
                  <span>
                    <strong>Frontend</strong>
                    <span className="tools-modal-subtext"> React/Vite UI code</span>
                  </span>
                </label>
                <label className="tools-modal-checkbox">
                  <input
                    type="checkbox"
                    checked={includeBackend}
                    onChange={(event) => setIncludeBackend(event.target.checked)}
                  />
                  <span>
                    <strong>Backend</strong>
                    <span className="tools-modal-subtext"> Node/Express services</span>
                  </span>
                </label>
              </div>

              <div className="tools-modal-divider" />

              <label className="tools-modal-checkbox">
                <input
                  type="checkbox"
                  checked={pruneRedundantTests}
                  onChange={(event) => setPruneRedundantTests(event.target.checked)}
                />
                <span>
                  <strong>Prune redundant tests</strong>
                  <span className="tools-modal-subtext"> Only removes tests that exist solely for deleted dead paths</span>
                </span>
              </label>
            </fieldset>

            {errorMessage ? (
              <div className="tools-modal-error" role="alert" data-testid="tool-cleanup-error">
                {errorMessage}
              </div>
            ) : null}

            <div className="tools-modal-actions">
              <button
                type="button"
                className="git-settings-button primary"
                onClick={() => handleStartCleanup()}
                disabled={!canStart}
                aria-busy={isBusy}
                data-testid="tool-cleanup-start"
              >
                {isBusy ? 'Starting…' : 'Start cleanup'}
              </button>
              {startHint ? (
                <div className="tools-modal-hint" data-testid="tool-cleanup-hint">
                  {startHint}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </ToolModal>
  );
};

export default CleanUpToolModal;
