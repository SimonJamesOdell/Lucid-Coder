import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import AssetsTab from '../components/AssetsTab';
import * as assistantAssetContextModule from '../utils/assistantAssetContext';
import {
  clearAssistantAssetContextPaths,
  getAssistantAssetContextPaths,
  setAssistantAssetContextPaths
} from '../utils/assistantAssetContext';

const mockAxios = axios;

const project = { id: 'project-1', name: 'Demo' };

const assetsResponse = (assets) => ({
  data: {
    success: true,
    assets
  }
});

const sampleAssets = [
  {
    name: 'image.png',
    path: 'uploads/image.png',
    sizeBytes: 123456,
    pixelWidth: 1024,
    pixelHeight: 1536,
    optimizedForTransmission: false,
    optimizationReason: 'png_density_high'
  },
  {
    name: 'clip.mp4',
    path: 'uploads/clip.mp4',
    sizeBytes: 98765,
    optimizedForTransmission: true,
    optimizationReason: 'format_allowlisted'
  },
  {
    name: 'audio.mp3',
    path: 'uploads/audio.mp3',
    sizeBytes: 54321,
    optimizedForTransmission: true,
    optimizationReason: 'format_allowlisted'
  },
  {
    name: 'doc.pdf',
    path: 'uploads/doc.pdf',
    sizeBytes: 777,
    optimizedForTransmission: false,
    optimizationReason: 'unsupported_format'
  }
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAxios.get.mockReset();
  mockAxios.post.mockReset();
  window.confirm = vi.fn(() => true);
  window.alert = vi.fn();
  clearAssistantAssetContextPaths(project.id);
});

describe('AssetsTab', () => {
  test('renders project prompt when no project is selected', () => {
    render(<AssetsTab project={null} />);
    expect(screen.getByText('Select a project to view assets.')).toBeInTheDocument();
    expect(mockAxios.get).not.toHaveBeenCalled();
  });

  test('loads and renders asset cards with metadata', async () => {
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledWith(`/api/projects/${project.id}/assets`);
    });

    const cards = await screen.findAllByTestId('asset-card');
    expect(cards).toHaveLength(4);
    expect(screen.getByText('Dimensions: 1024 × 1536 px')).toBeInTheDocument();
    expect(screen.queryByText('No uploaded assets yet. Use the + button in chat to add files.')).not.toBeInTheDocument();
  });

  test('toggles include in AI context without opening the viewer', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const videoCard = cards.find((card) => within(card).queryByText('uploads/clip.mp4'));
    const imageCheckbox = within(imageCard).getByRole('checkbox', { name: 'Include in AI context' });
    const videoCheckbox = within(videoCard).getByRole('checkbox', { name: 'Include in AI context' });

    await user.click(imageCheckbox);

    expect(screen.queryByTestId('asset-viewer')).not.toBeInTheDocument();
    expect(imageCheckbox).toBeChecked();
    expect(videoCheckbox).toBeDisabled();
    expect(videoCard).toHaveClass('assets-tab__card--dimmed');
    expect(getAssistantAssetContextPaths(project.id)).toContain('uploads/image.png');
    expect(screen.getByText('AI context: 1')).toBeInTheDocument();

    await user.click(imageCheckbox);
    expect(videoCheckbox).not.toBeDisabled();
    expect(videoCard).not.toHaveClass('assets-tab__card--dimmed');
    expect(getAssistantAssetContextPaths(project.id)).not.toContain('uploads/image.png');
    expect(screen.getByText('AI context: 0')).toBeInTheDocument();
  });

  test('shows server error and supports refresh', async () => {
    const user = userEvent.setup();

    mockAxios.get
      .mockResolvedValueOnce({ data: { success: false, error: 'Backend exploded' } })
      .mockResolvedValueOnce(assetsResponse([]));

    render(<AssetsTab project={project} />);

    expect(await screen.findByText('Backend exploded')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledTimes(2);
    });
  });

  test('opens image viewer and supports wheel zoom + close', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    expect(imageCard).toBeTruthy();
    await user.click(imageCard);

    expect(await screen.findByTestId('asset-viewer')).toBeInTheDocument();
    expect(screen.getByText(/zoom\s*100%/i)).toBeInTheDocument();

    const panZoomRegion = screen.getByAltText('image.png').closest('.assets-tab__image-panzoom');
    expect(panZoomRegion).toBeTruthy();

    fireEvent.wheel(panZoomRegion, { deltaY: -500 });

    await waitFor(() => {
      expect(screen.getByText(/Zoom\s+\d+%/)).toBeInTheDocument();
      expect(screen.queryByText(/zoom\s*100%/i)).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('asset-viewer')).not.toBeInTheDocument();
  });

  test('supports image panning and resets offset when zooming back to 100%', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    expect(imageCard).toBeTruthy();
    await user.click(imageCard);

    const image = await screen.findByAltText('image.png');
    const panZoomRegion = image.closest('.assets-tab__image-panzoom');
    expect(panZoomRegion).toBeTruthy();

    fireEvent.wheel(panZoomRegion, { deltaY: -1200 });

    fireEvent.mouseDown(panZoomRegion, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(panZoomRegion, { clientX: 150, clientY: 145 });

    await waitFor(() => {
      expect(image.style.transform).toContain('translate(50px, 45px)');
    });

    fireEvent.mouseUp(panZoomRegion);
    fireEvent.wheel(panZoomRegion, { deltaY: 5000 });

    await waitFor(() => {
      expect(image.style.transform).toContain('translate(0px, 0px)');
    });
  });

  test('renders video, audio, and fallback previews for non-image assets', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValue(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');

    const videoCard = cards.find((card) => within(card).queryByText('uploads/clip.mp4'));
    expect(videoCard).toBeTruthy();
    await user.click(videoCard);

    let viewer = await screen.findByTestId('asset-viewer');
    expect(screen.queryByText(/zoom\s*\d+%/i)).not.toBeInTheDocument();
    expect(viewer.querySelector('video')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    const refreshedCardsA = await screen.findAllByTestId('asset-card');
    const audioCard = refreshedCardsA.find((card) => within(card).queryByText('uploads/audio.mp3'));
    expect(audioCard).toBeTruthy();
    await user.click(audioCard);

    viewer = await screen.findByTestId('asset-viewer');
    expect(viewer.querySelector('audio')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    const refreshedCardsB = await screen.findAllByTestId('asset-card');
    const docCard = refreshedCardsB.find((card) => within(card).queryByText('uploads/doc.pdf'));
    expect(docCard).toBeTruthy();
    await user.click(docCard);

    expect(await screen.findByText('Preview not available for this file type.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download file' })).toBeInTheDocument();
  });

  test('updates selected viewer path after optimize when selected asset is replaced', async () => {
    const user = userEvent.setup();

    const optimizedAssets = [
      {
        ...sampleAssets[0],
        name: 'image.webp',
        path: 'uploads/image.webp'
      },
      ...sampleAssets.slice(1)
    ];

    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(optimizedAssets))
      .mockResolvedValueOnce(assetsResponse(optimizedAssets));

    mockAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        path: 'uploads/image.webp'
      }
    });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    expect(imageCard).toBeTruthy();
    await user.click(imageCard);

    expect(await screen.findByText('uploads/image.png')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Optimize' }));
    await user.click(await screen.findByRole('button', { name: 'Auto Optimize' }));

    await waitFor(() => {
      expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${project.id}/assets/optimize`, {
        assetPath: 'uploads/image.png',
        mode: 'auto'
      });
    });

    await waitFor(() => {
      expect(screen.getByText('uploads/image.webp')).toBeInTheDocument();
    });
  });

  test('renders helper fallbacks for unknown extensions and byte size tiers', async () => {
    mockAxios.get.mockResolvedValueOnce(assetsResponse([
      {
        name: 'weird',
        path: 'uploads/noext',
        sizeBytes: -5,
        optimizedForTransmission: false,
        optimizationReason: 'insufficient_metadata'
      },
      {
        name: 'trailing-dot',
        path: 'uploads/file.',
        sizeBytes: 500,
        optimizedForTransmission: false,
        optimizationReason: 'insufficient_metadata'
      },
      {
        name: 'medium.bin',
        path: 'uploads/medium.bin',
        sizeBytes: 2_048,
        optimizedForTransmission: false,
        optimizationReason: 'insufficient_metadata'
      },
      {
        name: 'huge.bin',
        path: 'uploads/huge.bin',
        sizeBytes: 2_147_483_648,
        optimizedForTransmission: false,
        optimizationReason: 'insufficient_metadata'
      }
    ]));

    render(<AssetsTab project={project} />);

    await screen.findAllByTestId('asset-card');

    expect(screen.getByText('Size on disk: Unknown')).toBeInTheDocument();
    expect(screen.getByText('Size on disk: 500 B')).toBeInTheDocument();
    expect(screen.getByText('Size on disk: 2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('Size on disk: 2.0 GB')).toBeInTheDocument();

    const badges = screen.getAllByText('FILE');
    expect(badges.length).toBeGreaterThan(0);
  });

  test('covers helper fallback branches for non-string extension and MB size formatting', () => {
    expect(AssetsTab.__testHooks?.helpers?.buildRenamedAssetPath?.(null, 'hero')).toEqual({
      error: 'Rename cancelled or empty name.'
    });
    expect(AssetsTab.__testHooks?.helpers?.getFileExtension?.(null)).toBe('');
    expect(AssetsTab.__testHooks?.helpers?.getFileExtension?.('uploads/')).toBe('');
    expect(AssetsTab.__testHooks?.helpers?.formatSizeBytes?.(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(AssetsTab.__testHooks?.helpers?.encodeRepoPath?.(null)).toBe('');
    expect(AssetsTab.__testHooks?.helpers?.buildRenamedAssetPath?.('uploads/image.png', '')).toEqual({
      error: 'Rename cancelled or empty name.'
    });
    expect(AssetsTab.__testHooks?.helpers?.buildRenamedAssetPath?.('uploads/image.png', 'next')).toEqual({
      error: null,
      toPath: 'uploads/next.png',
      unchanged: false
    });
    expect(AssetsTab.__testHooks?.helpers?.buildRenamedAssetPath?.('uploads/readme', 'guide')).toEqual({
      error: null,
      toPath: 'uploads/guide',
      unchanged: false
    });
    expect(AssetsTab.__testHooks?.helpers?.buildRenamedAssetPath?.('uploads/image.png', '.')).toEqual({
      error: 'Name is invalid.'
    });
    expect(AssetsTab.__testHooks?.helpers?.buildRenamedAssetPath?.('/', 'hero')).toEqual({
      error: 'Asset path is invalid.'
    });
  });

  test('opens rename modal from viewer action button', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    await user.click(imageCard);

    const viewerRename = await screen.findByRole('button', { name: 'Rename' });
    await user.click(viewerRename);

    expect(await screen.findByTestId('asset-rename-modal')).toBeInTheDocument();
  });

  test('renames asset and refreshes rendered asset path', async () => {
    const user = userEvent.setup();
    setAssistantAssetContextPaths(project.id, ['uploads/image.png', 'uploads/audio.mp3']);

    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse([
        { ...sampleAssets[0], name: 'hero.png', path: 'uploads/hero.png' },
        ...sampleAssets.slice(1)
      ]))
      .mockResolvedValueOnce(assetsResponse([
        { ...sampleAssets[0], name: 'hero.png', path: 'uploads/hero.png' },
        ...sampleAssets.slice(1)
      ]));
    mockAxios.post.mockResolvedValueOnce({ data: { success: true } });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const renameButton = imageCard.querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'hero');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${project.id}/files-ops/rename`, {
        fromPath: 'uploads/image.png',
        toPath: 'uploads/hero.png'
      });
    });

    await waitFor(() => {
      expect(screen.getByText('uploads/hero.png')).toBeInTheDocument();
      expect(dispatchSpy).toHaveBeenCalled();
    });
  });

  test('shows validation error when rename includes path separators', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const renameButton = cards[0].querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'nested/hero');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('asset-rename-error')).toHaveTextContent('Name cannot include path separators.');
  });

  test('shows validation error when name includes an extension suffix', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const renameButton = imageCard.querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    expect(await screen.findByTestId('asset-rename-extension')).toHaveTextContent('.png');

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'hero.jpg');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('asset-rename-error')).toHaveTextContent('Name cannot include an extension.');
  });

  test('shows inline error when rename endpoint throws', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockRejectedValueOnce(new Error('Rename failed hard'));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const renameButton = cards[0].querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'hero');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(screen.getByTestId('asset-rename-error')).toHaveTextContent('Rename failed hard');
    });
  });

  test('uses rename fallback message when success=false has no backend error details', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const renameButton = imageCard.querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'hero');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(screen.getByTestId('asset-rename-error')).toHaveTextContent('Failed to rename asset');
    });
  });

  test('uses backend response rename error details when request rejects with response payload', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Rename rejected from backend'
        }
      }
    });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const renameButton = imageCard.querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'hero');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(screen.getByTestId('asset-rename-error')).toHaveTextContent('Rename rejected from backend');
    });
  });

  test('uses default rename error message when request rejects without message details', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockRejectedValueOnce({});

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const renameButton = imageCard.querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'hero');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(screen.getByTestId('asset-rename-error')).toHaveTextContent('Failed to rename asset');
    });
  });

  test('keeps rename modal open while submitting and clears error when input changes', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    let resolveRename;
    const renamePromise = new Promise((resolve) => {
      resolveRename = resolve;
    });
    mockAxios.post.mockReturnValueOnce(renamePromise);

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const renameButton = cards[0].querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'hero');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    expect(await screen.findByRole('button', { name: 'Renaming…' })).toBeInTheDocument();

    await user.click(screen.getByTestId('asset-rename-close'));
    expect(screen.getByTestId('asset-rename-modal')).toBeInTheDocument();

    resolveRename({ data: { success: false, error: 'rename failed from backend' } });
    expect(await screen.findByTestId('asset-rename-error')).toHaveTextContent('rename failed from backend');

    await user.type(renameInput, 'x');
    await waitFor(() => {
      expect(screen.queryByTestId('asset-rename-error')).not.toBeInTheDocument();
    });
  });

  test('closes rename modal without request when submitted name is unchanged', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const renameButton = imageCard.querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameModal = await screen.findByTestId('asset-rename-modal');
    await user.click(within(renameModal).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(screen.queryByTestId('asset-rename-modal')).not.toBeInTheDocument();
    });
    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  test('closes rename modal via close button and clears validation error state', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const renameButton = imageCard.querySelector('.assets-tab__action--rename');
    await user.click(renameButton);

    const renameInput = await screen.findByRole('textbox', { name: /name/i });
    await user.clear(renameInput);
    await user.type(renameInput, 'nested/hero');
    await user.click(within(screen.getByTestId('asset-rename-modal')).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByTestId('asset-rename-error')).toBeInTheDocument();

    await user.click(screen.getByTestId('asset-rename-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('asset-rename-modal')).not.toBeInTheDocument();
    });

    await user.click(renameButton);
    expect(await screen.findByRole('textbox', { name: /name/i })).toHaveValue('image');
    expect(screen.queryByTestId('asset-rename-error')).not.toBeInTheDocument();
  });

  test('handles assets payload fallback branches and default load error message', async () => {
    const user = userEvent.setup();

    mockAxios.get
      .mockResolvedValueOnce({ data: { success: true, assets: { not: 'array' } } })
      .mockRejectedValueOnce({});

    render(<AssetsTab project={project} />);

    expect(await screen.findByText('No uploaded assets yet. Use the + button in chat to add files.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Failed to load assets')).toBeInTheDocument();
  });

  test('uses backend response error message when asset loading request rejects', async () => {
    mockAxios.get.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Load rejected from backend'
        }
      }
    });

    render(<AssetsTab project={project} />);

    expect(await screen.findByText('Load rejected from backend')).toBeInTheDocument();
  });

  test('alerts when delete endpoint responds with success=false', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'Delete denied' } });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const deleteButton = imageCard.querySelector('.assets-tab__action--delete');
    await user.click(deleteButton);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Delete denied');
    });
  });

  test('uses default delete error fallback messages when payload has no details', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const deleteButton = imageCard.querySelector('.assets-tab__action--delete');
    await user.click(deleteButton);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Failed to delete asset');
    });

    mockAxios.post.mockRejectedValueOnce({});
    await user.click(deleteButton);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Failed to delete asset');
    });
  });

  test('alerts when delete endpoint throws an error', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockRejectedValueOnce(new Error('Delete hard failure'));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const deleteButton = imageCard.querySelector('.assets-tab__action--delete');
    await user.click(deleteButton);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Delete hard failure');
    });
  });

  test('alerts using backend delete rejection response error details', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Delete rejected from backend'
        }
      }
    });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const deleteButton = imageCard.querySelector('.assets-tab__action--delete');
    await user.click(deleteButton);

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Delete rejected from backend');
    });
  });

  test('alerts when optimize endpoint responds with success=false', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'Optimize denied' } });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const optimizeButton = cards[0].querySelector('.assets-tab__action--optimize');

    await user.click(optimizeButton);
    await user.click(await screen.findByRole('button', { name: 'Auto Optimize' }));

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Optimize denied');
    });
  });

  test('closes optimize modal via close control', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const optimizeButton = cards[0].querySelector('.assets-tab__action--optimize');

    await user.click(optimizeButton);
    expect(await screen.findByTestId('asset-optimize-modal')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close optimize modal' }));

    await waitFor(() => {
      expect(screen.queryByTestId('asset-optimize-modal')).not.toBeInTheDocument();
    });
  });

  test('uses optimize fallback branches for missing error details and non-string replacement path', async () => {
    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(sampleAssets));

    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true, path: 123 } })
      .mockResolvedValueOnce({ data: { success: false } })
      .mockRejectedValueOnce({});

    render(<AssetsTab project={project} />);

    await screen.findAllByTestId('asset-card');

    const hooks = AssetsTab.__testHooks?.handlers;
    expect(typeof hooks?.optimizeAsset).toBe('function');

    await hooks.optimizeAsset('uploads/image.png', { quality: 76, scalePercent: 100, format: 'auto' });

    await waitFor(() => {
      expect(window.alert).not.toHaveBeenCalled();
    });

    await hooks.optimizeAsset('uploads/image.png', { quality: 76, scalePercent: 100, format: 'auto' });
    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Failed to optimize asset');
    });

    await hooks.optimizeAsset('uploads/image.png', { quality: 76, scalePercent: 100, format: 'auto' });
    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Failed to optimize asset');
    });
  });

  test('renders unknown image dimensions and safely handles stale selected/modal asset paths', async () => {
    const user = userEvent.setup();
    const imageWithoutDimensions = [
      {
        ...sampleAssets[0],
        pixelWidth: null,
        pixelHeight: null
      }
    ];

    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(imageWithoutDimensions))
      .mockResolvedValueOnce(assetsResponse(imageWithoutDimensions))
      .mockResolvedValueOnce(assetsResponse([]));

    render(<AssetsTab project={project} />);

    const card = (await screen.findAllByTestId('asset-card'))[0];
    expect(screen.getByText((text) => text.includes('Dimensions: Unknown'))).toBeInTheDocument();
    await user.click(card);

    await user.click(screen.getByRole('button', { name: 'Optimize' }));

    window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
      detail: { projectId: project.id }
    }));

    window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
      detail: { projectId: project.id }
    }));

    await waitFor(() => {
      expect(screen.queryByTestId('asset-optimize-modal')).not.toBeInTheDocument();
    });
  });

  test('ignores pan start/move/end while image is at native zoom', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    await user.click(imageCard);

    const image = await screen.findByAltText('image.png');
    const panZoomRegion = image.closest('.assets-tab__image-panzoom');

    fireEvent.mouseDown(panZoomRegion, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(panZoomRegion, { clientX: 140, clientY: 140 });
    fireEvent.mouseUp(panZoomRegion);

    expect(image.style.transform).toContain('translate(0px, 0px)');
  });

  test('covers early-return guards for delete/optimize handlers and modal action guards', async () => {
    render(<AssetsTab project={project} />);

    const hooks = AssetsTab.__testHooks?.handlers;
    expect(typeof hooks?.deleteAsset).toBe('function');
    expect(typeof hooks?.applyAssetRename).toBe('function');
    expect(typeof hooks?.renameAsset).toBe('function');
    expect(typeof hooks?.openOptimizeModal).toBe('function');
    expect(typeof hooks?.submitRenameModal).toBe('function');
    expect(typeof hooks?.optimizeAsset).toBe('function');
    expect(typeof hooks?.handleAutoOptimize).toBe('function');
    expect(typeof hooks?.handleManualOptimize).toBe('function');

    await hooks.deleteAsset('');
    await hooks.applyAssetRename({ fromPath: '', toPath: '' });
    hooks.renameAsset('');
    await hooks.submitRenameModal();
    await hooks.optimizeAsset('');
    hooks.handleAutoOptimize();
    hooks.handleManualOptimize({ quality: 70, scalePercent: 100, format: 'auto' });

    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  test('renaming selected asset updates selected and optimize modal paths', async () => {
    const user = userEvent.setup();
    setAssistantAssetContextPaths(project.id, ['uploads/image.png', 'uploads/audio.mp3']);
    const getContextSpy = vi.spyOn(assistantAssetContextModule, 'getAssistantAssetContextPaths')
      .mockReturnValue(['uploads/image.png']);
    const renamedAssets = [
      { ...sampleAssets[0], name: 'hero.png', path: 'uploads/hero.png' },
      ...sampleAssets.slice(1)
    ];
    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(renamedAssets));
    mockAxios.post.mockResolvedValueOnce({ data: { success: true } });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    const optimizeButton = imageCard.querySelector('.assets-tab__action--optimize');

    await user.click(imageCard);
    await user.click(optimizeButton);

    const hooks = AssetsTab.__testHooks?.handlers;
    hooks.openOptimizeModal('uploads/image.png');
    await waitFor(() => {
      expect(screen.getByTestId('asset-optimize-modal')).toBeInTheDocument();
    });
    await hooks.applyAssetRename({
      fromPath: 'uploads/image.png',
      toPath: 'uploads/hero.png'
    });

    await waitFor(() => {
      expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${project.id}/files-ops/rename`, {
        fromPath: 'uploads/image.png',
        toPath: 'uploads/hero.png'
      });
    });
    getContextSpy.mockRestore();
  });

  test('deletes asset on confirmation and refreshes list', async () => {
    const user = userEvent.setup();
    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(sampleAssets.slice(1)));
    mockAxios.post.mockResolvedValueOnce({ data: { success: true } });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    expect(imageCard).toBeTruthy();
    const deleteButton = imageCard.querySelector('.assets-tab__action--delete');

    await user.click(deleteButton);

    await waitFor(() => {
      expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${project.id}/files-ops/delete`, {
        targetPath: 'uploads/image.png',
        recursive: false
      });
    });

    expect(dispatchSpy).toHaveBeenCalled();
  });

  test('does not delete when user cancels confirmation', async () => {
    const user = userEvent.setup();
    window.confirm = vi.fn(() => false);

    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const deleteButton = cards[0].querySelector('.assets-tab__action--delete');
    await user.click(deleteButton);

    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  test('optimizes selected asset via modal (manual + auto)', async () => {
    const user = userEvent.setup();

    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(sampleAssets));

    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true, path: 'uploads/image.webp' } })
      .mockResolvedValueOnce({ data: { success: true, path: 'uploads/image.webp' } });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const imageCard = cards.find((card) => within(card).queryByText('uploads/image.png'));
    expect(imageCard).toBeTruthy();
    const optimizeButton = imageCard.querySelector('.assets-tab__action--optimize');

    await user.click(optimizeButton);

    expect(await screen.findByTestId('asset-optimize-modal')).toBeInTheDocument();

    const modal = await screen.findByTestId('asset-optimize-modal');
    await user.click(within(modal).getByRole('button', { name: 'Optimize' }));

    await waitFor(() => {
      expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${project.id}/assets/optimize`, {
        assetPath: 'uploads/image.png',
        mode: 'manual',
        options: {
          quality: 76,
          scalePercent: 100,
          format: 'auto'
        }
      });
    });

    await user.click(optimizeButton);
    await user.click(within(await screen.findByTestId('asset-optimize-modal')).getByRole('button', { name: 'Auto Optimize' }));

    await waitFor(() => {
      expect(mockAxios.post).toHaveBeenCalledWith(`/api/projects/${project.id}/assets/optimize`, {
        assetPath: 'uploads/image.png',
        mode: 'auto'
      });
    });
  });

  test('handles optimize errors with alert fallback', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockRejectedValueOnce(new Error('Optimize failed hard'));

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const optimizeButton = cards[0].querySelector('.assets-tab__action--optimize');

    await user.click(optimizeButton);
    await user.click(await screen.findByRole('button', { name: 'Auto Optimize' }));

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Optimize failed hard');
    });
  });

  test('alerts using backend optimize rejection response error details', async () => {
    const user = userEvent.setup();
    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Optimize rejected from backend'
        }
      }
    });

    render(<AssetsTab project={project} />);

    const cards = await screen.findAllByTestId('asset-card');
    const optimizeButton = cards[0].querySelector('.assets-tab__action--optimize');

    await user.click(optimizeButton);
    await user.click(await screen.findByRole('button', { name: 'Auto Optimize' }));

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Optimize rejected from backend');
    });
  });

  test('reacts to lucidcoder:assets-updated events for same project only', async () => {
    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(sampleAssets.slice(0, 2)));

    render(<AssetsTab project={project} />);

    await screen.findAllByTestId('asset-card');

    window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
      detail: { projectId: 'different-project' }
    }));

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
      detail: { projectId: project.id }
    }));

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledTimes(2);
    });
  });

  test('prunes stale AI context paths after reloading assets', async () => {
    setAssistantAssetContextPaths(project.id, ['uploads/stale.png']);

    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    await screen.findAllByTestId('asset-card');

    expect(getAssistantAssetContextPaths(project.id)).toEqual([]);
    expect(screen.getByText('AI context: 0')).toBeInTheDocument();
  });

  test('keeps AI context paths when reload still contains selected assets', async () => {
    setAssistantAssetContextPaths(project.id, ['uploads/image.png']);

    mockAxios.get.mockResolvedValueOnce(assetsResponse(sampleAssets));

    render(<AssetsTab project={project} />);

    await screen.findAllByTestId('asset-card');

    expect(getAssistantAssetContextPaths(project.id)).toEqual(['uploads/image.png']);
    expect(screen.getByText('AI context: 1')).toBeInTheDocument();
  });

  test('updates AI context mapping when optimize returns a replacement path', async () => {
    setAssistantAssetContextPaths(project.id, ['uploads/image.png', 'uploads/clip.mp4']);

    mockAxios.get
      .mockResolvedValueOnce(assetsResponse(sampleAssets))
      .mockResolvedValueOnce(assetsResponse(sampleAssets));
    mockAxios.post.mockResolvedValueOnce({
      data: {
        success: true,
        path: 'uploads/image-optimized.png'
      }
    });

    render(<AssetsTab project={project} />);

    await screen.findAllByTestId('asset-card');

    const hooks = AssetsTab.__testHooks?.handlers;
    expect(typeof hooks?.optimizeAsset).toBe('function');

    await hooks.optimizeAsset('uploads/image.png', { quality: 76, scalePercent: 100, format: 'auto' });

    await waitFor(() => {
      expect(getAssistantAssetContextPaths(project.id)).toEqual(['uploads/clip.mp4', 'uploads/image-optimized.png']);
    });
  });

  test('covers toggleAssistantAssetContextPath guard for empty asset path', () => {
    render(<AssetsTab project={project} />);

    const hooks = AssetsTab.__testHooks?.handlers;
    expect(typeof hooks?.toggleAssistantAssetContextPath).toBe('function');

    hooks.toggleAssistantAssetContextPath('');

    expect(getAssistantAssetContextPaths(project.id)).toEqual([]);
  });
});
