import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends Event {
    constructor(type, params = {}) {
      super(type, params);
      const { bubbles, cancelable, composed, ...rest } = params;
      Object.assign(this, rest);
    }
  }
  window.PointerEvent = PointerEventPolyfill;
  global.PointerEvent = PointerEventPolyfill;
}
import ProjectInspector, { __testClampAssistantWidth, __testGetMaxAssistantWidth, __testResolveWindowRef } from '../components/ProjectInspector';
import { useAppState } from '../context/AppStateContext';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const chatPanelMock = vi.fn((props) => (
  <div data-testid="mock-chat-panel" data-side={props.side} data-width={props.width}>
    Chat Panel Mock
  </div>
));

vi.mock('../components/ChatPanel', () => ({
  __esModule: true,
  default: (props) => chatPanelMock(props)
}));

vi.mock('../components/PreviewPanel', () => ({
  default: () => <div data-testid="mock-preview-panel">Preview Panel Mock</div>
}));

const mockProject = {
  id: 'proj-1',
  name: 'Demo Project'
};

const mockState = (overrides = {}) => ({
  currentProject: mockProject,
  assistantPanelState: { width: 320, position: 'left' },
  updateAssistantPanelState: vi.fn(),
  ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  ProjectInspector.__testHooks = {};
});

const waitForHooks = async () => {
  await waitFor(() => {
    expect(typeof ProjectInspector.__testHooks.scheduleWidthUpdate).toBe('function');
  });
  return ProjectInspector.__testHooks;
};

describe('ProjectInspector Component', () => {
  test('exposes getPanelWidth through test hooks', async () => {
    useAppState.mockReturnValue(mockState({
      assistantPanelState: { width: 410, position: 'left' }
    }));

    render(<ProjectInspector />);
    const hooks = await waitForHooks();

    expect(typeof hooks.getPanelWidth).toBe('function');
    expect(hooks.getPanelWidth()).toBe(410);
  });

  describe('Utility Guards', () => {
    test('clampAssistantWidth handles invalid and boundary values', () => {
      expect(__testClampAssistantWidth('invalid')).toBe(320);
      expect(__testClampAssistantWidth(NaN)).toBe(320);
      expect(__testClampAssistantWidth(120)).toBe(240);

      const innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get');
      innerWidthSpy.mockReturnValue(700);
      expect(__testClampAssistantWidth(9999)).toBe(Math.floor(700 / 2));
      innerWidthSpy.mockRestore();
    });

    test('getMaxAssistantWidth falls back when viewport metrics are unavailable', () => {
      const innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get');
      innerWidthSpy.mockReturnValue(undefined);
      expect(__testGetMaxAssistantWidth()).toBe(480);

      innerWidthSpy.mockReturnValue(1200);
      expect(__testGetMaxAssistantWidth()).toBe(Math.max(240, Math.floor(1200 / 2)));
      innerWidthSpy.mockRestore();
    });

    test('resolveWindowRef favors overrides and handles missing window', () => {
      const fakeWindow = {};
      expect(__testResolveWindowRef(fakeWindow)).toBe(fakeWindow);

      const originalWindow = globalThis.window;
      try {
        globalThis.window = undefined;
        expect(__testResolveWindowRef()).toBeUndefined();
      } finally {
        globalThis.window = originalWindow;
      }
    });
  });

  describe('Layout Structure', () => {
    test('renders project inspector with correct layout when project is selected', () => {
      useAppState.mockReturnValue(mockState());

      render(<ProjectInspector />);

      const inspector = screen.getByTestId('project-inspector');
      expect(inspector).toBeInTheDocument();
      expect(inspector).toHaveClass('project-inspector');
      expect(inspector).toHaveClass('full-height');
    });

    test('renders chat and preview panels within layout', () => {
      useAppState.mockReturnValue(mockState());

      render(<ProjectInspector />);

      expect(screen.getByTestId('mock-chat-panel')).toBeInTheDocument();
      expect(screen.getByTestId('mock-preview-panel')).toBeInTheDocument();
      expect(screen.getByTestId('chat-resizer')).toBeInTheDocument();
    });

    test('orders panels according to assistant position', () => {
      useAppState.mockReturnValue(mockState());

      const { rerender } = render(<ProjectInspector />);
      const inspector = screen.getByTestId('project-inspector');

      let childTestIds = Array.from(inspector.children).map((child) => child.getAttribute('data-testid'));
      expect(childTestIds).toEqual([
        'mock-chat-panel',
        'chat-resizer',
        'mock-preview-panel'
      ]);

      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 360, position: 'right' }
      }));
      rerender(<ProjectInspector />);

      childTestIds = Array.from(inspector.children).map((child) => child.getAttribute('data-testid'));
      expect(childTestIds).toEqual([
        'mock-preview-panel',
        'chat-resizer',
        'mock-chat-panel'
      ]);
    });
  });

  describe('Chat Panel', () => {
    test('chat panel renders when project exists', () => {
      useAppState.mockReturnValue(mockState());

      render(<ProjectInspector />);

      expect(screen.getByTestId('mock-chat-panel')).toBeInTheDocument();
    });

    test('passes assistant width and side to chat panel', () => {
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 400, position: 'right' }
      }));

      render(<ProjectInspector />);

      const latestCall = chatPanelMock.mock.calls.at(-1)?.[0] || {};
      expect(latestCall.width).toBe(400);
      expect(latestCall.side).toBe('right');
    });

    test('toggle handler updates assistant position via context', () => {
      const updateAssistantPanelState = vi.fn();
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 350, position: 'left' },
        updateAssistantPanelState
      }));

      render(<ProjectInspector />);

      const latestCall = chatPanelMock.mock.calls.at(-1)?.[0];
      expect(typeof latestCall.onToggleSide).toBe('function');

      act(() => {
        latestCall.onToggleSide();
      });

      expect(updateAssistantPanelState).toHaveBeenCalledWith({ position: 'right' });
    });

    test('toggle handler flips right-positioned panel back to left', () => {
      const updateAssistantPanelState = vi.fn();
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 340, position: 'right' },
        updateAssistantPanelState
      }));

      render(<ProjectInspector />);

      const latestCall = chatPanelMock.mock.calls.at(-1)?.[0];
      expect(typeof latestCall.onToggleSide).toBe('function');

      act(() => {
        latestCall.onToggleSide();
      });

      expect(updateAssistantPanelState).toHaveBeenCalledWith({ position: 'left' });
    });

    test('toggle handler no-ops when updater is missing', () => {
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 330, position: 'left' },
        updateAssistantPanelState: null
      }));

      render(<ProjectInspector />);

      const latestCall = chatPanelMock.mock.calls.at(-1)?.[0];
      expect(typeof latestCall.onToggleSide).toBe('function');

      expect(() => {
        act(() => {
          latestCall.onToggleSide();
        });
      }).not.toThrow();
    });
  });

  describe('Preview Panel Tabs', () => {
    test('preview panel is rendered alongside chat panel', () => {
      useAppState.mockReturnValue(mockState());

      render(<ProjectInspector />);

      expect(screen.getByTestId('mock-preview-panel')).toBeInTheDocument();
    });
  });

  describe('Assistant Panel Resizing', () => {
    const pointerMove = (clientX) => {
      const event = new PointerEvent('pointermove', { clientX, bubbles: true });
      window.dispatchEvent(event);
    };

    const pointerUp = (clientX) => {
      const event = new PointerEvent('pointerup', { clientX, bubbles: true });
      window.dispatchEvent(event);
    };

    test('resizing left-positioned panel updates width and persists state', () => {
      const updateAssistantPanelState = vi.fn();
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 320, position: 'left' },
        updateAssistantPanelState
      }));

      render(<ProjectInspector />);

      const resizer = screen.getByTestId('chat-resizer');

      act(() => {
        fireEvent.pointerDown(resizer, { clientX: 300, bubbles: true });
        pointerMove(360);
      });

      act(() => {
        pointerUp(360);
      });

      expect(updateAssistantPanelState).toHaveBeenCalledWith({ width: 380 });
    });

    test('resizing right-positioned panel respects clamp and direction', () => {
      const updateAssistantPanelState = vi.fn();
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 450, position: 'right' },
        updateAssistantPanelState
      }));

      render(<ProjectInspector />);

      const resizer = screen.getByTestId('chat-resizer');

      act(() => {
        fireEvent.pointerDown(resizer, { clientX: 800, bubbles: true });
        pointerMove(600);
      });

      act(() => {
        pointerUp(600);
      });

      expect(updateAssistantPanelState).toHaveBeenCalledWith({ width: Math.floor(window.innerWidth / 2) });
    });

    test('ignores resize start when assistant updater is unavailable', () => {
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 320, position: 'left' },
        updateAssistantPanelState: null
      }));

      render(<ProjectInspector />);

      const resizer = screen.getByTestId('chat-resizer');
      act(() => {
        fireEvent.pointerDown(resizer, { clientX: 250, pointerId: 99, bubbles: true });
      });

      expect(resizer.className).not.toContain('chat-resizer--active');
    });

    test('logs warning when pointer capture fails during resize', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const updateAssistantPanelState = vi.fn();
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 340, position: 'left' },
        updateAssistantPanelState
      }));

      render(<ProjectInspector />);

      const resizer = screen.getByTestId('chat-resizer');
      resizer.setPointerCapture = vi.fn(() => {
        throw new Error('capture failed');
      });

      act(() => {
        fireEvent.pointerDown(resizer, { clientX: 300, pointerId: 3, bubbles: true });
        pointerMove(360);
      });

      act(() => {
        pointerUp(360);
      });

      expect(warnSpy).toHaveBeenCalledWith('Failed to set pointer capture on chat resizer', expect.any(Error));
      warnSpy.mockRestore();
    });

    test('logs warning when releasing pointer capture fails on pointer up', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const updateAssistantPanelState = vi.fn();
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 360, position: 'left' },
        updateAssistantPanelState
      }));

      render(<ProjectInspector />);

      const resizer = screen.getByTestId('chat-resizer');
      resizer.setPointerCapture = vi.fn();
      resizer.releasePointerCapture = vi.fn(() => {
        throw new Error('release failed');
      });

      act(() => {
        fireEvent.pointerDown(resizer, { clientX: 320, pointerId: 7, bubbles: true });
        pointerMove(400);
      });

      act(() => {
        pointerUp(400);
      });

      expect(warnSpy).toHaveBeenCalledWith('Failed to release pointer capture on chat resizer', expect.any(Error));
      warnSpy.mockRestore();
    });

    test('cleanup releases pointer capture and handles errors when drag is aborted', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const updateAssistantPanelState = vi.fn();
      useAppState.mockReturnValue(mockState({
        assistantPanelState: { width: 360, position: 'left' },
        updateAssistantPanelState
      }));

      const { unmount } = render(<ProjectInspector />);

      const resizer = screen.getByTestId('chat-resizer');
      resizer.setPointerCapture = vi.fn();
      resizer.releasePointerCapture = vi.fn(() => {
        throw new Error('cleanup release failed');
      });

      act(() => {
        fireEvent.pointerDown(resizer, { clientX: 330, pointerId: 11, bubbles: true });
        pointerMove(360);
      });

      unmount();

      expect(warnSpy).toHaveBeenCalledWith('Failed to release pointer capture on chat resizer cleanup', expect.any(Error));
      warnSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    test('shows fallback message when no project is selected', () => {
      useAppState.mockReturnValue({ currentProject: null });

      render(<ProjectInspector />);

      expect(screen.getByText('No project selected')).toBeInTheDocument();
      expect(screen.getByText('Please select a project to view the inspector.')).toBeInTheDocument();
    });

    test('does not render inspector layout when project is missing', () => {
      useAppState.mockReturnValue({ currentProject: null });

      render(<ProjectInspector />);

      expect(screen.queryByTestId('project-inspector')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mock-chat-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mock-preview-panel')).not.toBeInTheDocument();
    });
  });

  describe('Scheduling Helpers', () => {
    test('schedule width update applies immediately when forced for SSR environments', async () => {
      useAppState.mockReturnValue(mockState());

      render(<ProjectInspector />);

      const hooks = await waitForHooks();
      await act(async () => {
        hooks.scheduleWidthUpdate(410, { forceImmediate: true });
      });

      await waitFor(() => {
        const latestCall = chatPanelMock.mock.calls.at(-1)?.[0];
        expect(latestCall.width).toBe(410);
      });
    });

    test('schedule width update reuses pending animation frames and applies latest width', async () => {
      const originalRequestAnimationFrame = window.requestAnimationFrame;
      const originalCancelAnimationFrame = window.cancelAnimationFrame;
      const rafCallbacks = [];
      const rafSpy = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((cb) => {
          rafCallbacks.push(cb);
          return rafCallbacks.length;
        });
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

      useAppState.mockReturnValue(mockState());
      render(<ProjectInspector />);

      const hooks = await waitForHooks();

      await act(async () => {
        hooks.scheduleWidthUpdate(360);
      });

      await act(async () => {
        hooks.scheduleWidthUpdate(420);
      });

      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(rafCallbacks).toHaveLength(1);

      act(() => {
        rafCallbacks[0]?.();
      });

      await waitFor(() => {
        const latestCall = chatPanelMock.mock.calls.at(-1)?.[0];
        expect(latestCall.width).toBe(420);
      });

      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    });

    test('cancelScheduledFrame applies pending width even without a scheduled frame', async () => {
      useAppState.mockReturnValue(mockState());
      render(<ProjectInspector />);

      const hooks = await waitForHooks();

      act(() => {
        hooks.setPendingWidth?.(395);
      });

      await act(async () => {
        hooks.cancelScheduledFrame?.(true);
      });

      await waitFor(() => {
        const latestCall = chatPanelMock.mock.calls.at(-1)?.[0];
        expect(latestCall.width).toBe(395);
      });
    });

    test('cancelScheduledFrame applies pending width when window is unavailable', async () => {
      useAppState.mockReturnValue(mockState());
      render(<ProjectInspector />);

      const hooks = await waitForHooks();

      act(() => {
        hooks.setPendingWidth?.(365);
      });

      await act(async () => {
        hooks.cancelScheduledFrame?.(true, null);
      });

      await waitFor(() => {
        const latestCall = chatPanelMock.mock.calls.at(-1)?.[0];
        expect(latestCall.width).toBe(365);
      });
    });
  });

  describe('Test Hook Wiring', () => {
    test('skips hook binding when hooks container is missing', async () => {
      ProjectInspector.__testHooks = undefined;
      useAppState.mockReturnValue(mockState());

      render(<ProjectInspector />);

      await waitFor(() => {
        expect(ProjectInspector.__testHooks).toBeUndefined();
      });
    });
  });
});