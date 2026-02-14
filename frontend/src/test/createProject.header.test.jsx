import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import CreateProjectHeader from '../components/create-project/CreateProjectHeader';

describe('create-project header', () => {
  test('renders title and handles close click', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    render(<CreateProjectHeader isProgressBlocking={false} onCancel={onCancel} />);

    expect(screen.getByText('Add Project')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close add project' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
