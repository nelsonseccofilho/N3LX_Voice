import { expect, it, vi } from 'vitest';
vi.mock('@/components/app-shell/app-shell', () => ({ AppShell: () => null }));
import { proRoute, supportRoute } from './index';
it('redirects a legacy Pro URL to project support without loading a purchase page', () => {
  const before = proRoute.options.beforeLoad as () => unknown;
  expect(typeof before).toBe('function');
  try {
    before();
    throw new Error('Expected redirect');
  } catch (result) {
    expect(result).toMatchObject({ options: { to: '/settings/support' } });
  }
  expect(supportRoute.options.beforeLoad).toBeUndefined();
});
