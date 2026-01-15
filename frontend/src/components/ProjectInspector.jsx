import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAppState } from '../context/AppStateContext';
import ChatPanel from './ChatPanel';
import PreviewPanel from './PreviewPanel';
import './ProjectInspector.css';

const MIN_ASSISTANT_WIDTH = 240;
const DEFAULT_ASSISTANT_WIDTH = 320;

const getMaxAssistantWidth = () => {
  if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') {
    return 480;
  }
  return Math.max(MIN_ASSISTANT_WIDTH, Math.floor(window.innerWidth / 2));
};

const clampAssistantWidth = (value) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return DEFAULT_ASSISTANT_WIDTH;
  }
  const maxWidth = getMaxAssistantWidth();
  return Math.min(Math.max(numeric, MIN_ASSISTANT_WIDTH), maxWidth);
};

const resolveWindowRef = (override) => {
  if (typeof override !== 'undefined') {
    return override;
  }
  return typeof window === 'undefined' ? undefined : window;
};

const ProjectInspector = () => {
  const { currentProject, assistantPanelState, updateAssistantPanelState } = useAppState();

  const persistedWidth = clampAssistantWidth(assistantPanelState?.width ?? DEFAULT_ASSISTANT_WIDTH);
  const panelPosition = assistantPanelState?.position === 'right' ? 'right' : 'left';
  const [panelWidth, setPanelWidth] = useState(persistedWidth);
  const [isResizing, setIsResizing] = useState(false);
  const rafIdRef = useRef(null);
  const pendingWidthRef = useRef(persistedWidth);
  const activeDragCleanupRef = useRef(null);

  const cancelScheduledFrame = useCallback((applyPending = false, windowOverride) => {
    const runtimeWindow = resolveWindowRef(windowOverride);
    if (!runtimeWindow) {
      if (applyPending) {
        setPanelWidth(pendingWidthRef.current);
      }
      return;
    }
    if (rafIdRef.current !== null) {
      runtimeWindow.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      if (applyPending) {
        setPanelWidth(pendingWidthRef.current);
      }
    } else if (applyPending) {
      setPanelWidth(pendingWidthRef.current);
    }
  }, []);

  const scheduleWidthUpdate = useCallback((nextWidth, options = {}) => {
    pendingWidthRef.current = nextWidth;
    const forceImmediate = Boolean(options?.forceImmediate);
    if (forceImmediate || typeof window === 'undefined') {
      setPanelWidth(nextWidth);
      return;
    }

    if (rafIdRef.current !== null) {
      return;
    }

    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      setPanelWidth(pendingWidthRef.current);
    });
  }, []);

  useEffect(() => {
    pendingWidthRef.current = persistedWidth;
    setPanelWidth(persistedWidth);
  }, [persistedWidth]);

  useEffect(() => {
    return () => {
      cancelScheduledFrame();
      if (activeDragCleanupRef.current) {
        activeDragCleanupRef.current();
      }
    };
  }, [cancelScheduledFrame]);

  useEffect(() => {
    if (!ProjectInspector.__testHooks) {
      return;
    }
    ProjectInspector.__testHooks.cancelScheduledFrame = cancelScheduledFrame;
    ProjectInspector.__testHooks.scheduleWidthUpdate = scheduleWidthUpdate;
    ProjectInspector.__testHooks.setPendingWidth = (value) => {
      pendingWidthRef.current = value;
    };
    ProjectInspector.__testHooks.getPanelWidth = () => panelWidth;
    return () => {
      if (ProjectInspector.__testHooks) {
        ProjectInspector.__testHooks.cancelScheduledFrame = undefined;
        ProjectInspector.__testHooks.scheduleWidthUpdate = undefined;
        ProjectInspector.__testHooks.setPendingWidth = undefined;
        ProjectInspector.__testHooks.getPanelWidth = undefined;
      }
    };
  }, [cancelScheduledFrame, scheduleWidthUpdate, panelWidth]);

  const handleTogglePosition = useCallback(() => {
    if (!updateAssistantPanelState) {
      return;
    }
    const nextPosition = panelPosition === 'left' ? 'right' : 'left';
    updateAssistantPanelState({ position: nextPosition });
  }, [panelPosition, updateAssistantPanelState]);

  const handleResizeStart = useCallback(
    (event) => {
      if (!updateAssistantPanelState) {
        return;
      }

      event.preventDefault();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      if (target?.setPointerCapture && typeof pointerId === 'number') {
        try {
          target.setPointerCapture(pointerId);
        } catch (captureError) {
          console.warn('Failed to set pointer capture on chat resizer', captureError);
        }
      }

      setIsResizing(true);
      const startX = event.clientX;
      const startWidth = panelWidth;
      let latestWidth = startWidth;

      const handlePointerMove = (moveEvent) => {
        const delta = panelPosition === 'left'
          ? moveEvent.clientX - startX
          : startX - moveEvent.clientX;
        latestWidth = clampAssistantWidth(startWidth + delta);
        scheduleWidthUpdate(latestWidth);
      };

      const handlePointerUp = () => {
        setIsResizing(false);
        cancelScheduledFrame(true);
        updateAssistantPanelState({ width: Math.round(latestWidth) });
        if (target?.releasePointerCapture && typeof pointerId === 'number') {
          try {
            target.releasePointerCapture(pointerId);
          } catch (releaseError) {
            console.warn('Failed to release pointer capture on chat resizer', releaseError);
          }
        }
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        activeDragCleanupRef.current = null;
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      activeDragCleanupRef.current = () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        if (target?.releasePointerCapture && typeof pointerId === 'number') {
          try {
            target.releasePointerCapture(pointerId);
          } catch (releaseError) {
            console.warn('Failed to release pointer capture on chat resizer cleanup', releaseError);
          }
        }
      };
    },
    [panelWidth, panelPosition, updateAssistantPanelState, scheduleWidthUpdate, cancelScheduledFrame]
  );

  if (!currentProject) {
    return (
      <div className="project-inspector-error">
        <h3>No project selected</h3>
        <p>Please select a project to view the inspector.</p>
      </div>
    );
  }

  const chatPanel = (
    <ChatPanel
      width={panelWidth}
      side={panelPosition}
      isResizing={isResizing}
      onToggleSide={handleTogglePosition}
    />
  );

  const resizer = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize AI assistant"
      className={`chat-resizer ${panelPosition === 'right' ? 'chat-resizer--right' : 'chat-resizer--left'} ${isResizing ? 'chat-resizer--active' : ''}`}
      onPointerDown={handleResizeStart}
      data-testid="chat-resizer"
    />
  );

  return (
    <div className="project-inspector full-height" data-testid="project-inspector">
      {panelPosition === 'left' ? (
        <>
          {chatPanel}
          {resizer}
          <PreviewPanel />
        </>
      ) : (
        <>
          <PreviewPanel />
          {resizer}
          {chatPanel}
        </>
      )}
    </div>
  );
};

export const __testClampAssistantWidth = clampAssistantWidth;
export const __testGetMaxAssistantWidth = getMaxAssistantWidth;
export const __testResolveWindowRef = resolveWindowRef;
export default ProjectInspector;

ProjectInspector.__testHooks = ProjectInspector.__testHooks || {};