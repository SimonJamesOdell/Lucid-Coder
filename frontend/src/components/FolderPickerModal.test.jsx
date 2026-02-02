import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FolderPickerModal from './FolderPickerModal';

const buildFetchMock = (handlers = {}) => vi.fn(async (url) => {
  const key = typeof url === 'string' ? url : '';
  if (handlers[key]) {
    return handlers[key](url);
  }
  if (typeof url === 'string' && url.startsWith('/api/fs/roots')) {
    return {
      ok: true,
      json: async () => ({ success: true, roots: [] })
    };
  }
  if (typeof url === 'string' && url.startsWith('/api/fs/list')) {
    return {
      ok: true,
      json: async () => ({ success: true, path: 'C:\\', directories: [] })
    };
  }
  return {
    ok: true,
    json: async () => ({ success: true })
  };
});

describe('FolderPickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('selecting a root enables the Select button and calls onSelect', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      }),
      '/api/fs/list?path=C%3A%5C': async () => ({
        ok: true,
        json: async () => ({ success: true, path: 'C:\\', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('C:')).toBeInTheDocument());
    await user.click(screen.getByText('C:'));

    const selectButton = screen.getByRole('button', { name: 'Select' });
    expect(selectButton).toBeEnabled();

    await user.click(selectButton);
    expect(onSelect).toHaveBeenCalledWith('C:\\');
    expect(screen.getByRole('button', { name: 'C:' })).toBeInTheDocument();
  });

  test('reopening a loaded breadcrumb does not refetch the directory', async () => {
    const listUrl = '/api/fs/list?path=%2FUsers%2Fdemo';
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      [listUrl]: async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/Users/demo', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="/Users/demo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(listUrl));
    const listCallsBefore = fetchMock.mock.calls.filter(([url]) => url === listUrl).length;

    await user.click(screen.getByRole('button', { name: 'demo' }));

    const listCallsAfter = fetchMock.mock.calls.filter(([url]) => url === listUrl).length;
    expect(listCallsAfter).toBe(listCallsBefore);
  });

  test('Up button loads the parent directory when available', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      '/api/fs/list?path=%2FUsers%2Fdemo': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/Users/demo', directories: [] })
      }),
      '/api/fs/list?path=%2FUsers': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/Users', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="/Users/demo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'demo' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Up' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/fs/list?path=%2FUsers');
  });

  test('roots list handles missing roots payload', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('No roots available.')).toBeInTheDocument());
  });

  test('roots list falls back to default error message', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/fs/roots') {
        throw null;
      }
      return {
        ok: true,
        json: async () => ({ success: true })
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Failed to load roots')).toBeInTheDocument());
  });

  test('roots list shows server error message when response is not successful', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: false, error: 'Roots unavailable' })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Roots unavailable')).toBeInTheDocument());
  });

  test('roots list uses error message when response is not ok', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: false,
        json: async () => ({ success: false, error: 'Roots failed' })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Roots failed')).toBeInTheDocument());
  });

  test('roots list falls back to default error when response has no message', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: false,
        json: async () => ({ success: false })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Failed to load roots')).toBeInTheDocument());
  });

  test('root path renders a single breadcrumb', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      '/api/fs/list?path=%2F': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath="/"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument());
    expect(screen.queryByText('Roots')).toBeNull();
  });

  test('directory load uses default error when response has no message', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      }),
      '/api/fs/list?path=C%3A%5C': async () => ({
        ok: false,
        json: async () => ({ success: false })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('C:')).toBeInTheDocument());
    await user.click(screen.getByText('C:'));

    await waitFor(() => expect(screen.getByText('Failed to load directory')).toBeInTheDocument());
  });

  test('directory load uses target when response omits path and directories', async () => {
    let hooks;
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [] })
      }),
      '/api/fs/list?path=C%3A%5CTemp': async () => ({
        ok: true,
        json: async () => ({ success: true })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        __testHooks={(value) => { hooks = value; }}
      />
    );

    await waitFor(() => expect(hooks).toBeTruthy());

    await act(async () => {
      await hooks.loadDirectory('C:\\Temp');
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'C:' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Temp' })).toBeInTheDocument();
  });

  test('directory load ignores non-string paths', async () => {
    let hooks;
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        __testHooks={(value) => { hooks = value; }}
      />
    );

    await waitFor(() => expect(hooks).toBeTruthy());

    await act(async () => {
      await hooks.loadDirectory(null);
    });

    const listCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'));
    expect(listCalls).toHaveLength(0);
  });

  test('directory load falls back to default error when fetch throws', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/fs/roots') {
        return { ok: true, json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] }) };
      }
      if (url === '/api/fs/list?path=C%3A%5C') {
        throw undefined;
      }
      return { ok: true, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('C:')).toBeInTheDocument());
    await user.click(screen.getByText('C:'));

    await waitFor(() => expect(screen.getByText('Failed to load directory')).toBeInTheDocument());
  });

  test('renders child directories after loading a node', async () => {
    let hooks;
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      }),
      '/api/fs/list?path=C%3A%5C': async () => ({
        ok: true,
        json: async () => ({
          success: true,
          path: 'C:\\',
          directories: [{ name: 'Projects', path: 'C:\\Projects' }]
        })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        __testHooks={(value) => { hooks = value; }}
      />
    );

    await waitFor(() => expect(hooks).toBeTruthy());

    await act(async () => {
      await hooks.loadDirectory('C:\\');
    });

    await waitFor(() => expect(screen.getByText('Projects')).toBeInTheDocument());
  });

  test('renders nested child directories after loading a child node', async () => {
    let hooks;
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      }),
      '/api/fs/list?path=C%3A%5C': async () => ({
        ok: true,
        json: async () => ({
          success: true,
          path: 'C:\\',
          directories: [{ name: 'Projects', path: 'C:\\Projects' }]
        })
      }),
      '/api/fs/list?path=C%3A%5CProjects': async () => ({
        ok: true,
        json: async () => ({
          success: true,
          path: 'C:\\Projects',
          directories: [{ name: 'Repo', path: 'C:\\Projects\\Repo' }]
        })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        __testHooks={(value) => { hooks = value; }}
      />
    );

    await waitFor(() => expect(hooks).toBeTruthy());

    await act(async () => {
      await hooks.loadDirectory('C:\\');
      await hooks.loadDirectory('C:\\Projects');
    });

    await waitFor(() => expect(screen.getByText('Repo')).toBeInTheDocument());
  });

  test('renders roots without children before a node is loaded', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('C:')).toBeInTheDocument());
    expect(screen.queryByText('Projects')).toBeNull();
  });

  test('renders nested children after expanding loaded folders', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      }),
      '/api/fs/list?path=C%3A%5C': async () => ({
        ok: true,
        json: async () => ({
          success: true,
          path: 'C:\\',
          directories: [{ name: 'Projects', path: 'C:\\Projects' }]
        })
      }),
      '/api/fs/list?path=C%3A%5CProjects': async () => ({
        ok: true,
        json: async () => ({
          success: true,
          path: 'C:\\Projects',
          directories: [{ name: 'Repo', path: 'C:\\Projects\\Repo' }]
        })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('C:')).toBeInTheDocument());
    await user.click(screen.getByText('C:'));

    await waitFor(() => expect(screen.getByText('Projects')).toBeInTheDocument());
    await user.click(screen.getByText('Projects'));

    await waitFor(() => expect(screen.getByText('Repo')).toBeInTheDocument());
  });

  test('deep Windows paths build backslash breadcrumbs', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/fs/roots') {
        return {
          ok: true,
          json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
        };
      }
      if (String(url).startsWith('/api/fs/list')) {
        return {
          ok: true,
          json: async () => ({ success: true, path: 'C:\\Users\\demo\\repo', directories: [] })
        };
      }
      return {
        ok: true,
        json: async () => ({ success: true })
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath="C:\\Users\\demo\\repo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'C:' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'demo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'repo' })).toBeInTheDocument();
  });

  test('mixed separators resolve to a root breadcrumb', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      '/api/fs/list?path=%2F%5C': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/\\', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath="/\\"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument());
    expect(screen.queryByText('Roots')).toBeNull();
  });

  test('separator-only paths fall back to roots and Up reloads roots', async () => {
    const rootsUrl = '/api/fs/roots';
    const listUrl = '/api/fs/list?path=%2F%2F%2F';
    const fetchMock = buildFetchMock({
      [rootsUrl]: async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      [listUrl]: async () => ({
        ok: true,
        json: async () => ({ success: true, path: '///', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="///"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Up' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Up' }));

    const rootsCalls = fetchMock.mock.calls.filter(([url]) => url === rootsUrl).length;
    expect(rootsCalls).toBe(2);
  });

  test('backslash-only paths render no breadcrumbs', async () => {
    const listUrl = '/api/fs/list?path=%5C%5C';
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      }),
      [listUrl]: async () => ({
        ok: true,
        json: async () => ({ success: true, path: '\\\\', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath="\\\\"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Roots')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '/' })).toBeNull();
  });

  test('whitespace path from the server resets to roots on Up', async () => {
    const rootsUrl = '/api/fs/roots';
    const listUrl = '/api/fs/list?path=%2Fwhitespace';
    const fetchMock = buildFetchMock({
      [rootsUrl]: async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      [listUrl]: async () => ({
        ok: true,
        json: async () => ({ success: true, path: '   ', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="/whitespace"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Roots')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Up' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Up' }));

    const rootsCalls = fetchMock.mock.calls.filter(([url]) => url === rootsUrl).length;
    expect(rootsCalls).toBe(2);
  });

  test('close controls call onClose', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Close modal' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('ignores empty folder toggle paths', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'Empty', path: '   ' }] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Empty')).toBeInTheDocument());
    await user.click(screen.getByText('Empty'));

    const listCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'));
    expect(listCalls).toHaveLength(0);
  });

  test('Up button returns to roots from a drive path', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('C:')).toBeInTheDocument());
    await user.click(screen.getByText('C:'));

    const upButton = screen.getByRole('button', { name: 'Up' });
    await user.click(upButton);

    expect(screen.getByText('Roots')).toBeInTheDocument();
  });

  test('renders breadcrumbs for a unix-style path', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      '/api/fs/list?path=%2FUsers%2Fdemo': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/Users/demo', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath="/Users/demo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Users' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'demo' })).toBeInTheDocument();
  });

  test('shows an error when roots fail to load', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: false,
        json: async () => ({ success: false, error: 'Roots unavailable' })
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Roots unavailable')).toBeInTheDocument());
  });

  test('shows an error when directory load fails', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\Projects' }] })
      }),
      '/api/fs/list?path=C%3A%5CProjects': async () => ({
        ok: false,
        json: async () => ({ success: false, error: 'Directory error' })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('C:')).toBeInTheDocument());
    await user.click(screen.getByText('C:'));

    await waitFor(() => expect(screen.getByText('Directory error')).toBeInTheDocument());
  });

  test('Up button returns to roots from a slash path', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      '/api/fs/list?path=%2F': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="/"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument());
    const rootsCallsBefore = fetchMock.mock.calls.filter(([url]) => url === '/api/fs/roots').length;

    await user.click(screen.getByRole('button', { name: 'Up' }));

    const rootsCallsAfter = fetchMock.mock.calls.filter(([url]) => url === '/api/fs/roots').length;
    expect(rootsCallsAfter).toBeGreaterThan(rootsCallsBefore);
  });

  test('Up button returns to roots when path has no separator', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'Root', path: 'Root' }] })
      }),
      '/api/fs/list?path=Root': async () => ({
        ok: true,
        json: async () => ({ success: true, path: 'Root', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="Root"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Root')).toBeInTheDocument());
    const rootsCallsBefore = fetchMock.mock.calls.filter(([url]) => url === '/api/fs/roots').length;

    await user.click(screen.getByRole('button', { name: 'Up' }));

    const rootsCallsAfter = fetchMock.mock.calls.filter(([url]) => url === '/api/fs/roots').length;
    expect(rootsCallsAfter).toBeGreaterThan(rootsCallsBefore);
  });

  test('Up button resolves to slash parent for a unix child path', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: '/', path: '/' }] })
      }),
      '/api/fs/list?path=%2Ffoo': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/foo', directories: [] })
      }),
      '/api/fs/list?path=%2F': async () => ({
        ok: true,
        json: async () => ({ success: true, path: '/', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="/foo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/fs/list?path=%2Ffoo'));
    await user.click(screen.getByRole('button', { name: 'Up' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/fs/list?path=%2F');
  });

  test('Up button resolves to drive root for a Windows child path', async () => {
    const fetchMock = buildFetchMock({
      '/api/fs/roots': async () => ({
        ok: true,
        json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
      }),
      '/api/fs/list?path=C%3A%5C%5Cfoo': async () => ({
        ok: true,
        json: async () => ({ success: true, path: 'C:\\foo', directories: [] })
      }),
      '/api/fs/list?path=C%3A%5C': async () => ({
        ok: true,
        json: async () => ({ success: true, path: 'C:\\', directories: [] })
      })
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <FolderPickerModal
        isOpen
        initialPath="C:\\foo"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/fs/list?path=C%3A%5C%5Cfoo'));
    await user.click(screen.getByRole('button', { name: 'Up' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/fs/list?path=C%3A%5C');
  });

  test('test hooks ignore empty targets for selection and open', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();
    let testHooks;

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={onSelect}
        onClose={vi.fn()}
        __testHooks={(hooks) => { testHooks = hooks; }}
      />
    );

    await waitFor(() => expect(testHooks).toBeTruthy());
    await testHooks.loadDirectory('   ');
    testHooks.handleOpen('   ');
    testHooks.handleSelect();

    expect(onSelect).not.toHaveBeenCalled();
    const listCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/list'));
    expect(listCalls).toHaveLength(0);
  });

  test('handleOpen loads the directory when not yet loaded', async () => {
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    let testHooks;

    render(
      <FolderPickerModal
        isOpen
        initialPath=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
        __testHooks={(hooks) => { testHooks = hooks; }}
      />
    );

    await waitFor(() => expect(testHooks).toBeTruthy());
    testHooks.handleOpen('C:\\Projects');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/fs/list?path=C%3A%5CProjects')
    );
  });
});
