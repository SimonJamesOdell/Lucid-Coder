import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import AssetsTab from '../components/AssetsTab';

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
    expect(AssetsTab.__testHooks?.helpers?.getFileExtension?.(null)).toBe('');
    expect(AssetsTab.__testHooks?.helpers?.getFileExtension?.('uploads/')).toBe('');
    expect(AssetsTab.__testHooks?.helpers?.formatSizeBytes?.(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(AssetsTab.__testHooks?.helpers?.encodeRepoPath?.(null)).toBe('');
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
    expect(typeof hooks?.optimizeAsset).toBe('function');
    expect(typeof hooks?.handleAutoOptimize).toBe('function');
    expect(typeof hooks?.handleManualOptimize).toBe('function');

    await hooks.deleteAsset('');
    await hooks.optimizeAsset('');
    hooks.handleAutoOptimize();
    hooks.handleManualOptimize({ quality: 70, scalePercent: 100, format: 'auto' });

    expect(mockAxios.post).not.toHaveBeenCalled();
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
});
