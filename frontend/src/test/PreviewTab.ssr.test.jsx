/**
 * @vitest-environment node
 */

import React from 'react';
import { describe, test, expect } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import PreviewTab from '../components/PreviewTab';

describe('PreviewTab (SSR guards)', () => {
  test('falls back to about:blank when window is unavailable', () => {
    const originalWindow = globalThis.window;
    // Ensure the test actually runs without a window, even if another test set one.
    delete globalThis.window;

    const previewRef = React.createRef();

    try {
      act(() => {
        TestRenderer.create(
          <PreviewTab
            ref={previewRef}
            project={{ id: 123, name: 'SSR Project' }}
            processInfo={null}
            onRestartProject={() => Promise.resolve(null)}
            autoStartOnNotRunning={false}
          />
        );
      });

      expect(previewRef.current.getPreviewUrl()).toBe('about:blank');
    } finally {
      if (typeof originalWindow === 'undefined') {
        delete globalThis.window;
      } else {
        globalThis.window = originalWindow;
      }
    }
  });

  test('dev default maps frontend port 3000 to backend port 5000', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: {
        origin: 'http://localhost:3000',
        hostname: 'localhost',
        protocol: 'http:',
        port: '3000'
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {}
    };

    try {
      const previewRef = React.createRef();
      let renderer;

      act(() => {
        renderer = TestRenderer.create(
          <PreviewTab
            ref={previewRef}
            project={{ id: 456, name: 'Dev Default' }}
            processInfo={null}
            onRestartProject={() => Promise.resolve(null)}
          />
        );
      });

      expect(previewRef.current.getPreviewUrl()).toBe('http://localhost:5000/preview/456');
      expect(previewRef.current.getDisplayedUrl()).toBe('http://localhost:5000/preview/456');

      act(() => {
        renderer.unmount();
      });
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test('uses window origin when not on dev default and no hostname override', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: {
        origin: 'http://localhost:4321',
        hostname: 'localhost',
        protocol: 'http:',
        port: '4321'
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {}
    };

    try {
      const previewRef = React.createRef();
      let renderer;

      act(() => {
        renderer = TestRenderer.create(
          <PreviewTab
            ref={previewRef}
            project={{ id: 789, name: 'Origin Fallback' }}
            processInfo={null}
            onRestartProject={() => Promise.resolve(null)}
          />
        );
      });

      expect(previewRef.current.getPreviewUrl()).toBe('http://localhost:4321/preview/789');

      act(() => {
        renderer.unmount();
      });
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test('hostname override uses overridden hostname and current port', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: {
        origin: 'http://localhost:4321',
        hostname: 'localhost',
        protocol: 'http:',
        port: '4321'
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {}
    };

    try {
      const previewRef = React.createRef();
      let renderer;

      act(() => {
        renderer = TestRenderer.create(
          <PreviewTab
            ref={previewRef}
            project={{ id: 101, name: 'Hostname Override' }}
            processInfo={null}
            onRestartProject={() => Promise.resolve(null)}
          />
        );
      });

      act(() => {
        previewRef.current.__testHooks.applyHostnameOverride('example.test');
      });

      expect(previewRef.current.getPreviewUrl()).toBe('http://example.test:4321/preview/101');

      act(() => {
        renderer.unmount();
      });
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test('falls back safely when window.location is missing', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {}
    };

    try {
      const previewRef = React.createRef();
      let renderer;

      act(() => {
        renderer = TestRenderer.create(
          <PreviewTab
            ref={previewRef}
            project={{ id: 202, name: 'Missing Location' }}
            processInfo={null}
            onRestartProject={() => Promise.resolve(null)}
          />
        );
      });

      expect(previewRef.current.getPreviewUrl()).toBe('about:blank');

      act(() => {
        renderer.unmount();
      });
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test('hostname override omits port suffix when window.location.port is empty', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: {
        origin: 'http://localhost',
        hostname: 'localhost',
        protocol: 'http:',
        port: ''
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {}
    };

    try {
      const previewRef = React.createRef();
      let renderer;

      act(() => {
        renderer = TestRenderer.create(
          <PreviewTab
            ref={previewRef}
            project={{ id: 303, name: 'Hostname Override No Port' }}
            processInfo={null}
            onRestartProject={() => Promise.resolve(null)}
          />
        );
      });

      act(() => {
        previewRef.current.__testHooks.applyHostnameOverride('example.test');
      });

      expect(previewRef.current.getPreviewUrl()).toBe('http://example.test/preview/303');

      act(() => {
        renderer.unmount();
      });
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
