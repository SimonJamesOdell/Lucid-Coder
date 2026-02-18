import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NavBar from '../components/NavBar.generated';

test('NavBar renders links with correct hrefs', () => {
  render(
    <MemoryRouter>
      <NavBar />
    </MemoryRouter>
  );

  const home = screen.getByText('Home').closest('a');
  const about = screen.getByText('About').closest('a');
  const contact = screen.getByText('Contact').closest('a');

  expect(home).toHaveAttribute('href', '/');
  expect(about).toHaveAttribute('href', '/about');
  expect(contact).toHaveAttribute('href', '/contact');
});
