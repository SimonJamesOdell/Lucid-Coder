import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import FilesTab from '../components/FilesTab';
import { useAppState } from '../context/AppStateContext';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const mockAxios = axios;
let lastEditorProps;
let lastDiffEditorProps;

vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props) => {
    lastEditorProps = props;
    return (
      <textarea
        data-testid="mock-editor"
        value={props.value}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    );
  },
  DiffEditor: (props) => {
    lastDiffEditorProps = props;
    return (
      <div data-testid="mock-diff-editor">
        <div data-testid="mock-diff-original">{props.original}</div>
        <div data-testid="mock-diff-modified">{props.modified}</div>
      </div>
    );
  }
}));

const mockProject = {
  id: 'project-1',
  name: 'Demo Project'
};

const sampleFileTree = [
  {
    name: 'src',
    path: 'src',
    type: 'folder',
    children: [
      { name: 'App.jsx', path: 'src/App.jsx', type: 'file' },
      {
        name: 'components',
        path: 'src/components',
        type: 'folder',
        children: [
          { name: 'Header.jsx', path: 'src/components/Header.jsx', type: 'file' }
        ]
      }
    ]
  },
  {
    name: 'public',
    path: 'public',
    type: 'folder',
    children: [
      { name: 'index.html', path: 'public/index.html', type: 'file' }
    ]
  },
  { name: 'README.md', path: 'README.md', type: 'file' }
];

const filesApiResponse = (files = sampleFileTree) => ({
  data: {
    success: true,
    files
  }
});

const fileContentResponse = (content = 'console.log("Hello");') => ({
  data: {
    success: true,
    content
  }
});

const fileDiffContentResponse = (original = 'HEAD content\n', modified = 'staged content\n') => ({
  data: {
    success: true,
    path: 'src/App.jsx',
    original,
    modified
  }
});

const stageFileChangeMock = vi.fn();
const getFileExplorerStateMock = vi.fn();
const setFileExplorerStateMock = vi.fn();
const clearEditorFocusRequestMock = vi.fn();

const setTheme = (theme = 'dark', overrides = {}) => {
  useAppState.mockReturnValue({
    theme,
    stageFileChange: stageFileChangeMock,
    currentProject: mockProject,
    getFileExplorerState: getFileExplorerStateMock,
    setFileExplorerState: setFileExplorerStateMock,
    editorFocusRequest: null,
    clearEditorFocusRequest: clearEditorFocusRequestMock,
    ...overrides
  });
};

const renderFilesTab = async ({ theme = 'dark', overrides = {}, userOptions, componentProps = {}, filesResponse } = {}) => {
  setTheme(theme, overrides);
  mockAxios.get.mockResolvedValueOnce(filesResponse ?? filesApiResponse());
  const user = userEvent.setup(userOptions);
  render(<FilesTab project={mockProject} {...componentProps} />);
  await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));
  return { user };
};

const renderFilesTabWithHooks = async ({ theme = 'dark', overrides = {}, userOptions, componentProps = {}, filesResponse } = {}) => {
  let hooks;
  const __testHooks = (next) => {
    hooks = next;
  };

  const getHooks = () => hooks;

  const { user } = await renderFilesTab({
    theme,
    overrides,
    userOptions,
    componentProps: { ...componentProps, __testHooks },
    filesResponse
  });

  await waitFor(() => {
    expect(hooks?.buildSiblingPath).toBeTypeOf('function');
    expect(hooks?.getActiveFilePath).toBeTypeOf('function');
  });

  return { user, hooks, getHooks };
};

const selectFile = async (user, filePath = 'src/App.jsx', content = 'console.log("Hello");') => {
  mockAxios.get.mockResolvedValueOnce(fileContentResponse(content));
  const fileNode = await screen.findByTestId(`file-item-${filePath}`);
  await user.click(fileNode);
  await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/${filePath}`));
};

const mountEditorShortcut = () => {
  if (!lastEditorProps?.onMount) {
    throw new Error('Editor has not mounted yet. Select a file before mounting.');
  }

  const addCommand = vi.fn();
  const editor = { addCommand };
  const monaco = {
    KeyMod: { CtrlCmd: 1 << 11 },
    KeyCode: { KeyS: 83 }
  };

  lastEditorProps.onMount(editor, monaco);

  const triggerShortcut = addCommand.mock.calls[0]?.[1];

  if (typeof triggerShortcut !== 'function') {
    throw new Error('Shortcut handler was not registered');
  }

  return {
    editor,
    monaco,
    addCommand,
    triggerShortcut
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  useAppState.mockReset();
  stageFileChangeMock.mockReset();
  getFileExplorerStateMock.mockReset();
  getFileExplorerStateMock.mockReturnValue(null);
  setFileExplorerStateMock.mockReset();
  clearEditorFocusRequestMock.mockReset();
  setTheme();
  lastEditorProps = undefined;
  mockAxios.put.mockReset();
  mockAxios.put.mockResolvedValue({ data: { success: true } });
  mockAxios.post.mockReset();
  mockAxios.post.mockResolvedValue({ data: { success: true } });
});

describe('FilesTab Component', () => {
  test('focus request does not clear open tabs when explorer state persists', async () => {
    const state = {
      theme: 'dark',
      stageFileChange: stageFileChangeMock,
      workspaceChanges: {},
      projectFilesRevision: {},
      projectShutdownState: { isStopping: false, projectId: null },
      isProjectStopping: () => false,
      editorFocusRequest: {
        projectId: mockProject.id,
        filePath: 'src/App.jsx',
        source: 'automation',
        highlight: 'editor'
      },
      clearEditorFocusRequest: clearEditorFocusRequestMock,
      getFileExplorerState: getFileExplorerStateMock,
      setFileExplorerState: (projectId, nextState) => {
        setFileExplorerStateMock(projectId, nextState);
        // Simulate AppStateContext updating fileExplorerStateByProject, which
        // recreates getFileExplorerState (new function identity).
        state.getFileExplorerState = () => ({ expandedFolders: nextState?.expandedFolders || [] });
      }
    };

    useAppState.mockImplementation(() => state);

    mockAxios.get
      .mockResolvedValueOnce(filesApiResponse())
      .mockResolvedValueOnce(fileContentResponse('console.log("focus");'));

    render(<FilesTab project={mockProject} />);

    await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));
    await waitFor(() => expect(clearEditorFocusRequestMock).toHaveBeenCalled());

    expect(await screen.findByTestId('file-tab-src/App.jsx')).toBeInTheDocument();
    expect(screen.queryByTestId('no-open-files')).not.toBeInTheDocument();
  });

  test('resizes the file explorer and persists the width', async () => {
    getFileExplorerStateMock.mockReturnValue({ explorerWidth: 200, expandedFolders: ['src'] });

    await renderFilesTab();

    const explorer = screen.getByTestId('file-tree');
    expect(explorer).toHaveStyle({ width: '200px' });

    const divider = screen.getByRole('separator', { name: 'Resize file explorer' });

    await act(async () => {
      fireEvent.mouseDown(divider, { button: 0, clientX: 200 });
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.mouseMove(window, { clientX: 1200 });
    });

    await act(async () => {
      fireEvent.mouseUp(window);
    });

    expect(explorer).toHaveStyle({ width: '520px' });
    expect(setFileExplorerStateMock).toHaveBeenCalledWith(mockProject.id, expect.objectContaining({
      explorerWidth: 520
    }));
  });

  test('clamps the explorer width to the default when the drag delta is non-finite', async () => {
    getFileExplorerStateMock.mockReturnValue({ explorerWidth: 200, expandedFolders: [] });

    await renderFilesTab();

    const divider = screen.getByRole('separator', { name: 'Resize file explorer' });

    await act(async () => {
      fireEvent.mouseDown(divider, { button: 0, clientX: 100 });
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.mouseMove(window, { clientX: Number.NaN });
    });

    const explorer = screen.getByTestId('file-tree');
    expect(explorer).toHaveStyle({ width: '260px' });
  });

  test('ignores mouse moves after drag state is cleared', async () => {
    getFileExplorerStateMock.mockReturnValue({ explorerWidth: 240, expandedFolders: [] });

    await renderFilesTab();

    const divider = screen.getByRole('separator', { name: 'Resize file explorer' });

    await act(async () => {
      fireEvent.mouseDown(divider, { button: 0, clientX: 100 });
      fireEvent.mouseUp(window);
      fireEvent.mouseMove(window, { clientX: 140 });
    });

    expect(screen.getByTestId('file-tree')).toBeInTheDocument();
  });

  test('ignores mouse moves when drag state is missing while resizing', async () => {
    getFileExplorerStateMock.mockReturnValue({ explorerWidth: 240, expandedFolders: [] });

    const { getHooks } = await renderFilesTabWithHooks();

    const divider = screen.getByRole('separator', { name: 'Resize file explorer' });

    await act(async () => {
      fireEvent.mouseDown(divider, { button: 0, clientX: 100 });
    });

    const hooks = getHooks();
    expect(hooks?.dragStateRef).toBeTruthy();
    hooks.dragStateRef.current = null;

    await act(async () => {
      fireEvent.mouseMove(window, { clientX: 140 });
    });

    expect(screen.getByTestId('file-tree')).toHaveStyle({ width: '240px' });
  });

  test('ignores non-left clicks on the divider', async () => {
    getFileExplorerStateMock.mockReturnValue({ explorerWidth: 240, expandedFolders: [] });

    await renderFilesTab();

    const explorer = screen.getByTestId('file-tree');
    expect(explorer).toHaveStyle({ width: '240px' });

    const divider = screen.getByRole('separator', { name: 'Resize file explorer' });
    fireEvent.mouseDown(divider, { button: 2, clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 500 });

    expect(explorer).toHaveStyle({ width: '240px' });
  });

  test('right-click shows context menu and rename stages both paths', async () => {
    const { user } = await renderFilesTab();

    // Ensure refresh calls have a response.
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    mockAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        fromPath: 'src/App.jsx',
        toPath: 'src/App2.jsx'
      }
    });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);

      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: 'Rename' }));

      await waitFor(() =>
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/rename`, {
          fromPath: 'src/App.jsx',
          toPath: 'src/App2.jsx'
        })
      );

      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App.jsx', 'explorer');
      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App2.jsx', 'explorer');
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('context menu handlers stop propagation and prevent default', async () => {
    await renderFilesTab();

    const fileNode = await screen.findByTestId('file-item-src/App.jsx');
    fireEvent.contextMenu(fileNode);

    const menu = await screen.findByTestId('file-context-menu');

    const onBodyMouseDown = vi.fn();
    const onBodyContextMenu = vi.fn();

    document.body.addEventListener('mousedown', onBodyMouseDown);
    document.body.addEventListener('contextmenu', onBodyContextMenu);

    try {
      // Stop propagation: event should not bubble to body listener.
      menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      expect(onBodyMouseDown).not.toHaveBeenCalled();

      // Prevent default + stop propagation: dispatchEvent returns false when default is prevented.
      const wasContextMenuDefaultPrevented = !menu.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );

      expect(wasContextMenuDefaultPrevented).toBe(true);
      expect(onBodyContextMenu).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener('mousedown', onBodyMouseDown);
      document.body.removeEventListener('contextmenu', onBodyContextMenu);
    }
  });

  test('Escape closes an open context menu', async () => {
    await renderFilesTab();

    const fileNode = await screen.findByTestId('file-item-src/App.jsx');
    fireEvent.contextMenu(fileNode);
    expect(await screen.findByTestId('file-context-menu')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('file-context-menu')).toBeNull();
    });
  });

  test('test hooks cover closeTabsForPathPrefix and renameOpenFileState guards and migrations', async () => {
    const { user, hooks, getHooks } = await renderFilesTabWithHooks();

    // Utility helpers: cover edge cases.
    expect(hooks.buildSiblingPath('src/App.jsx', 'bad/name')).toBeNull();
    expect(hooks.buildSiblingPath('src/App.jsx', 'bad\\name')).toBeNull();
    expect(hooks.buildSiblingPath('src/App.jsx', '../evil')).toBeNull();
    expect(hooks.buildSiblingPath('src/App.jsx', 'Next.jsx')).toBe('src/Next.jsx');
    expect(hooks.buildSiblingPath('README.md', 'Note.md')).toBe('Note.md');
    expect(hooks.buildSiblingPath('src/App.jsx', undefined)).toBeNull();

    expect(hooks.suggestDuplicateName('')).toBe('copy');
    expect(hooks.suggestDuplicateName('readme')).toBe('readme-copy');
    expect(hooks.suggestDuplicateName('readme.')).toBe('readme.-copy');
    expect(hooks.suggestDuplicateName('App.jsx')).toBe('App-copy.jsx');

    // Covers: closeTabsForPathPrefix early return when prefix is empty.
    hooks.closeTabsForPathPrefix('');

    // Covers: closeTabsForPathPrefix active path updater when no active file is selected.
    hooks.closeTabsForPathPrefix('src');

    // Covers: renameOpenFileState early return for invalid inputs.
    hooks.renameOpenFileState('', 'src/Next.jsx');
    hooks.renameOpenFileState('src/App.jsx', '');
    hooks.renameOpenFileState('src/App.jsx', 'src/App.jsx');

    // Covers: renameOpenFileState diff map guards (no diff state entries for the path).
    act(() => {
      hooks.renameOpenFileState('src/NoDiff.jsx', 'src/NoDiff2.jsx');
    });

    // Open a tab so renameOpenFileState exercises open tab migrations.
    await selectFile(user, 'src/App.jsx', 'console.log("Hello");');

    // Put a file in state and then rename it to cover state migration branches.
    act(() => {
      hooks.forceFileState('src/App.jsx', {
        content: 'new',
        originalContent: 'old',
        isLoading: false
      });
    });

    await waitFor(() => {
      expect(hooks.getActiveFilePath()).toBe('src/App.jsx');
    });

    // Ensure diff mode state exists so renameOpenFileState exercises diff map migrations.
    // Also include diff labels to cover the label parsing branches in loadDiffForFile.
    mockAxios.get.mockClear();
    await act(async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          path: 'src/App.jsx',
          original: 'HEAD\n',
          modified: 'staged\n',
          originalLabel: 'HEAD',
          modifiedLabel: 'STAGED'
        }
      });
      await getHooks().handleToggleDiffMode();
    });

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`,
        expect.any(Object)
      );
    });

    // Rename the active path state to a new location.
    act(() => {
      hooks.renameOpenFileState('src/App.jsx', 'src/App2.jsx');
    });

    // Active file path should follow rename.
    await waitFor(() => {
      expect(hooks.getActiveFilePath()).toBe('src/App2.jsx');
    });

    // If diff mode migrated correctly, toggling diff mode now should disable it (no diff-content request).
    mockAxios.get.mockClear();
    await act(async () => {
      await getHooks().handleToggleDiffMode();
    });
    expect(mockAxios.get).not.toHaveBeenCalled();

    // Cover: renameOpenFileState tab label fallback when toPath ends with '/'.
    act(() => {
      hooks.renameOpenFileState('src/App2.jsx', 'src/Weird/');
    });

    await waitFor(() => {
      expect(hooks.getActiveFilePath()).toBe('src/Weird/');
    });

    // Renaming a path that doesn't exist in fileStates should no-op.
    act(() => {
      hooks.renameOpenFileState('src/DOES_NOT_EXIST.jsx', 'src/StillNope.jsx');
    });

    // Also cover closeTabsForPathPrefix clearing active file when it falls under the prefix.
    hooks.closeTabsForPathPrefix('src');
    await waitFor(() => {
      expect(hooks.getActiveFilePath()).toBe('');
    });

    // Cover: closeTabsForPathPrefix preserving active file when it does not match the prefix.
    await selectFile(user, 'README.md', '# Readme');
    await waitFor(() => {
      expect(hooks.getActiveFilePath()).toBe('README.md');
    });
    hooks.closeTabsForPathPrefix('src');
    await waitFor(() => {
      expect(hooks.getActiveFilePath()).toBe('README.md');
    });
  });

  test('handleContextAction returns early when context menu has no target', async () => {
    const { hooks } = await renderFilesTabWithHooks();
    await act(async () => {
      await hooks.handleContextAction('delete');
    });
    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  test('shutting down prevents opening the context menu', async () => {
    await renderFilesTab({
      overrides: {
        isProjectStopping: vi.fn(() => true)
      }
    });

    const fileNode = await screen.findByTestId('file-item-src/App.jsx');
    fireEvent.contextMenu(fileNode, { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(screen.queryByTestId('file-context-menu')).toBeNull();
  });

  test('handleContextAction returns early while shutting down', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');

    try {
      const { hooks } = await renderFilesTabWithHooks({
        overrides: {
          isProjectStopping: vi.fn(() => true)
        }
      });

      await act(async () => {
        await hooks.handleContextAction('rename');
      });

      expect(promptSpy).not.toHaveBeenCalled();
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('handleContextAction returns early when projectId is missing', async () => {
    let hooks;
    const __testHooks = (next) => {
      hooks = next;
    };

    setTheme('dark');
    render(<FilesTab project={null} __testHooks={__testHooks} />);

    await waitFor(() => {
      expect(hooks?.handleContextAction).toBeTypeOf('function');
    });

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    try {
      await act(async () => {
        await hooks.handleContextAction('rename');
      });

      expect(promptSpy).not.toHaveBeenCalled();
      expect(mockAxios.post).not.toHaveBeenCalled();
      expect(mockAxios.get).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('buildSiblingPath rejects undefined sibling names', async () => {
    const { hooks } = await renderFilesTabWithHooks();

    expect(hooks.buildSiblingPath('src/App.jsx', undefined)).toBeNull();
    expect(hooks.buildSiblingPath('App.jsx', 'App2.jsx')).toBe('App2.jsx');
    expect(hooks.buildChildPath('src', undefined)).toBeNull();
  });

  test('rename closes menu when prompt is canceled', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);

      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      expect(mockAxios.post).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.queryByTestId('file-context-menu')).toBeNull();
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('rename rejects invalid sibling names', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('bad/name');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('rename rejects whitespace-only names', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('   ');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('rename surfaces backend failure and alerts with error text', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'Nope' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/Nope/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('rename uses default failure copy when backend omits error', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/Failed to rename/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('file operation alert prefers server response error when request rejects', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockRejectedValueOnce({ response: { data: { error: 'Server said no' } } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/Server said no/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('renaming a folder closes open tabs under it', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    await selectFile(user, 'src/App.jsx', 'console.log("opened");');
    expect(await screen.findByTestId('file-tab-src/App.jsx')).toBeInTheDocument();

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('src2');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true } });

    try {
      const folderLabel = await screen.findByText('src', { selector: '.folder-name' });
      const folderNode = folderLabel.closest('.folder-item');
      expect(folderNode).not.toBeNull();
      fireEvent.contextMenu(folderNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

      await waitFor(() => {
        expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src', 'explorer');
        expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src2', 'explorer');
      });

      expect(await screen.findByTestId('no-open-files')).toBeInTheDocument();
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('delete closes menu without calling backend when user cancels confirmation', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

      expect(mockAxios.post).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByTestId('file-context-menu')).toBeNull();
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  test('delete alerts when backend reports failure', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'No delete' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/No delete/);
    } finally {
      confirmSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('delete uses default failure copy when backend omits error', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/Failed to delete/);
    } finally {
      confirmSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('deleting a folder calls delete endpoint with recursive true', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockAxios.post.mockResolvedValueOnce({ data: { success: true } });

    try {
      const folderLabel = await screen.findByText('src', { selector: '.folder-name' });
      const folderNode = folderLabel.closest('.folder-item');
      expect(folderNode).not.toBeNull();
      fireEvent.contextMenu(folderNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/delete`, {
          targetPath: 'src',
          recursive: true,
          confirm: true
        });
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  test('duplicate closes menu when prompt is canceled', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

      expect(mockAxios.post).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByTestId('file-context-menu')).toBeNull();
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('duplicate rejects invalid destination names', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('../evil');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('duplicate alerts when backend reports failure', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'No dup' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/No dup/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('duplicate uses default failure copy when backend omits error', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/Failed to duplicate/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('duplicate action alerts when target is a folder (invoked via hooks)', async () => {
    const { getHooks } = await renderFilesTabWithHooks();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const folderLabel = await screen.findByText('src', { selector: '.folder-name' });
      const folderNode = folderLabel.closest('.folder-item');
      expect(folderNode).not.toBeNull();
      fireEvent.contextMenu(folderNode);

      await screen.findByTestId('file-context-menu');

      await act(async () => {
        await getHooks().handleContextAction('duplicate');
      });

      expect(alertSpy).toHaveBeenCalledWith('Only files can be duplicated.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      alertSpy.mockRestore();
    }
  });

  test('create folder under a file uses the file directory and persists expanded folder state', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('new-folder');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true, trackingPath: 'src/new-folder/.gitkeep' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create folder' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/mkdir`, {
          folderPath: 'src/new-folder',
          track: true
        });
      });

      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/new-folder/.gitkeep', 'explorer');
      expect(setFileExplorerStateMock).toHaveBeenCalledWith(
        mockProject.id,
        expect.objectContaining({ expandedFolders: expect.arrayContaining(['src', 'src/new-folder']) })
      );
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create file under a file uses the file directory and stages change', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true, filePath: 'src/NewFile.txt' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/create-file`, {
          filePath: 'src/NewFile.txt',
          content: ''
        });
      });

      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/NewFile.txt', 'explorer');
      expect(setFileExplorerStateMock).toHaveBeenCalledWith(
        mockProject.id,
        expect.objectContaining({ expandedFolders: expect.arrayContaining(['src']) })
      );
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create file under a folder uses the folder path', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true, filePath: 'src/NewFile.txt' } });

    try {
      const folderLabel = await screen.findByText('src');
      const folderNode = folderLabel.closest('.folder-item');
      if (!folderNode) {
        throw new Error('Unable to locate folder node for src');
      }
      fireEvent.contextMenu(folderNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/create-file`, {
          filePath: 'src/NewFile.txt',
          content: ''
        });
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create file succeeds even when stageFileChange is absent', async () => {
    const { user } = await renderFilesTab({ overrides: { stageFileChange: undefined } });
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true, filePath: 'src/NewFile.txt' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/create-file`, {
          filePath: 'src/NewFile.txt',
          content: ''
        });
      });

      expect(stageFileChangeMock).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create file rejects invalid file names', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('bad/name');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid file name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create file rejects whitespace-only file names', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('   ');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid file name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create file rejects names containing .. segments', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('evil..txt');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid file name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create file under a root file uses an empty base directory', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true, filePath: 'NewFile.txt' } });

    try {
      const rootFileNode = await screen.findByTestId('file-item-README.md');
      fireEvent.contextMenu(rootFileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/create-file`, {
          filePath: 'NewFile.txt',
          content: ''
        });
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create file does not persist expanded folder state when setFileExplorerState is absent', async () => {
    const { user } = await renderFilesTab({ overrides: { setFileExplorerState: undefined } });
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true, filePath: 'src/NewFile.txt' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalled();
      });

      expect(setFileExplorerStateMock).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create file closes menu when prompt is canceled', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      expect(mockAxios.post).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByTestId('file-context-menu')).toBeNull();
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create file surfaces backend failure and alerts with error text', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'No create' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/create-file`, {
          filePath: 'src/NewFile.txt',
          content: ''
        });
      });

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/No create/);
      expect(stageFileChangeMock).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create file alerts when backend response omits data payload', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({});

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/Failed to create file/);
      expect(stageFileChangeMock).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create file rejects when base directory contains .. segments', async () => {
    const unsafeTree = [
      {
        ...sampleFileTree[0],
        children: [
          ...(sampleFileTree[0].children || []),
          { name: 'bad.jsx', path: 'src/../bad.jsx', type: 'file' }
        ]
      },
      ...sampleFileTree.slice(1)
    ];

    const { user } = await renderFilesTab({ filesResponse: filesApiResponse(unsafeTree) });

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFile.txt');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const fileNode = await screen.findByTestId('file-item-src/../bad.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create file' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid file name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create folder closes menu when prompt is canceled', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create folder' }));

      expect(mockAxios.post).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByTestId('file-context-menu')).toBeNull();
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('should refresh files when projectFilesRevision increments', async () => {
    setTheme('dark', { projectFilesRevision: { [mockProject.id]: 0 } });
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const { rerender } = render(<FilesTab project={mockProject} />);

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`);
    });

    setTheme('dark', { projectFilesRevision: { [mockProject.id]: 1 } });
    rerender(<FilesTab project={mockProject} />);

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledTimes(2);
    });
  });

  test('create folder rejects invalid folder names', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('../evil');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create folder' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid folder name.');
      expect(mockAxios.post).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create folder surfaces backend failure and alerts with error text', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFolder');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'No mkdir' } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create folder' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/No mkdir/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create folder derives baseDir as empty string when target has no slash', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFolder');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

    try {
      const fileNode = await screen.findByTestId('file-item-README.md');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create folder' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/Failed to create folder/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('file operation alert falls back when error object has no message or response', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App2.jsx');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mockAxios.post.mockRejectedValueOnce({});

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalled();
      });
      expect(alertSpy.mock.calls.at(-1)?.[0]).toMatch(/File operation failed/);
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('create folder tolerates missing tracking path', async () => {
    const { user } = await renderFilesTab();
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('NewFolder');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true } });

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);
      await user.click(await screen.findByRole('menuitem', { name: 'Create folder' }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalled();
      });

      expect(stageFileChangeMock).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('right-click on explorer root supports create folder and stages tracking file', async () => {
    const { user } = await renderFilesTab();

    // Ensure refresh calls have a response.
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('new-folder');
    mockAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        folderPath: 'new-folder',
        trackingPath: 'new-folder/.gitkeep'
      }
    });

    try {
      const treeContent = await screen.findByTestId('file-tree-content');
      fireEvent.contextMenu(treeContent);

      expect(await screen.findByRole('menuitem', { name: 'Create folder' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('menuitem', { name: 'Create folder' }));

      await waitFor(() =>
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/mkdir`, {
          folderPath: 'new-folder',
          track: true
        })
      );

      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'new-folder/.gitkeep', 'explorer');
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('right-click on explorer root supports create file and stages change', async () => {
    const { user } = await renderFilesTab();

    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('root.txt');
    mockAxios.post.mockResolvedValueOnce({ data: { success: true, filePath: 'root.txt' } });

    try {
      const treeContent = await screen.findByTestId('file-tree-content');
      fireEvent.contextMenu(treeContent);

      expect(await screen.findByRole('menuitem', { name: 'Create file' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('menuitem', { name: 'Create file' }));

      await waitFor(() =>
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/create-file`, {
          filePath: 'root.txt',
          content: ''
        })
      );

      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'root.txt', 'explorer');
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('create folder rejects invalid folder names', async () => {
    const { user } = await renderFilesTab();

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('bad/name');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    try {
      const treeContent = await screen.findByTestId('file-tree-content');
      fireEvent.contextMenu(treeContent);

      expect(await screen.findByRole('menuitem', { name: 'Create folder' })).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: 'Create folder' }));

      expect(alertSpy).toHaveBeenCalledWith('Invalid folder name.');
      expect(mockAxios.post).not.toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/files-ops/mkdir`,
        expect.anything()
      );
    } finally {
      promptSpy.mockRestore();
      alertSpy.mockRestore();
    }
  });

  test('context menu delete removes a file and stages change', async () => {
    const { user } = await renderFilesTab();

    // Ensure refresh calls have a response.
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);

      expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

      await waitFor(() =>
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/delete`, {
          targetPath: 'src/App.jsx',
          recursive: false,
          confirm: true
        })
      );

      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App.jsx', 'explorer');
    } finally {
      confirmSpy.mockRestore();
    }
  });

  test('context menu duplicate creates a sibling file and stages change', async () => {
    const { user } = await renderFilesTab();

    // Ensure refresh calls have a response.
    mockAxios.get.mockResolvedValue(filesApiResponse());

    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('App-copy.jsx');

    try {
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      fireEvent.contextMenu(fileNode);

      expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

      await waitFor(() =>
        expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files-ops/duplicate`, {
          sourcePath: 'src/App.jsx',
          destinationPath: 'src/App-copy.jsx'
        })
      );

      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App-copy.jsx', 'explorer');
    } finally {
      promptSpy.mockRestore();
    }
  });

  test('stagedPathSet ignores non-string staged entries without breaking staged UI', async () => {
    const { user } = await renderFilesTab({
      overrides: {
        workspaceChanges: {
          [mockProject.id]: {
            stagedFiles: [{ path: 123 }, { path: 'src/App.jsx' }]
          }
        }
      }
    });

    const diffButton = await screen.findByTestId('staged-diff-button-src/App.jsx');
    expect(diffButton).toBeInTheDocument();

    mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('HEAD\n', 'staged\n'));
    mockAxios.get.mockResolvedValueOnce(fileContentResponse('console.log("ok");'));

    await user.click(diffButton);
    expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
  });

  test('does not call getFileExplorerState when it is absent', async () => {
    setTheme('dark', {
      getFileExplorerState: undefined
    });
    mockAxios.get.mockResolvedValueOnce(filesApiResponse());

    render(<FilesTab project={mockProject} />);
    await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));

    expect(await screen.findByTestId('file-tree')).toBeInTheDocument();
    expect(screen.queryByText('Explorer')).toBeNull();
  });

  test('shows the project path in the file explorer header', async () => {
    const projectWithPath = {
      ...mockProject,
      path: 'C:\\Users\\simon\\lucidcoder\\projects\\tank-boss'
    };
    setTheme('dark', {
      currentProject: projectWithPath
    });
    mockAxios.get.mockResolvedValueOnce(filesApiResponse());

    render(<FilesTab project={projectWithPath} />);
    await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));

    expect(await screen.findByText(projectWithPath.path)).toBeInTheDocument();
  });
  test('tab close handles missing diff state entries', async () => {
    setTheme('dark', {
      editorFocusRequest: {
        projectId: mockProject.id,
        filePath: 'src/App.jsx',
        source: 'tests'
      }
    });

    mockAxios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/files`) {
        return Promise.resolve(filesApiResponse());
      }

      if (url === `/api/projects/${mockProject.id}/files/src/App.jsx`) {
        return Promise.resolve(fileContentResponse('console.log("focus");'));
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    const user = userEvent.setup();
    render(<FilesTab project={mockProject} />);

    await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));

    const tab = await screen.findByTestId('file-tab-src/App.jsx');
    const closeButton = within(tab).getByLabelText('Close App.jsx');
    await user.click(closeButton);

    expect(await screen.findByTestId('no-open-files')).toBeInTheDocument();
  });

  test('shows empty state when project has no files', async () => {
    await renderFilesTab({
      filesResponse: filesApiResponse([])
    });

    expect(await screen.findByText('No files found in this project')).toBeInTheDocument();
  });

  test('shows empty state when files payload is not an array', async () => {
    await renderFilesTab({
      filesResponse: filesApiResponse(null)
    });

    expect(await screen.findByText('No files found in this project')).toBeInTheDocument();
  });

  test('diff mode surfaces diff endpoint error payloads', async () => {
    const { user } = await renderFilesTab({
      overrides: {
        workspaceChanges: {
          [mockProject.id]: {
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        }
      }
    });

    mockAxios.get.mockResolvedValueOnce({
      data: {
        success: false,
        error: 'Diff blew up'
      }
    });
    mockAxios.get.mockResolvedValueOnce(fileContentResponse('console.log("ok");'));

    const diffButton = await screen.findByTestId('staged-diff-button-src/App.jsx');
    await user.click(diffButton);

    expect(await screen.findByText('Diff blew up')).toBeInTheDocument();
  });

  test('diff mode shows No diff available when original matches modified', async () => {
    const { user } = await renderFilesTab({
      overrides: {
        workspaceChanges: {
          [mockProject.id]: {
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        }
      }
    });

    mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('same\n', 'same\n'));
    mockAxios.get.mockResolvedValueOnce(fileContentResponse('console.log("ok");'));

    const diffButton = await screen.findByTestId('staged-diff-button-src/App.jsx');
    await user.click(diffButton);

    expect(await screen.findByText('No diff available.')).toBeInTheDocument();
  });

  test('diff mode shows loading state while diff content request is pending', async () => {
    const { user } = await renderFilesTab({
      overrides: {
        workspaceChanges: {
          [mockProject.id]: {
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        }
      }
    });

    let resolveDiff;
    const pendingDiff = new Promise((resolve) => {
      resolveDiff = resolve;
    });

    mockAxios.get.mockReturnValueOnce(pendingDiff);
    mockAxios.get.mockResolvedValueOnce(fileContentResponse('console.log("ok");'));

    const diffButton = await screen.findByTestId('staged-diff-button-src/App.jsx');
    await user.click(diffButton);

    expect(await screen.findByText('Loading diff...')).toBeInTheDocument();

    resolveDiff(fileDiffContentResponse('HEAD\n', 'staged\n'));
    expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
  });

  test('diff mode uses vs-light theme when light mode is active', async () => {
    const { user } = await renderFilesTab({
      theme: 'light',
      overrides: {
        workspaceChanges: {
          [mockProject.id]: {
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        }
      }
    });

    mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('HEAD\n', 'staged\n'));
    mockAxios.get.mockResolvedValueOnce(fileContentResponse('console.log("ok");'));

    const diffButton = await screen.findByTestId('staged-diff-button-src/App.jsx');
    await user.click(diffButton);

    expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
    expect(lastDiffEditorProps.theme).toBe('vs-light');
  });

  test('refreshes staged diff after staging completes when diff opened mid-save', async () => {
    let resolveStage;
    const stagePromise = new Promise((resolve) => {
      resolveStage = resolve;
    });

    const stageFileChangeDeferred = vi.fn(() => stagePromise);

    const { user } = await renderFilesTab({
      overrides: {
        stageFileChange: stageFileChangeDeferred,
        workspaceChanges: {
          [mockProject.id]: {
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        }
      }
    });

    // Open file in editor
    mockAxios.get.mockResolvedValueOnce(fileContentResponse('console.log("old");'));
    const fileNode = await screen.findByTestId('file-item-src/App.jsx');
    await user.click(fileNode);
    await waitFor(() =>
      expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`)
    );

    // Make an edit and save; staging stays inflight
    const editor = screen.getByTestId('mock-editor');
    await user.clear(editor);
    await user.type(editor, 'console.log("new");');

    await user.click(screen.getByTestId('save-file-button'));
    await waitFor(() => expect(mockAxios.put).toHaveBeenCalledTimes(1));
    expect(stageFileChangeDeferred).toHaveBeenCalledWith(mockProject.id, 'src/App.jsx', 'editor');

    // Open staged diff while staging is still pending
    mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('HEAD content\n', 'staged-old\n'));
    mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('HEAD content\n', 'staged-new\n'));

    const diffButton = await screen.findByTestId('staged-diff-button-src/App.jsx');
    await user.click(diffButton);

    expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
    expect(screen.getByTestId('mock-diff-modified')).toHaveTextContent('staged-old');

    // Complete staging; FilesTab should refresh the diff payload.
    resolveStage?.({ success: true });

    await waitFor(() => {
      expect(screen.getByTestId('mock-diff-modified')).toHaveTextContent('staged-new');
    });
  });

  test('saves the file even when staging fails (logs warning)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stageFileChangeMock.mockRejectedValueOnce(new Error('stage exploded'));

    const { user } = await renderFilesTab();

    await selectFile(user, 'src/App.jsx', 'console.log("old");');
    const editor = screen.getByTestId('mock-editor');
    await user.type(editor, '\nconsole.log("edit");');

    await user.click(screen.getByTestId('save-file-button'));

    await waitFor(() => expect(mockAxios.put).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App.jsx', 'editor');
    });

    expect(warnSpy).toHaveBeenCalledWith('Failed to stage file change', expect.any(Error));
    warnSpy.mockRestore();
  });

  describe('Shutdown State Awareness', () => {
    test('should show shutdown overlay and disable interactions while stopping', async () => {
      const { user } = await renderFilesTab({
        overrides: {
          projectShutdownState: { isStopping: true, projectId: mockProject.id },
          isProjectStopping: () => true
        },
        userOptions: { pointerEventsCheck: 0 }
      });

      expect(screen.getByTestId('files-shutdown-overlay')).toHaveTextContent('Stopping project processes');

      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      await user.click(fileNode);

      // Should not attempt to fetch file content while shutdown is in progress
      expect(mockAxios.get).toHaveBeenCalledTimes(1);
    });

    test('should infer shutdown state from context when helper is absent', async () => {
      const { user } = await renderFilesTab({
        overrides: {
          projectShutdownState: { isStopping: true, projectId: mockProject.id }
        },
        userOptions: { pointerEventsCheck: 0 }
      });

      expect(screen.getByTestId('files-shutdown-overlay')).toBeInTheDocument();

      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      await user.click(fileNode);

      expect(mockAxios.get).toHaveBeenCalledTimes(1);
    });

    test('should ignore shutdown hints for other projects when helper is absent', async () => {
      const { user } = await renderFilesTab({
        overrides: {
          projectShutdownState: { isStopping: true, projectId: 'different-project' }
        }
      });

      expect(screen.queryByTestId('files-shutdown-overlay')).not.toBeInTheDocument();

      await selectFile(user);

      expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`);
    });
  });

  describe('Fetching Real Files', () => {
    test('should fetch and display actual project files from API', async () => {
      await renderFilesTab();

      expect(screen.getByText('src')).toBeInTheDocument();
      expect(screen.getByText('public')).toBeInTheDocument();
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    test('should display expanded folders and their children', async () => {
      await renderFilesTab();

      expect(screen.getByTestId('file-item-src/App.jsx')).toBeInTheDocument();
      expect(screen.getByText('components')).toBeInTheDocument();
    });

    test('should handle API errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockAxios.get.mockRejectedValueOnce(new Error('Network error'));

      try {
        render(<FilesTab project={mockProject} />);

        await waitFor(() => expect(screen.getByText('Failed to load project files')).toBeInTheDocument());
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should show loading state while fetching files', async () => {
      let resolveFetch;
      const pendingPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      mockAxios.get.mockReturnValueOnce(pendingPromise);

      render(<FilesTab project={mockProject} />);

      expect(await screen.findByText('Loading files...')).toBeInTheDocument();

      resolveFetch(filesApiResponse());
      await waitFor(() => expect(screen.queryByText('Loading files...')).not.toBeInTheDocument());
    });

    test('should refetch files when project changes', async () => {
      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));

      const updatedProject = { ...mockProject, id: 'project-2' };
      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      rerender(<FilesTab project={updatedProject} />);

      await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${updatedProject.id}/files`));
    });

    test('should show API error when files response reports failure', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: { success: false, error: 'Unable to enumerate files' }
      });

      render(<FilesTab project={mockProject} />);

      await waitFor(() => expect(screen.getByText('Unable to enumerate files')).toBeInTheDocument());
      expect(mockAxios.get).toHaveBeenCalledTimes(1);
    });

    test('should skip fetching files when no project is provided', async () => {
      render(<FilesTab project={null} />);

      await waitFor(() => expect(mockAxios.get).not.toHaveBeenCalled());
      expect(screen.getByText('No files found in this project')).toBeInTheDocument();
    });

    test('should show default error when API failure omits message', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: { success: false }
      });

      render(<FilesTab project={mockProject} />);

      await waitFor(() => expect(screen.getByText('Failed to load files')).toBeInTheDocument());
    });

    test('should surface server error message when project file fetch rejects with details', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = Object.assign(new Error('boom'), {
        response: { data: { error: 'Server exploded' } }
      });
      mockAxios.get.mockRejectedValueOnce(error);

      try {
        render(<FilesTab project={mockProject} />);

        await waitFor(() => expect(screen.getByText('Server exploded')).toBeInTheDocument());
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('File Tree Interaction', () => {
    test('should toggle folder expansion when clicked', async () => {
      const { user } = await renderFilesTab();
      const componentsFolder = (await screen.findByText('components')).closest('.folder-item');
      const headerTestId = 'file-item-src/components/Header.jsx';

      expect(screen.queryByTestId(headerTestId)).not.toBeInTheDocument();
      await user.click(componentsFolder);
      expect(await screen.findByTestId(headerTestId)).toBeInTheDocument();

      await user.click(componentsFolder);
      expect(screen.queryByTestId(headerTestId)).not.toBeInTheDocument();
    });

    test('should not warn about context updates during render when toggling folders', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { user } = await renderFilesTab();
        const componentsFolder = (await screen.findByText('components')).closest('.folder-item');

        await user.click(componentsFolder);

        const combinedMessages = consoleSpy.mock.calls
          .flat()
          .map((value) => (typeof value === 'string' ? value : ''))
          .join(' ');

        expect(combinedMessages).not.toMatch(/Cannot update a component/i);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should select file when clicked', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      const activeTab = screen.getByTestId('file-tab-src/App.jsx');
      expect(activeTab).toHaveAttribute('aria-selected', 'true');
      expect(activeTab).toHaveAttribute('title', 'src/App.jsx');
      expect(screen.getByTestId('mock-editor')).toHaveValue('console.log("Hello");');
    });

    test('should render tree connectors for nested folders', async () => {
      await renderFilesTab();

      expect(screen.getAllByText('├─').length).toBeGreaterThan(0);
      expect(screen.getAllByText('└─').length).toBeGreaterThan(0);
    });

    test('should render connector glyphs on nested folder rows', async () => {
      await renderFilesTab();

      const componentsFolder = (await screen.findByText('components')).closest('.folder-item');
      expect(within(componentsFolder).getByText('└─')).toBeInTheDocument();
    });

    test('should render connector glyphs on nested file rows once expanded', async () => {
      const { user } = await renderFilesTab();
      const componentsFolder = (await screen.findByText('components')).closest('.folder-item');
      await user.click(componentsFolder);

      const headerEntry = await screen.findByTestId('file-item-src/components/Header.jsx');
      expect(within(headerEntry).getByText('└─')).toBeInTheDocument();
    });

    test('should apply selected class to active file entry', async () => {
      const { user } = await renderFilesTab();
      const fileEntry = await screen.findByTestId('file-item-src/App.jsx');

      await user.click(fileEntry);

      await waitFor(() => expect(fileEntry).toHaveClass('selected'));
    });
  });

  describe('File Content Loading', () => {
    test('should fetch and display real file content when file is clicked', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'import App from "./App";');

      expect(screen.getByTestId('mock-editor')).toHaveValue('import App from "./App";');
    });

    test('should show loading state while fetching file content', async () => {
      const { user } = await renderFilesTab();
      let resolveContent;
      const pendingContent = new Promise((resolve) => {
        resolveContent = resolve;
      });
      mockAxios.get.mockReturnValueOnce(pendingContent);

      const fileItem = await screen.findByTestId('file-item-src/App.jsx');
      await user.click(fileItem);

      expect(await screen.findByText('Loading file content...')).toBeInTheDocument();

      resolveContent(fileContentResponse('final'));
      await waitFor(() => expect(screen.queryByText('Loading file content...')).not.toBeInTheDocument());
    });

    test('should handle file content fetch errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { user } = await renderFilesTab();
      mockAxios.get.mockRejectedValueOnce(new Error('Content missing'));

      try {
        await user.click(await screen.findByTestId('file-item-src/App.jsx'));

        await waitFor(() =>
          expect(screen.getByTestId('mock-editor')).toHaveValue('// Error loading file: Content missing')
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should not fetch content when clicking a folder', async () => {
      const { user } = await renderFilesTab();
      const initialCalls = mockAxios.get.mock.calls.length;

      await user.click((await screen.findByText('src')).closest('.folder-item'));

      expect(mockAxios.get.mock.calls.length).toBe(initialCalls);
    });

    test('should reuse cached tab and content when selecting the same file twice', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("first");');

      const fileNode = await screen.findByTestId('file-item-src/App.jsx');
      const callsAfterFirstLoad = mockAxios.get.mock.calls.length;

      await user.click(fileNode);

      expect(mockAxios.get).toHaveBeenCalledTimes(callsAfterFirstLoad);
      expect(screen.getAllByTestId('file-tab-src/App.jsx')).toHaveLength(1);
    });

    test('should show inline error when file content response is unsuccessful', async () => {
      const { user } = await renderFilesTab();
      const fileNode = await screen.findByTestId('file-item-src/App.jsx');

      mockAxios.get.mockResolvedValueOnce({
        data: { success: false, error: 'Missing file body' }
      });

      await user.click(fileNode);

      await waitFor(() =>
        expect(screen.getByTestId('mock-editor')).toHaveValue('// Error loading file: Missing file body')
      );
    });

    test('should refetch empty files to preserve state placeholders', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'README.md', '');

      const fileNode = await screen.findByTestId('file-item-README.md');
      const callsAfterFirstLoad = mockAxios.get.mock.calls.length;

      mockAxios.get.mockResolvedValueOnce(fileContentResponse(''));
      await user.click(fileNode);

      await waitFor(() => expect(mockAxios.get.mock.calls.length).toBe(callsAfterFirstLoad + 1));
    });

    test('should show server provided error when file fetch fails with message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { user } = await renderFilesTab();
      const error = Object.assign(new Error('boom'), {
        response: { data: { error: 'File unavailable' } }
      });
      mockAxios.get.mockRejectedValueOnce(error);

      try {
        await user.click(await screen.findByTestId('file-item-src/App.jsx'));
        await waitFor(() =>
          expect(screen.getByTestId('mock-editor')).toHaveValue('// Error loading file: File unavailable')
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('Tab Management', () => {
    test('should render save button in controls row above tabs', async () => {
      await renderFilesTab();
      const controlsRow = screen.getByTestId('editor-controls-row');
      expect(within(controlsRow).getByTestId('save-file-button')).toBeInTheDocument();
      const tabsRow = screen.getByTestId('editor-tabs-row');
      expect(within(tabsRow).queryByTestId('save-file-button')).not.toBeInTheDocument();
    });

    test('should open multiple tabs when selecting different files', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("app");');

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('readme contents'));
      await user.click(await screen.findByTestId('file-item-README.md'));

      expect(screen.getByTestId('file-tab-src/App.jsx')).toBeInTheDocument();
      expect(screen.getByTestId('file-tab-README.md')).toBeInTheDocument();
    });

      test('internal tab handler ignores requests while shutting down', async () => {
        const contextState = {
          theme: 'dark',
          stageFileChange: stageFileChangeMock,
          projectShutdownState: { isStopping: false, projectId: mockProject.id },
          isProjectStopping: () => contextState.projectShutdownState.isStopping,
          getFileExplorerState: getFileExplorerStateMock,
          setFileExplorerState: setFileExplorerStateMock,
          editorFocusRequest: null,
          clearEditorFocusRequest: clearEditorFocusRequestMock
        };
        useAppState.mockImplementation(() => contextState);

        mockAxios.get.mockResolvedValueOnce(filesApiResponse());
        let exposedHandlers;
        const collectHandlers = (handlers) => {
          if (handlers) {
            exposedHandlers = handlers;
          }
        };

        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const { rerender } = render(<FilesTab project={mockProject} __testHooks={collectHandlers} />);
        await waitFor(() =>
          expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
        );

        await selectFile(user, 'src/App.jsx', 'console.log("app");');

        mockAxios.get.mockResolvedValueOnce(fileContentResponse('readme contents'));
        await user.click(await screen.findByTestId('file-item-README.md'));

        const appTab = screen.getByTestId('file-tab-src/App.jsx');
        const readmeTab = screen.getByTestId('file-tab-README.md');
        expect(readmeTab).toHaveAttribute('aria-selected', 'true');
        await waitFor(() => expect(exposedHandlers?.handleTabSelect).toBeInstanceOf(Function));

        contextState.projectShutdownState = { isStopping: true, projectId: mockProject.id };
        rerender(<FilesTab project={mockProject} __testHooks={collectHandlers} />);

        act(() => {
          exposedHandlers.handleTabSelect('src/App.jsx');
        });

        expect(readmeTab).toHaveAttribute('aria-selected', 'true');
        expect(appTab).toHaveAttribute('aria-selected', 'false');
      });
    
      test('should not switch tabs while project is shutting down', async () => {
        const contextState = {
          theme: 'dark',
          stageFileChange: stageFileChangeMock,
          projectShutdownState: { isStopping: false, projectId: mockProject.id },
          isProjectStopping: () => contextState.projectShutdownState.isStopping,
          getFileExplorerState: getFileExplorerStateMock,
          setFileExplorerState: setFileExplorerStateMock,
          editorFocusRequest: null,
          clearEditorFocusRequest: clearEditorFocusRequestMock
        };
        useAppState.mockImplementation(() => contextState);

        mockAxios.get.mockResolvedValueOnce(filesApiResponse());
        const user = userEvent.setup({ pointerEventsCheck: 0 });
        const { rerender } = render(<FilesTab project={mockProject} />);
        await waitFor(() =>
          expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
        );

        await selectFile(user, 'src/App.jsx', 'console.log("app");');

        mockAxios.get.mockResolvedValueOnce(fileContentResponse('readme contents'));
        await user.click(await screen.findByTestId('file-item-README.md'));

        const appTab = screen.getByTestId('file-tab-src/App.jsx');
        const readmeTab = screen.getByTestId('file-tab-README.md');
        expect(readmeTab).toHaveAttribute('aria-selected', 'true');

        contextState.projectShutdownState = { isStopping: true, projectId: mockProject.id };
        rerender(<FilesTab project={mockProject} />);

        await user.click(appTab);

        expect(readmeTab).toHaveAttribute('aria-selected', 'true');
      });

    test('should close active tab and fall back to previous tab', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("app");');

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('readme contents'));
      await user.click(await screen.findByTestId('file-item-README.md'));

      await user.click(screen.getByLabelText('Close README.md'));

      await waitFor(() =>
        expect(screen.getByTestId('file-tab-src/App.jsx')).toHaveAttribute('aria-selected', 'true')
      );
      expect(screen.queryByTestId('file-tab-README.md')).not.toBeInTheDocument();
    });

    test('should switch to a different tab when its header is clicked', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("app");');

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('readme contents'));
      await user.click(await screen.findByTestId('file-item-README.md'));

      const appTab = screen.getByTestId('file-tab-src/App.jsx');
      const readmeTab = screen.getByTestId('file-tab-README.md');
      expect(readmeTab).toHaveAttribute('aria-selected', 'true');

      await user.click(appTab);

      await waitFor(() => expect(appTab).toHaveAttribute('aria-selected', 'true'));
      expect(readmeTab).toHaveAttribute('aria-selected', 'false');
    });

    test('should activate next tab when the first tab closes', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("app");');

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('readme contents'));
      await user.click(await screen.findByTestId('file-item-README.md'));

      const appTab = screen.getByTestId('file-tab-src/App.jsx');
      await user.click(appTab);

      await user.click(within(appTab).getByLabelText('Close App.jsx'));

      await waitFor(() =>
        expect(screen.getByTestId('file-tab-README.md')).toHaveAttribute('aria-selected', 'true')
      );
    });

    test('should reset active state when the final tab closes', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("app");');

      await user.click(screen.getByLabelText('Close App.jsx'));

      await waitFor(() => expect(screen.getByTestId('no-open-files')).toBeInTheDocument());
    });
  });

  describe('File Explorer Persistence', () => {
    test('should hydrate expanded folders from persisted state', async () => {
      getFileExplorerStateMock.mockReturnValue({
        expandedFolders: ['src', 'src/components']
      });

      await renderFilesTab();

      expect(await screen.findByTestId('file-item-src/components/Header.jsx')).toBeInTheDocument();
    });

    test('should persist expanded state when folders toggle', async () => {
      getFileExplorerStateMock.mockReturnValue({ expandedFolders: ['src'] });

      const { user } = await renderFilesTab();
      setFileExplorerStateMock.mockClear();

      const componentsFolder = (await screen.findByText('components')).closest('.folder-item');
      await user.click(componentsFolder);

      expect(setFileExplorerStateMock).toHaveBeenCalledWith(
        mockProject.id,
        expect.objectContaining({
          expandedFolders: expect.arrayContaining(['src', 'src/components'])
        })
      );
    });
  });

  describe('External Save Controls', () => {
    test('should hide inline save button when showInlineSaveButton is false', async () => {
      await renderFilesTab({ componentProps: { showInlineSaveButton: false } });
      expect(screen.queryByTestId('save-file-button')).not.toBeInTheDocument();
    });

    test('should register save handler updates via registerSaveHandler', async () => {
      const unregister = vi.fn();
      const registerSaveHandler = vi.fn(() => unregister);
      const { user } = await renderFilesTab({
        componentProps: { registerSaveHandler, showInlineSaveButton: false }
      });

      await waitFor(() => expect(registerSaveHandler).toHaveBeenCalled());
      let latestRegistration = registerSaveHandler.mock.calls[
        registerSaveHandler.mock.calls.length - 1
      ][0];
      expect(latestRegistration).toEqual(
        expect.objectContaining({ handleSave: expect.any(Function), isDisabled: true })
      );

      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'update');

      await waitFor(() => {
        const recentCall = registerSaveHandler.mock.calls[registerSaveHandler.mock.calls.length - 1][0];
        expect(recentCall.isDisabled).toBe(false);
      });

      latestRegistration = registerSaveHandler.mock.calls[registerSaveHandler.mock.calls.length - 1][0];
      await latestRegistration.handleSave();
      await waitFor(() =>
        expect(mockAxios.put).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files/src/App.jsx`,
          expect.objectContaining({ content: expect.any(String) })
        )
      );
      expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App.jsx', 'editor');
    });
  });

  describe('Code Editor', () => {
    test('should show placeholder when no file is selected', async () => {
      await renderFilesTab();

      expect(screen.getByText('Select a file from the tree to start editing')).toBeInTheDocument();
    });

    test('should display editor when file is selected', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      expect(screen.getByTestId('mock-editor')).toBeInTheDocument();
    });

    test('should have save button when file is selected', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      expect(screen.getByTestId('save-file-button')).toBeInTheDocument();
    });

    test('should configure Monaco Editor with minimap enabled at 150px width', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      expect(lastEditorProps.options.minimap).toEqual(
        expect.objectContaining({ enabled: true, width: 150 })
      );
    });

    test('should fall back to plaintext language for unknown extensions', async () => {
      const customTree = [
        ...sampleFileTree,
        { name: 'notes.custom', path: 'notes.custom', type: 'file' }
      ];
      const { user } = await renderFilesTab({ filesResponse: filesApiResponse(customTree) });
      await selectFile(user, 'notes.custom', 'custom content');

      expect(lastEditorProps.language).toBe('plaintext');
    });

    test('should switch Monaco theme when light mode is active', async () => {
      const { user } = await renderFilesTab({ theme: 'light' });
      await selectFile(user);

      expect(lastEditorProps.theme).toBe('vs-light');
    });

    test('should default Monaco theme to vs-dark when theme is not light', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      expect(lastEditorProps.theme).toBe('vs-dark');
    });

    test('should have save button disabled when file is first opened', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      expect(screen.getByTestId('save-file-button')).toBeDisabled();
    });

    test('should enable save button when content is modified', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'updated');

      expect(screen.getByTestId('save-file-button')).toBeEnabled();
    });

    test('should disable save button again after saving', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'updated');
      await user.click(screen.getByTestId('save-file-button'));

      await waitFor(() => expect(screen.getByTestId('save-file-button')).toBeDisabled());
    });

    test('should stage file changes after saving', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'updated');
      await user.click(screen.getByTestId('save-file-button'));

      await waitFor(() =>
        expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App.jsx', 'editor')
      );
    });

    test('should persist editor content via API when saving', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'updated');

      await user.click(screen.getByTestId('save-file-button'));

      await waitFor(() =>
        expect(mockAxios.put).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files/src/App.jsx`,
          expect.objectContaining({ content: expect.stringContaining('updated') })
        )
      );
    });

    test('should register ctrl/cmd+S shortcut when editor mounts', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      const { addCommand, monaco } = mountEditorShortcut();

      expect(addCommand).toHaveBeenCalledTimes(1);
      const [keybinding] = addCommand.mock.calls[0];
      expect(keybinding).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS);
    });

    test('should not register shortcut when editor API is unavailable', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      expect(() => lastEditorProps.onMount({}, null)).not.toThrow();
    });

    test('should skip shortcut registration when keybinding cannot be determined', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      const editor = { addCommand: vi.fn() };
      const monaco = { KeyMod: null, KeyCode: null };

      lastEditorProps.onMount(editor, monaco);
      expect(editor.addCommand).not.toHaveBeenCalled();
    });

    test('should save file when ctrl/cmd+S shortcut triggers with unsaved changes', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'shortcut save');

      const { triggerShortcut } = mountEditorShortcut();

      await triggerShortcut();

      await waitFor(() =>
        expect(mockAxios.put).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files/src/App.jsx`,
          expect.objectContaining({ content: expect.stringContaining('shortcut save') })
        )
      );
      await waitFor(() =>
        expect(stageFileChangeMock).toHaveBeenCalledWith(mockProject.id, 'src/App.jsx', 'editor')
      );
    });

    test('should ignore ctrl/cmd+S shortcut when file has no pending changes', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user);

      const { triggerShortcut } = mountEditorShortcut();

      await triggerShortcut();

      expect(mockAxios.put).not.toHaveBeenCalled();
    });

    test('should notify parent when file saves successfully', async () => {
      const onFileSaved = vi.fn();
      const { user } = await renderFilesTab({ componentProps: { onFileSaved } });
      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'change');

      await user.click(screen.getByTestId('save-file-button'));

      await waitFor(() => expect(onFileSaved).toHaveBeenCalledWith('src/App.jsx'));
    });

    test('should show error and skip staging when save request fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockAxios.put.mockRejectedValueOnce(new Error('disk full'));
      const onFileSaved = vi.fn();
      const { user } = await renderFilesTab({ componentProps: { onFileSaved } });
      await selectFile(user);
      await user.type(screen.getByTestId('mock-editor'), 'change');

      try {
        await user.click(screen.getByTestId('save-file-button'));

        expect(await screen.findByText('Failed to save file')).toBeInTheDocument();
        expect(onFileSaved).not.toHaveBeenCalled();
        expect(stageFileChangeMock).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should reset save button state when switching files', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'file one');
      await user.type(screen.getByTestId('mock-editor'), ' changed');

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('second file content'));
      await user.click(await screen.findByTestId('file-item-README.md'));

      expect(screen.getByTestId('save-file-button')).toBeDisabled();
    });

    test('should open files when editor focus is requested', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('focused content'));
      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/App.jsx'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`)
      );
      expect(screen.getByTestId('mock-editor')).toHaveValue('focused content');
      expect(clearEditorFocusRequestMock).toHaveBeenCalled();
    });

    test('should expand ancestor folders when editor focus targets nested file', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: () => ({ expandedFolders: ['src'] }),
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);

      await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));
      expect(screen.queryByTestId('file-item-src/components/Header.jsx')).toBeNull();

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('focused header content'));
      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/components/Header.jsx',
        source: 'automation'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/components/Header.jsx`)
      );

      expect(await screen.findByTestId('file-item-src/components/Header.jsx')).toBeInTheDocument();
      expect(clearEditorFocusRequestMock).toHaveBeenCalled();
    });

    test('should auto-load and show diff when focus request includes highlight diff from branches', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
      );

      mockAxios.get
        .mockResolvedValueOnce(fileContentResponse('focused content'))
        .mockResolvedValueOnce(fileDiffContentResponse('HEAD version', 'STAGED version'));

      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/App.jsx',
        source: 'branches',
        highlight: 'diff'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`)
      );
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`,
          expect.any(Object)
        )
      );

      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
      expect(screen.getByTestId('mock-diff-original')).toHaveTextContent('HEAD version');
      expect(screen.getByTestId('mock-diff-modified')).toHaveTextContent('STAGED version');
      expect(clearEditorFocusRequestMock).toHaveBeenCalled();
    });

    test('should auto-load and show diff when focus request includes highlight diff from automation', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
      );

      mockAxios.get
        .mockResolvedValueOnce(fileContentResponse('focused content'))
        .mockResolvedValueOnce(fileDiffContentResponse('HEAD version', 'STAGED version'));

      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/App.jsx',
        source: 'automation',
        highlight: 'diff'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`)
      );
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`,
          expect.any(Object)
        )
      );

      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
      expect(screen.getByTestId('mock-diff-original')).toHaveTextContent('HEAD version');
      expect(screen.getByTestId('mock-diff-modified')).toHaveTextContent('STAGED version');
      expect(clearEditorFocusRequestMock).toHaveBeenCalled();
    });

    test('should auto-load and show diff when focus request includes highlight diff from commits', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
      );

      mockAxios.get
        .mockResolvedValueOnce(fileContentResponse('focused content'))
        .mockResolvedValueOnce(fileDiffContentResponse('PARENT version', 'COMMIT version'));

      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/App.jsx',
        source: 'commits',
        highlight: 'diff',
        commitSha: 'abc123'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`)
      );

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/commits/${encodeURIComponent('abc123')}/files-diff-content/src/App.jsx`,
          expect.any(Object)
        )
      );

      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
      expect(screen.getByTestId('mock-diff-original')).toHaveTextContent('PARENT version');
      expect(screen.getByTestId('mock-diff-modified')).toHaveTextContent('COMMIT version');
      expect(clearEditorFocusRequestMock).toHaveBeenCalled();
    });

    test('should reopen explorer-selected file in normal editor after closing a diff-opened tab', async () => {
      const user = userEvent.setup();
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
      );

      // Open via branches focus request with diff highlight.
      mockAxios.get
        .mockResolvedValueOnce(fileContentResponse('focused content'))
        .mockResolvedValueOnce(fileDiffContentResponse('HEAD version', 'STAGED version'));

      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/App.jsx',
        source: 'branches',
        highlight: 'diff'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`)
      );
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`,
          expect.any(Object)
        )
      );
      expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();

      // Close the tab.
      await user.click(screen.getByLabelText('Close App.jsx'));
      await waitFor(() => expect(screen.queryByTestId('file-diff-panel')).not.toBeInTheDocument());

      // Reopen from the explorer should open normal editor, not diff.
      const contentUrl = `/api/projects/${mockProject.id}/files/src/App.jsx`;
      const contentCallsBefore = mockAxios.get.mock.calls
        .map(([url]) => url)
        .filter((url) => url === contentUrl).length;

      await user.click(screen.getByTestId('file-item-src/App.jsx'));

      expect(await screen.findByTestId('mock-editor')).toHaveValue('focused content');
      expect(screen.queryByTestId('mock-diff-editor')).not.toBeInTheDocument();

      const contentCallsAfter = mockAxios.get.mock.calls
        .map(([url]) => url)
        .filter((url) => url === contentUrl).length;
      expect(contentCallsAfter).toBe(contentCallsBefore);

      const diffCalls = mockAxios.get.mock.calls
        .map(([url]) => url)
        .filter((url) => url.includes('/files-diff-content/'));
      expect(diffCalls).toHaveLength(1);
    });

    test('should not auto-load diff when focus request highlight diff comes from non-branches sources', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        workspaceChanges: {
          [mockProject.id]: {
            stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: new Date().toISOString() }]
          }
        },
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
      );

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('agent content'));
      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/App.jsx',
        source: 'agent',
        highlight: 'diff'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/App.jsx`)
      );
      expect(screen.queryByTestId('file-diff-panel')).not.toBeInTheDocument();

      const calls = mockAxios.get.mock.calls.map(([url]) => url);
      expect(calls).not.toContain(`/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`);
    });

    test('shows staged indicator in explorer and opens diff when indicator is clicked', async () => {
      const { user } = await renderFilesTab({
        overrides: {
          workspaceChanges: {
            [mockProject.id]: {
              stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: new Date().toISOString() }]
            }
          }
        }
      });

      // Staged indicator is present for staged file.
      expect(await screen.findByTestId('staged-diff-button-src/App.jsx')).toBeInTheDocument();

      // Clicking the file row opens normal editor (no diff).
      mockAxios.get.mockResolvedValueOnce(fileContentResponse('normal content'));
      await user.click(screen.getByTestId('file-item-src/App.jsx'));
      expect(await screen.findByTestId('mock-editor')).toHaveValue('normal content');
      expect(screen.queryByTestId('mock-diff-editor')).not.toBeInTheDocument();

      // Clicking the staged indicator opens diff.
      mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('HEAD version', 'STAGED version'));
      await user.click(screen.getByTestId('staged-diff-button-src/App.jsx'));
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`,
          expect.any(Object)
        )
      );
      expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
    });

    test('should toggle diff mode for active file and load diff on demand', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("Hello");');

      mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('HEAD v1', 'STAGED v2'));
      await user.click(screen.getByTestId('toggle-diff-button'));

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`,
          expect.any(Object)
        )
      );
      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
      expect(screen.getByTestId('mock-diff-original')).toHaveTextContent('HEAD v1');
      expect(screen.getByTestId('mock-diff-modified')).toHaveTextContent('STAGED v2');

      await user.click(screen.getByTestId('toggle-diff-button'));
      await waitFor(() => expect(screen.queryByTestId('file-diff-panel')).not.toBeInTheDocument());

      // Toggle on again to ensure the diff state warm-start path is exercised.
      mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse('HEAD v1', 'STAGED v3'));
      await user.click(screen.getByTestId('toggle-diff-button'));
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(
          `/api/projects/${mockProject.id}/files-diff-content/src/App.jsx`,
          expect.any(Object)
        )
      );
      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(await screen.findByTestId('mock-diff-editor')).toBeInTheDocument();
      expect(screen.getByTestId('mock-diff-modified')).toHaveTextContent('STAGED v3');
    });

    test('should show error inside diff panel when diff request fails', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("Hello");');

      mockAxios.get.mockResolvedValueOnce({
        data: { success: false, error: 'Diff unavailable' }
      });
      await user.click(screen.getByTestId('toggle-diff-button'));

      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(await screen.findByText('Diff unavailable')).toBeInTheDocument();
    });

    test('should show server error inside diff panel when diff request rejects', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { user } = await renderFilesTab();
        await selectFile(user, 'src/App.jsx', 'console.log("Hello");');

        const error = Object.assign(new Error('offline'), {
          response: { data: { error: 'Diff service offline' } }
        });
        mockAxios.get.mockRejectedValueOnce(error);

        await user.click(screen.getByTestId('toggle-diff-button'));

        expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
        expect(await screen.findByText('Diff service offline')).toBeInTheDocument();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should normalize non-string diff payloads to empty and show no-diff copy', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("Hello");');

      mockAxios.get.mockResolvedValueOnce(fileDiffContentResponse(null, null));
      await user.click(screen.getByTestId('toggle-diff-button'));

      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(screen.getByText('No diff available.')).toBeInTheDocument();
    });

    test('should fall back to default diff error when payload has no error text', async () => {
      const { user } = await renderFilesTab();
      await selectFile(user, 'src/App.jsx', 'console.log("Hello");');

      mockAxios.get.mockResolvedValueOnce({ data: undefined });
      await user.click(screen.getByTestId('toggle-diff-button'));

      expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
      expect(await screen.findByText('Diff unavailable')).toBeInTheDocument();
    });

    test('should fall back to default diff error when request rejects without response data', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const { user } = await renderFilesTab();
        await selectFile(user, 'src/App.jsx', 'console.log("Hello");');

        mockAxios.get.mockRejectedValueOnce(new Error('Network exploded'));
        await user.click(screen.getByTestId('toggle-diff-button'));

        expect(await screen.findByTestId('file-diff-panel')).toBeInTheDocument();
        expect(await screen.findByText('Diff unavailable')).toBeInTheDocument();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should not attempt to fetch diff when focus request has no active project id', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: {
          filePath: 'src/App.jsx',
          source: 'branches',
          highlight: 'diff'
        },
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      render(<FilesTab project={null} />);

      await waitFor(() => expect(clearEditorFocusRequestMock).toHaveBeenCalled());

      expect(mockAxios.get).not.toHaveBeenCalled();
    });

    test('should fallback to full path name when focus request lacks basename', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`));

      mockAxios.get.mockResolvedValueOnce(fileContentResponse('folder focus content'));
      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: 'src/components/'
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files/src/components/`)
      );
      expect(screen.getByTestId('file-tab-src/components/')).toHaveTextContent('src/components/');
    });

    test('should ignore editor focus request when file path is missing', async () => {
      const contextState = {
        theme: 'dark',
        stageFileChange: stageFileChangeMock,
        projectShutdownState: {},
        isProjectStopping: () => false,
        getFileExplorerState: getFileExplorerStateMock,
        setFileExplorerState: setFileExplorerStateMock,
        editorFocusRequest: null,
        clearEditorFocusRequest: clearEditorFocusRequestMock
      };
      useAppState.mockImplementation(() => contextState);

      mockAxios.get.mockResolvedValueOnce(filesApiResponse());
      const { rerender } = render(<FilesTab project={mockProject} />);
      await waitFor(() =>
        expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/files`)
      );

      contextState.editorFocusRequest = {
        projectId: mockProject.id,
        filePath: ''
      };
      rerender(<FilesTab project={mockProject} />);

      await waitFor(() => expect(mockAxios.get).toHaveBeenCalledTimes(1));
      expect(clearEditorFocusRequestMock).not.toHaveBeenCalled();
    });

    test('should warn when staging file changes fails', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stageFileChangeMock.mockRejectedValueOnce(new Error('git fail'));

      try {
        const { user } = await renderFilesTab();
        await selectFile(user);
        await user.type(screen.getByTestId('mock-editor'), 'change');

        await user.click(screen.getByTestId('save-file-button'));

        await waitFor(() =>
          expect(consoleSpy).toHaveBeenCalledWith('Failed to stage file change', expect.any(Error))
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should allow test hooks to coalesce undefined editor edits', async () => {
      let hooks;
      const collectHooks = (value) => {
        if (value) {
          hooks = value;
        }
      };
      await renderFilesTab({ componentProps: { __testHooks: collectHooks } });
      await waitFor(() => {
        expect(hooks?.handleToggleDiffMode).toBeTypeOf('function');
        expect(hooks?.forceActiveFilePath).toBeTypeOf('function');
        expect(hooks?.handleEditorChange).toBeTypeOf('function');
        expect(hooks?.getFileStates).toBeTypeOf('function');
      });

      // No active file is selected yet, so diff toggle should no-op.
      const callsBefore = mockAxios.get.mock.calls.length;
      await act(async () => {
        await hooks.handleToggleDiffMode();
      });
      expect(mockAxios.get.mock.calls.length).toBe(callsBefore);

      await act(async () => {
        hooks.forceActiveFilePath('virtual.js');
      });

      await act(async () => {
        hooks.handleEditorChange(undefined);
      });

      await waitFor(() => {
        const fileStates = hooks.getFileStates();
        expect(fileStates['virtual.js']).toEqual(
          expect.objectContaining({ content: '', originalContent: '', isLoading: false })
        );
      });
    });

    test('should support functional updates via forceFileState hook', async () => {
      let hooks;
      const collectHooks = (value) => {
        if (value) {
          hooks = value;
        }
      };
      await renderFilesTab({ componentProps: { __testHooks: collectHooks } });
      await waitFor(() => {
        expect(hooks?.forceFileState).toBeTypeOf('function');
        expect(hooks?.getFileStates).toBeTypeOf('function');
      });

      await act(async () => {
        hooks.forceFileState('virtual.js', {
          content: 'seed',
          originalContent: 'seed',
          isLoading: false
        });
      });

      await act(async () => {
        hooks.forceFileState('virtual.js', (prev) => ({
          ...prev,
          content: `${prev?.content || ''} + delta`
        }));
      });

      const state = hooks.getFileStates()['virtual.js'];
      expect(state.content).toBe('seed + delta');
      expect(state.originalContent).toBe('seed');
    });

    test('should save empty payloads when editor state becomes undefined', async () => {
      let hooks;
      const collectHooks = (value) => {
        if (value) {
          hooks = value;
        }
      };
      await renderFilesTab({ componentProps: { __testHooks: collectHooks } });
      await waitFor(() => {
        expect(hooks?.forceActiveFilePath).toBeTypeOf('function');
        expect(hooks?.forceFileState).toBeTypeOf('function');
        expect(hooks?.handleSaveFile).toBeTypeOf('function');
        expect(hooks?.getFileStates).toBeTypeOf('function');
      });

      await act(async () => {
        hooks.forceActiveFilePath('virtual.js');
        hooks.forceFileState('virtual.js', {
          content: undefined,
          originalContent: 'seed',
          isLoading: false
        });
      });

      await act(async () => {
        await hooks.handleSaveFile();
      });

      expect(mockAxios.put).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/files/virtual.js`,
        expect.objectContaining({ content: '' })
      );
      await waitFor(() => expect(hooks.getFileStates()['virtual.js'].originalContent).toBe(''));
    });
  });
});
