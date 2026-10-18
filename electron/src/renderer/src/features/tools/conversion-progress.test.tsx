import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConversionProgress as Snapshot } from '@/lib/api/convert';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
import { ConversionProgress } from './conversion-progress';
afterEach(cleanup);
const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({
  job_id: 'job',
  state: 'running',
  stage: 'loading',
  elapsed_s: 5,
  step: null,
  total: null,
  chunk: null,
  percent: null,
  eta_s: null,
  eta_scope: null,
  ...patch,
});
it('shows elapsed time and stage without inventing a percentage or ETA', () => {
  render(<ConversionProgress snapshot={snapshot()} startedAt={Date.now() - 5000} />);
  expect(screen.getByText('synthesisState.loading')).toBeVisible();
  expect(screen.getByRole('timer')).toHaveTextContent('0:05');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByText('convertProgress.eta_unknown')).toBeVisible();
});
it('shows measured solver steps with an explicitly stage-scoped ETA', () => {
  render(
    <ConversionProgress
      snapshot={snapshot({
        stage: 'diffusion',
        step: 6,
        total: 30,
        chunk: 2,
        percent: 20,
        eta_s: 48,
        eta_scope: 'stage',
      })}
      startedAt={Date.now() - 5000}
    />,
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');
  expect(screen.getByText(/convertProgress.steps/)).toHaveTextContent('"step":6');
  expect(screen.getByText(/convertProgress.eta /)).toHaveTextContent('0:48');
  expect(screen.getByText('convertProgress.stage_scope')).toBeVisible();
});
it('clears stale percentages and estimates during waveform generation', () => {
  render(
    <ConversionProgress
      snapshot={snapshot({ stage: 'vocoder', step: 30, total: 30, percent: 100, eta_s: 0 })}
      startedAt={Date.now()}
    />,
  );
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByText('convertProgress.eta_unknown')).toBeVisible();
});
it('only describes cancellation as confirmed when the backend reports stopped', () => {
  const view = render(
    <ConversionProgress
      snapshot={snapshot({ state: 'cancelling', stage: 'cancelling' })}
      startedAt={Date.now()}
      cancelling
    />,
  );
  expect(screen.getByText('convertProgress.cancelling')).toBeVisible();
  expect(screen.queryByText('convertProgress.cancelled')).not.toBeInTheDocument();
  view.rerender(
    <ConversionProgress
      snapshot={snapshot({ state: 'cancelled', stage: 'cancelled', elapsed_s: 12 })}
      startedAt={Date.now()}
      cpuThreads={3}
    />,
  );
  expect(screen.getByText('convertProgress.cancelled')).toBeVisible();
  expect(screen.getByRole('timer')).toHaveTextContent('0:12');
  expect(screen.getByText(/convertProgress.cpu_limit/)).toHaveTextContent('3');
});

it('shows actual chunk numerator and denominator without changing stage percentage', () => {
  render(
    <ConversionProgress
      snapshot={snapshot({
        stage: 'diffusion',
        chunk: 5,
        chunk_total: 10,
        step: 18,
        total: 30,
        percent: 60,
      })}
      startedAt={Date.now()}
    />,
  );
  expect(screen.getByText(/convertProgress.steps/)).toHaveTextContent('"chunk":"5/10"');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
});
