import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ open: vi.fn(async () => {}), native: false }));
vi.mock('@/components/bridge', () => ({
  getBridge: () => (mock.native ? { files: { openExternal: mock.open } } : null),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { GithubStar } from './github-star';
import { SupportShortcut } from './support-shortcut';
const mount = (element: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mock.native = false;
});
it('points stars at the owned repository without fetching or showing another project count', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  mount(<GithubStar />);
  expect(screen.getByRole('link', { name: 'support.star_github' })).toHaveAttribute(
    'href',
    'https://github.com/nelsonseccofilho/N3LX_Voice',
  );
  expect(screen.queryByText(/43,638|73,859/)).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
});
it('opens the owned repository externally without starring on behalf of the user', async () => {
  mock.native = true;
  mount(<GithubStar />);
  fireEvent.click(screen.getByRole('link', { name: 'support.star_github' }));
  await waitFor(() =>
    expect(mock.open).toHaveBeenCalledWith('https://github.com/nelsonseccofilho/N3LX_Voice'),
  );
});
it('has no Pro acquisition shortcut', () => {
  mount(<SupportShortcut />);
  expect(screen.queryByRole('link', { name: 'supportPlans.get_pro' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href="/pro"]')).toBeNull();
});
