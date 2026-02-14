import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import PreviewErrorView from '../components/preview-tab/PreviewErrorView';
import PreviewLoadingOverlay from '../components/preview-tab/PreviewLoadingOverlay';

describe('preview tab overlays', () => {
  test('PreviewLoadingOverlay renders title and placeholder recovery actions', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onFix = vi.fn();

    render(
      <PreviewLoadingOverlay
        title="Preview is not loading"
        subtitle="Attempt 1/3"
        isPlaceholderDetected={true}
        reloadIframe={onRetry}
        dispatchPreviewFixGoal={onFix}
        shouldShowUrl={true}
        normalizedDisplayedUrl="http://localhost:5000/preview/p1"
        newTabUrl="http://localhost:5173/"
      />
    );

    expect(screen.getByText('Preview is not loading')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await user.click(screen.getByRole('button', { name: 'Fix with AI' }));
    expect(onRetry).toHaveBeenCalled();
    expect(onFix).toHaveBeenCalled();
  });

  test('PreviewErrorView shows backend logs button and opens logs modal', async () => {
    const user = userEvent.setup();
    const setShowBackendLogsModal = vi.fn();

    render(
      <PreviewErrorView
        showAutoRecoverSwoosh={false}
        autoRecoverCopy={null}
        failureDetails={{ title: 'Project not running', message: 'Preview unavailable' }}
        showNotRunningState={false}
        handleStartProject={vi.fn()}
        startInFlight={false}
        startLabel="Start Project"
        reloadIframe={vi.fn()}
        dispatchPreviewFixGoal={vi.fn()}
        hasBackendLogs={true}
        setShowBackendLogsModal={setShowBackendLogsModal}
        frontendProcess={null}
        renderContextMenu={() => null}
        canvasRef={{ current: null }}
        iframeRef={{ current: null }}
        resolvedPreviewPhase="error"
        isSoftReloading={false}
        iframeKey={0}
        effectivePreviewUrl="about:blank"
        project={{ name: 'Demo' }}
        handleIframeError={vi.fn()}
        handleIframeLoad={vi.fn()}
        showBackendLogsModal={false}
        backendLogsText="line1"
      />
    );

    await user.click(screen.getByRole('button', { name: 'View backend logs' }));
    expect(setShowBackendLogsModal).toHaveBeenCalledWith(true);
  });

  test('PreviewErrorView uses default iframe title and ready class when showing not-running canvas', () => {
    render(
      <PreviewErrorView
        showAutoRecoverSwoosh={false}
        autoRecoverCopy={null}
        failureDetails={{ title: '', message: 'Preview unavailable' }}
        showNotRunningState={true}
        handleStartProject={vi.fn()}
        startInFlight={false}
        startLabel="Start Project"
        reloadIframe={vi.fn()}
        dispatchPreviewFixGoal={vi.fn()}
        hasBackendLogs={false}
        setShowBackendLogsModal={vi.fn()}
        frontendProcess={null}
        renderContextMenu={() => null}
        canvasRef={{ current: null }}
        iframeRef={{ current: null }}
        resolvedPreviewPhase="ready"
        isSoftReloading={false}
        iframeKey={1}
        effectivePreviewUrl="about:blank"
        project={null}
        handleIframeError={vi.fn()}
        handleIframeLoad={vi.fn()}
        showBackendLogsModal={false}
        backendLogsText=""
      />
    );

    const iframe = screen.getByTestId('preview-iframe');
    expect(iframe).toHaveAttribute('title', 'Project Preview');
    expect(iframe.className.includes('full-iframe--loading')).toBe(false);
  });

  test('PreviewErrorView closes backend logs modal via SettingsModal close action', async () => {
    const user = userEvent.setup();
    const setShowBackendLogsModal = vi.fn();

    render(
      <PreviewErrorView
        showAutoRecoverSwoosh={false}
        autoRecoverCopy={null}
        failureDetails={{ title: '', message: 'Preview unavailable' }}
        showNotRunningState={false}
        handleStartProject={vi.fn()}
        startInFlight={false}
        startLabel="Start Project"
        reloadIframe={vi.fn()}
        dispatchPreviewFixGoal={vi.fn()}
        hasBackendLogs={true}
        setShowBackendLogsModal={setShowBackendLogsModal}
        frontendProcess={null}
        renderContextMenu={() => null}
        canvasRef={{ current: null }}
        iframeRef={{ current: null }}
        resolvedPreviewPhase="error"
        isSoftReloading={false}
        iframeKey={0}
        effectivePreviewUrl="about:blank"
        project={{ name: 'Demo' }}
        handleIframeError={vi.fn()}
        handleIframeLoad={vi.fn()}
        showBackendLogsModal={true}
        backendLogsText="line1"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Close backend logs' }));
    expect(setShowBackendLogsModal).toHaveBeenCalledWith(false);
  });
});
