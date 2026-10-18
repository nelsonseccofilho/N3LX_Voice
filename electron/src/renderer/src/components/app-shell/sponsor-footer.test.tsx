import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mock.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/bridge', () => ({ getBridge: () => null }));
import { SponsorFooter } from './sponsor-footer';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('keeps integrations and the owned repository without paid acquisition links', () => {
  render(<SponsorFooter />);
  fireEvent.click(screen.getByRole('button', { name: 'integrationCatalog.title' }));
  expect(mock.navigate).toHaveBeenCalledWith({ to: '/integrations' });
  expect(screen.getByRole('link', { name: 'support.star_github' })).toHaveAttribute(
    'href',
    'https://github.com/nelsonseccofilho/N3LX_Voice',
  );
  expect(
    screen.queryByRole('button', { name: 'sponsorSlot.footer_brand' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'donate.title' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href*="voicestudio.sh"]')).toBeNull();
});
it('collapses and restores the compact footer', () => {
  render(<SponsorFooter />);
  fireEvent.click(screen.getByRole('button', { name: 'homeUi.collapseFooter' }));
  expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'homeUi.expandFooter' }));
  expect(screen.getByRole('contentinfo')).toBeVisible();
});
