import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import ProjectSourceSection from '../components/create-project/ProjectSourceSection';
import CompatibilitySection from '../components/create-project/CompatibilitySection';
import CreateProjectFormActions from '../components/create-project/CreateProjectFormActions';

describe('create-project extracted sections', () => {
  test('ProjectSourceSection changes source and clears error', async () => {
    const user = userEvent.setup();
    const setProjectSource = vi.fn();
    const setCreateError = vi.fn();

    render(
      <ProjectSourceSection
        projectSource="new"
        setProjectSource={setProjectSource}
        setCreateError={setCreateError}
        createLoading={false}
      />
    );

    await user.click(screen.getByDisplayValue('git'));
    expect(setProjectSource).toHaveBeenCalledWith('git');
    expect(setCreateError).toHaveBeenCalledWith('');
  });

  test('CompatibilitySection renders changes and handles consents', async () => {
    const user = userEvent.setup();
    const setCompatibilityConsent = vi.fn();
    const setStructureConsent = vi.fn();

    render(
      <CompatibilitySection
        compatibilityStatus={{ isLoading: false, error: '' }}
        compatibilityPlan={{ structure: { needsMove: true } }}
        compatibilityChanges={[{ key: 'host', description: 'Bind host to 0.0.0.0' }]}
        compatibilityConsent={false}
        setCompatibilityConsent={setCompatibilityConsent}
        structureConsent={false}
        setStructureConsent={setStructureConsent}
      />
    );

    expect(screen.getByText('Bind host to 0.0.0.0')).toBeInTheDocument();
    expect(screen.getByText('Frontend files will be moved into a frontend/ folder.')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /allow compatibility updates/i }));
    await user.click(screen.getByRole('checkbox', { name: /move frontend files into a frontend folder/i }));

    expect(setCompatibilityConsent).toHaveBeenCalled();
    expect(setStructureConsent).toHaveBeenCalled();
  });

  test('CreateProjectFormActions labels submit and conditionally shows back button', () => {
    const { rerender } = render(
      <form>
        <CreateProjectFormActions
          setupStep="source"
          projectSource="new"
          createLoading={false}
          handleCancel={vi.fn()}
          handleBackToDetails={vi.fn()}
        />
      </form>
    );

    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();

    rerender(
      <form>
        <CreateProjectFormActions
          setupStep="compatibility"
          projectSource="local"
          createLoading={true}
          handleCancel={vi.fn()}
          handleBackToDetails={vi.fn()}
        />
      </form>
    );

    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importing Project...' })).toBeInTheDocument();
  });
});
