import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Dropdown, { DropdownItem, DropdownDivider, DropdownLabel } from '../components/Dropdown';

const renderDropdown = (props = {}, children) => {
  return render(
    <Dropdown title="Actions" {...props}>
      {children ?? (
        <>
          <DropdownItem onClick={() => {}}>Edit Project</DropdownItem>
          <DropdownDivider />
          <DropdownLabel>Danger zone</DropdownLabel>
          <DropdownItem>Delete Project</DropdownItem>
        </>
      )}
    </Dropdown>
  );
};

describe('Dropdown', () => {
  it('toggles the menu visibility when the trigger is clicked', () => {
    renderDropdown();

    const trigger = screen.getByRole('button', { name: /actions/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Edit Project')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Edit Project' })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Edit Project' })).toBeNull();
  });

  it('closes the menu when clicking outside the dropdown', () => {
    renderDropdown();

    const trigger = screen.getByRole('button', { name: /actions/i });
    fireEvent.click(trigger);
    expect(screen.getByText('Danger zone')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Danger zone')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the menu when focus moves into an iframe', () => {
    renderDropdown();

    const trigger = screen.getByRole('button', { name: /actions/i });
    fireEvent.click(trigger);
    expect(screen.getByText('Danger zone')).toBeInTheDocument();

    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);

    fireEvent.focusIn(iframe);

    expect(screen.queryByText('Danger zone')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    document.body.removeChild(iframe);
  });

  it('closes the menu when the global close event fires', () => {
    renderDropdown();

    const trigger = screen.getByRole('button', { name: /actions/i });
    fireEvent.click(trigger);
    expect(screen.getByText('Danger zone')).toBeInTheDocument();

    window.dispatchEvent(new Event('lucidcoder:close-dropdowns'));

    return waitFor(() => {
      expect(screen.queryByText('Danger zone')).toBeNull();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('does not open when disabled', () => {
    renderDropdown({ disabled: true });

    const trigger = screen.getByRole('button', { name: /actions/i });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByText('Edit Project')).toBeNull();
  });

  it('invokes item handlers and closes after selection', () => {
    const onSelect = vi.fn();
    renderDropdown({}, <DropdownItem onClick={onSelect}>Rename</DropdownItem>);

    const trigger = screen.getByRole('button', { name: /actions/i });
    fireEvent.click(trigger);

    const item = screen.getByRole('button', { name: 'Rename' });
    fireEvent.click(item);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('respects disabled dropdown items', () => {
    const onSelect = vi.fn();
    renderDropdown(
      {},
      <DropdownItem onClick={onSelect} disabled>
        Disabled Action
      </DropdownItem>
    );

    const trigger = screen.getByRole('button', { name: /actions/i });
    fireEvent.click(trigger);

    const item = screen.getByRole('button', { name: 'Disabled Action' });
    expect(item).toBeDisabled();
    fireEvent.click(item);

    expect(onSelect).not.toHaveBeenCalled();
    expect(item).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders labels and dividers with custom classes', () => {
    renderDropdown(
      {},
      <>
        <DropdownLabel className="section-label">Section Header</DropdownLabel>
        <DropdownDivider />
        <DropdownItem>Single Action</DropdownItem>
      </>
    );

    const trigger = screen.getByRole('button', { name: /actions/i });
    fireEvent.click(trigger);

    expect(screen.getByText('Section Header')).toHaveClass('dropdown-label', 'section-label');
    expect(document.querySelector('.dropdown-divider')).toBeInTheDocument();
  });
});
