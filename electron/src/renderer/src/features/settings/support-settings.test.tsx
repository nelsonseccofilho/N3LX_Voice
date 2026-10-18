import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/bridge', () => ({ getBridge: () => null }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
import { SupportSettings } from './support-settings';
afterEach(cleanup);
it('offers owned repository support without Pro, checkout, or paid sponsor funnels', () => {
  render(<SupportSettings />);
  expect(screen.queryByRole('button', { name: 'supportPlans.get_pro' })).not.toBeInTheDocument();
  expect(screen.queryByText('PayPal')).not.toBeInTheDocument();
  expect(screen.queryByText('Ko-fi')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'support.star_github' })).toHaveAttribute(
    'href',
    'https://github.com/nelsonseccofilho/N3LX_Voice',
  );
  expect(screen.getByRole('link', { name: 'contact.feature_cta' })).toHaveAttribute(
    'href',
    'https://github.com/nelsonseccofilho/N3LX_Voice/issues',
  );
});
