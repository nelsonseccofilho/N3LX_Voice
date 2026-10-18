import { clearConversion, setConversion } from './conversion-state';
import { cleanup, fireEvent, render, screen, act, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  planEnabled: false,
  chooseDestination: vi.fn(),
  saveConversion: vi.fn(),
  queryError: false,
  retry: vi.fn(),
  convert: vi.fn(),
  cancel: vi.fn(),
  saveExport: vi.fn(),
  reveal: vi.fn().mockResolvedValue(undefined),
  toastError: vi.fn(),
  ready: true,
  singingReady: false,
  profileMode: 'many' as 'many' | 'one' | 'none',
  modelCount: 2,
  pinned: false,
  cloning: true as boolean | null,
}));
vi.mock('@/components/bridge', () => ({
  getBridge: () => ({
    files: {
      revealPath: mock.reveal,
      ...(mock.planEnabled
        ? {
            chooseConversionDestination: mock.chooseDestination,
            saveConversion: mock.saveConversion,
          }
        : {}),
    },
  }),
}));
vi.mock('@/lib/export-history', () => ({
  recordExport: vi.fn(async () => {}),
  saveExport: (...args: unknown[]) => mock.saveExport(...args),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mock.toastError(...args) },
}));
vi.mock('@/hooks/use-engines', () => ({
  useEngines: () => ({
    isError: mock.queryError,
    error: new Error('Engine query failed'),
    retry: mock.retry,
    data: mock.queryError
      ? undefined
      : {
          tts: {
            env_override: mock.pinned,
            backends: Array.from({ length: mock.modelCount }, (_, i) => ({
              id: `engine${i}`,
              available: true,
              supports_cloning: true,
            })),
          },
        },
    activeTtsReady: mock.ready,
    activeTts: { supports_cloning: mock.cloning, display_name: 'VoxCPM2' },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/lib/api/convert', () => ({
  convertSpeech: mock.convert,
  getConversionProgress: async () => null,
  cancelConversion: (id: string) => mock.cancel(id),
  getConversionModels: async () => ({
    speech: { compute_options: mock.planEnabled ? ['cpu', 'gpu'] : ['auto'] },
    singing: {
      compute_options: mock.planEnabled ? ['cpu', 'gpu'] : undefined,
      id: 'seed-vc-svc',
      display_name: 'Seed-VC SVC (44.1 kHz, CPU)',
      available: mock.singingReady,
      device: 'cpu',
      sample_rate: 44100,
    },
  }),
}));
vi.mock('@/hooks/use-recording', () => ({
  useRecording: () => ({ isRecording: false, isStarting: false, isCleaning: false }),
}));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({
    data:
      mock.profileMode === 'none'
        ? []
        : [
            { id: 'a', name: 'Alpha', kind: 'clone', ref_audio_path: 'a.wav' },
            { id: 'design', name: 'Captain Crusty', kind: 'design', ref_audio_path: 'design.wav' },
            { id: 'legacy-design', name: 'Legacy Design', kind: 'design', ref_audio_path: null },
            {
              id: 'locked',
              name: 'Locked Clone',
              kind: 'clone',
              ref_audio_path: null,
              is_locked: true,
              locked_audio_path: 'locked.wav',
            },
            { id: 'empty', name: 'Empty Clone', kind: 'clone', ref_audio_path: null },
          ].filter((_, index) => mock.profileMode !== 'one' || index === 0),
  }),
}));
vi.mock('@shared/api/hooks', () => ({ useArchetypes: () => ({ data: undefined }) }));
vi.mock('@shared/api/archetypes', () => ({ useArchetypeAsProfile: vi.fn() }));
vi.mock('@shared/store', () => ({
  useAppStore: (selector: (state: { favoriteArchetypeIds: string[] }) => unknown) =>
    selector({ favoriteArchetypeIds: [] }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { path?: string }) =>
      options?.path ? `${key} ${options.path}` : key,
  }),
}));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: ({ src, source }: { src: string; source: string }) => (
    <div data-testid={source}>{src}</div>
  ),
}));
import { ConvertVoice } from './convert-voice';
mock.cancel.mockResolvedValue({ state: 'cancelled', stage: 'cancelled', elapsed_s: 1 });
afterEach(() => {
  cleanup();
  clearConversion();
  mock.cancel.mockResolvedValue({ state: 'cancelled', stage: 'cancelled', elapsed_s: 1 });
  mock.planEnabled = false;
  mock.queryError = false;
  mock.ready = true;
  mock.singingReady = false;
  mock.profileMode = 'many';
  mock.modelCount = 2;
  mock.pinned = false;
  mock.cloning = true;
  vi.clearAllMocks();
});
function chooseVoice(name: string) {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole('button', { name: 'convert.pick_voice' }));
  fireEvent.mouseDown(screen.getByRole('option', { name }));
}
function mount() {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ConvertVoice />
    </QueryClientProvider>,
  );
  const upload = (name = 'source.wav') =>
    fireEvent.change(screen.getByLabelText('convert.source_kicker', { selector: 'input' }), {
      target: { files: [new File(['source audio'], name, { type: 'audio/wav' })] },
    });
  return { ...view, upload };
}
it('requires source and target, posts independent inputs and plays returned audio', async () => {
  mock.convert.mockResolvedValue({ id: 'x', audio_url: '/audio/x.wav', text: 'Recognized source' });
  const { upload } = mount();
  const button = screen.getByRole('button', { name: 'convert.convert' });
  expect(button).toBeDisabled();
  upload();
  expect(button).toBeDisabled();
  chooseVoice('Alpha');
  fireEvent.click(button);
  expect(await screen.findByTestId('convert-result')).toHaveTextContent('/api/audio/x.wav');
  expect(mock.convert).toHaveBeenCalledWith(
    expect.any(File),
    'a',
    true,
    expect.any(AbortSignal),
    'speech',
    expect.any(String),
    'auto',
  );
  expect(screen.getByText('Recognized source')).toBeInTheDocument();
});
it('cancels obsolete conversion and ignores a late response after source changes', async () => {
  let finish!: (value: unknown) => void;
  mock.convert.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { upload } = mount();
  upload();
  chooseVoice('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  const signal = mock.convert.mock.calls[0][3];
  upload('replacement.wav');
  await waitFor(() => expect(signal.aborted).toBe(true));
  await act(async () => finish({ audio_url: '/audio/stale.wav', text: 'obsolete' }));
  expect(screen.queryByTestId('convert-result')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeEnabled();
});

it('retains source and target when returning from model settings', () => {
  const first = mount();
  first.upload();
  chooseVoice('Alpha');
  first.unmount();
  mount();
  expect(screen.getByText('convert.target_selected')).toBeVisible();
  expect(screen.getByRole('button', { name: 'convert.pick_voice' })).toHaveTextContent('Alpha');
  expect(screen.getByRole('button', { name: 'source.wav' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeEnabled();
});

it.each([false, null])(
  'blocks conversion for unsupported or unknown cloning capability (%s)',
  (capability) => {
    mock.cloning = capability;
    const { upload } = mount();
    upload();
    chooseVoice('Alpha');
    const button = screen.getByRole('button', { name: 'convert.convert' });
    expect(button).toBeDisabled();
    expect(screen.getByText('convert.cloning_required')).toBeInTheDocument();
    fireEvent.click(button);
    expect(mock.convert).not.toHaveBeenCalled();
  },
);
it('rechecks engine capability when returning from settings without losing inputs', () => {
  const first = mount();
  first.upload();
  chooseVoice('Alpha');
  first.unmount();
  mock.cloning = false;
  const second = mount();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  second.unmount();
  mock.cloning = true;
  mock.ready = false;
  const third = mount();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  third.unmount();
  mock.ready = true;
  mount();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'source.wav' })).toBeInTheDocument();
});

it('offers retry instead of model guidance when engine lookup fails', () => {
  mock.queryError = true;
  mock.ready = false;
  const { upload } = mount();
  upload();
  chooseVoice('Alpha');
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  expect(screen.queryByText('convert.cloning_required')).not.toBeInTheDocument();
  expect(screen.getByText('Engine query failed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  expect(mock.retry).toHaveBeenCalledOnce();
});

it.each([
  ['Captain Crusty', 'design'],
  ['Legacy Design', 'legacy-design'],
  ['Locked Clone', 'locked'],
])('searches and converts the saved profile %s', async (name, id) => {
  mock.convert.mockResolvedValue({ id: 'x', audio_url: '/audio/x.wav', text: 'Dialogue' });
  const { upload } = mount();
  upload();
  expect(screen.queryByRole('button', { name: 'Empty Clone' })).not.toBeInTheDocument();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole('button', { name: 'convert.pick_voice' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'common.search' }), {
    target: { value: name.toLowerCase() },
  });
  expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole('option', { name }));
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  expect(await screen.findByTestId('convert-result')).toBeInTheDocument();
  expect(mock.convert).toHaveBeenCalledWith(
    expect.any(File),
    id,
    true,
    expect.any(AbortSignal),
    'speech',
    expect.any(String),
    'auto',
  );
});

it('separates singing from speech without submitting it to the speech engine', () => {
  const { upload } = mount();
  upload('song.wav');
  chooseVoice('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'convert.singing' }));
  expect(screen.getByText('convert.singing_unavailable')).toBeVisible();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  expect(screen.getByText('convert.match_duration')).toBeVisible();
  expect(screen.queryByText('convert.cloning_required')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'convert.pick_voice' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'song.wav' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  expect(mock.convert).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'convert.speech' }));
  expect(screen.getByText('convert.target_selected')).toBeVisible();
  expect(screen.getByRole('button', { name: 'convert.pick_voice' })).toHaveTextContent('Alpha');
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeEnabled();
});

it('discards late speech results after switching to singing and retains the choice on return', async () => {
  let finish!: (value: unknown) => void;
  mock.convert.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = mount();
  view.upload();
  chooseVoice('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  const signal = mock.convert.mock.calls[0][3];
  fireEvent.click(screen.getByRole('button', { name: 'convert.singing' }));
  await waitFor(() => expect(signal.aborted).toBe(true));
  await act(async () => finish({ audio_url: '/audio/stale.wav', text: 'obsolete' }));
  expect(screen.queryByTestId('convert-result')).not.toBeInTheDocument();
  view.unmount();
  mount();
  expect(screen.getByRole('button', { name: 'convert.singing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('button', { name: 'source.wav' })).toBeVisible();
});

it('marks models required but does not offer a nonexistent singing option', () => {
  mount();
  expect(
    within(screen.getByRole('region', { name: 'convert.audio_type' })).getByText(
      'convert.model_required',
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'convert.singing' }));
  expect(screen.getByText('convert.singing_model')).toBeVisible();
  expect(screen.getByText('convert.no_singing_model')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'convert.singing_model · convert.model_required' }),
  ).not.toBeInTheDocument();
});

it.each(['speech', 'singing'] as const)(
  'requires a target voice and explains an empty selection in %s',
  (mode) => {
    setConversion('mode', mode);
    mount();
    const target = screen.getByRole('region', { name: 'convert.target_voice' });
    expect(within(target).getByText('convert.model_required')).toBeVisible();
    expect(within(target).getByText('convert.target_required')).toBeVisible();
    expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  },
);

it.each(['speech', 'singing'] as const)('explicitly names the chosen target in %s', (mode) => {
  setConversion('mode', mode);
  setConversion('voice', 'a');
  mount();
  const target = screen.getByRole('region', { name: 'convert.target_voice' });
  expect(within(target).getByText('convert.target_selected')).toBeVisible();
  expect(within(target).queryByText('convert.target_required')).not.toBeInTheDocument();
});

it('does not imply a singing model can be selected when none is integrated', () => {
  setConversion('mode', 'singing');
  mount();
  expect(
    screen.queryByRole('button', { name: 'convert.singing_model · convert.model_required' }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('convert.no_singing_model')).toBeVisible();
});

it.each([false, true])(
  'does not offer model changes for a sole or pinned engine (pin=%s)',
  (pinned) => {
    mock.modelCount = pinned ? 2 : 1;
    mock.pinned = pinned;
    mount();
    expect(screen.getByText('VoxCPM2')).toBeVisible();
    expect(screen.queryByText('convert.change_model')).not.toBeInTheDocument();
  },
);

it('uses a confirmation button for a single unselected voice and then only shows its selected summary', () => {
  mock.profileMode = 'one';
  const view = mount();
  view.upload();
  expect(screen.getByText('convert.target_required')).toBeVisible();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
  expect(screen.getByText('convert.target_selected')).toBeVisible();
  expect(screen.getByText('Alpha')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'convert.pick_voice' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeEnabled();
});

it('blocks a deleted or absent target and does not claim a stale voice is selected', () => {
  setConversion('voice', 'deleted');
  const view = mount();
  view.upload();
  expect(screen.getByText('convert.target_required')).toBeVisible();
  expect(screen.queryByText('convert.target_selected')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
});

it.each(['speech', 'singing'] as const)(
  'explains when no target voices are saved in %s',
  (mode) => {
    mock.profileMode = 'none';
    setConversion('mode', mode);
    mount();
    expect(screen.getByText('clone.no_profiles')).toBeVisible();
    expect(screen.getByText('convert.target_required')).toBeVisible();
    expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  },
);

it('uses identical controls and the real singing model without requiring a speech engine', async () => {
  mock.singingReady = true;
  mock.modelCount = 1;
  mock.convert.mockResolvedValue({ id: 'song', audio_url: '/audio/song.wav', text: '' });
  const { upload } = mount();
  upload('singing.wav');
  chooseVoice('Alpha');
  const speechControls = screen.getAllByRole('switch').length;
  fireEvent.click(screen.getByRole('button', { name: 'convert.singing' }));
  mock.ready = false;
  await waitFor(() => expect(screen.getByText('Seed-VC SVC (44.1 kHz, CPU)')).toBeVisible());
  expect(screen.getAllByRole('switch')).toHaveLength(speechControls);
  expect(screen.getByText('convert.need_source_and_voice')).toBeVisible();
  expect(screen.getByText('convert.match_duration')).toBeVisible();
  expect(screen.getByRole('button', { name: 'clone.clear' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'convert.pick_voice' })).toHaveTextContent('Alpha');
  expect(screen.queryByText('convert.singing_unavailable')).not.toBeInTheDocument();
  expect(screen.queryByText('convert.change_model')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  expect(await screen.findByTestId('convert-result')).toHaveTextContent('/api/audio/song.wav');
  expect(mock.convert).toHaveBeenCalledWith(
    expect.any(File),
    'a',
    true,
    expect.any(AbortSignal),
    'singing',
    expect.any(String),
    'auto',
  );
  expect(screen.queryByText('convert.transcript')).not.toBeInTheDocument();
});

it('keeps the same voice list but blocks singing profiles without reference audio', async () => {
  mock.singingReady = true;
  const { upload } = mount();
  upload('singing.wav');
  chooseVoice('Legacy Design');
  fireEvent.click(screen.getByRole('button', { name: 'convert.singing' }));
  await screen.findByText('Seed-VC SVC (44.1 kHz, CPU)');
  expect(screen.getByText('convert.singing_reference_required')).toBeVisible();
  expect(screen.getByRole('button', { name: 'convert.convert' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'convert.pick_voice' })).toHaveTextContent(
    'Legacy Design',
  );
});

it('waits for a cancellation receipt before clearing the operation', async () => {
  let finish!: (value: unknown) => void;
  let confirm!: (value: unknown) => void;
  mock.convert.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mock.cancel.mockImplementation(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const view = mount();
  view.upload();
  chooseVoice('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  const signal = mock.convert.mock.calls[0][3];
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
  expect(signal.aborted).toBe(false);
  expect(screen.getByRole('button', { name: 'convertProgress.cancelling' })).toBeDisabled();
  expect(screen.queryByText('convertProgress.cancelled')).not.toBeInTheDocument();
  await act(async () => confirm({ state: 'cancelled', stage: 'cancelled', elapsed_s: 2 }));
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(screen.getByText('convertProgress.cancelled')).toBeVisible();
  await act(async () => finish({ audio_url: '/audio/late.wav', text: 'obsolete' }));
  expect(screen.queryByTestId('convert-result')).not.toBeInTheDocument();
});

it.each(['speech', 'singing'] as const)(
  'shows the saved file and exports %s results with the native chooser',
  async (mode) => {
    const internal = 'D:\\git\\VoiceStudio\\.local-data\\outputs\\converted.wav';
    const exported = 'D:\\Audio\\my-conversion.wav';
    setConversion('mode', mode);
    mock.singingReady = true;
    mock.convert.mockResolvedValue({
      id: 'converted',
      audio_url: '/audio/converted.wav',
      output_path: internal,
      text: '',
    });
    mock.saveExport.mockResolvedValue({ canceled: false, path: exported });
    const view = mount();
    view.upload('song.wav');
    chooseVoice('Alpha');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'convert.convert' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
    expect(await screen.findByText(internal)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'clone.reveal' }));
    expect(mock.reveal).toHaveBeenCalledWith(internal);
    fireEvent.click(screen.getByRole('button', { name: 'clone.download' }));
    await waitFor(() =>
      expect(mock.saveExport).toHaveBeenCalledWith('/api/audio/converted.wav', 'song_convert.wav'),
    );
    expect(await screen.findByText(`clone.saved_to ${exported}`)).toBeVisible();
    view.unmount();
    mount();
    expect(screen.getByText(`clone.saved_to ${exported}`)).toBeVisible();
    fireEvent.click(screen.getAllByRole('button', { name: 'clone.reveal' })[1]);
    expect(mock.reveal).toHaveBeenLastCalledWith(exported);
  },
);

it('keeps the internal result when export is cancelled or fails', async () => {
  const internal = 'D:\\outputs\\converted.wav';
  setConversion('result', {
    id: 'converted',
    audio_url: '/audio/converted.wav',
    output_path: internal,
    text: '',
    duration_s: 1,
    gen_time_s: 1,
  });
  mock.saveExport.mockResolvedValue({ canceled: true });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'clone.download' }));
  await waitFor(() => expect(mock.saveExport).toHaveBeenCalledOnce());
  expect(screen.getByText(internal)).toBeVisible();
  expect(screen.queryByText(/^clone.saved_to/)).not.toBeInTheDocument();
  mock.saveExport.mockRejectedValue(new Error('Disk full'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'clone.download' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'clone.download' }));
  await waitFor(() => expect(mock.toastError).toHaveBeenCalled());
  expect(screen.queryByText(/^clone.saved_to/)).not.toBeInTheDocument();
  expect(screen.getByText(internal)).toBeVisible();
});

it('does not restore an obsolete result when a pending export finishes', async () => {
  let finish!: (result: unknown) => void;
  setConversion('result', {
    id: 'old',
    audio_url: '/audio/old.wav',
    text: '',
    duration_s: 1,
    gen_time_s: 1,
  });
  mock.saveExport.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'clone.download' }));
  fireEvent.click(screen.getByRole('button', { name: 'convert.singing' }));
  await act(async () => finish({ canceled: false, path: 'D:\\exports\\old.wav' }));
  expect(screen.queryByTestId('convert-result')).not.toBeInTheDocument();
});

it('does not start conversion when the destination dialog is cancelled', async () => {
  mock.planEnabled = true;
  mock.chooseDestination.mockResolvedValue(null);
  const view = mount();
  view.upload();
  chooseVoice('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  await waitFor(() => expect(mock.chooseDestination).toHaveBeenCalled());
  expect(mock.convert).not.toHaveBeenCalled();
});
it.each(['speech', 'singing'] as const)(
  'uses the chosen destination and CPU selection for %s',
  async (mode) => {
    mock.planEnabled = true;
    mock.singingReady = true;
    setConversion('mode', mode);
    mock.chooseDestination.mockResolvedValue({
      token: 'chosen',
      path: 'D:\\voices\\source_convert.wav',
    });
    mock.saveConversion.mockResolvedValue({
      canceled: false,
      path: 'D:\\voices\\source_convert.wav',
    });
    mock.convert.mockResolvedValue({ id: 'cpu-test', audio_url: '/audio/cpu-test.wav', text: '' });
    const view = mount();
    view.upload();
    chooseVoice('Alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'CPU' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'CPU' }));
    fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
    await waitFor(() =>
      expect(mock.convert).toHaveBeenCalledWith(
        expect.any(File),
        'a',
        true,
        expect.any(AbortSignal),
        mode,
        expect.any(String),
        'cpu',
      ),
    );
    await waitFor(() =>
      expect(mock.saveConversion).toHaveBeenCalledWith({
        token: 'chosen',
        url: '/api/audio/cpu-test.wav',
      }),
    );
    expect(await screen.findByText('clone.saved_to D:\\voices\\source_convert.wav')).toBeVisible();
  },
);

it('keeps playable internal audio when the automatic export fails', async () => {
  mock.planEnabled = true;
  mock.chooseDestination.mockResolvedValue({ token: 'chosen', path: 'D:\\output.wav' });
  mock.saveConversion.mockRejectedValue(new Error('Disk full'));
  mock.convert.mockResolvedValue({
    id: 'keep',
    audio_url: '/audio/keep.wav',
    output_path: 'D:\\internal.wav',
    text: '',
  });
  const view = mount();
  view.upload();
  chooseVoice('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));
  expect(await screen.findByTestId('convert-result')).toBeVisible();
  expect(await screen.findByText('clone.download_failed')).toBeVisible();
  expect(screen.getByText('D:\\internal.wav')).toBeVisible();
});
