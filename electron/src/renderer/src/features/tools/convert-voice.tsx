import { useConversion, setConversion, recordConversionExport } from './conversion-state';
import { Link } from '@tanstack/react-router';
// @ts-expect-error Shared JSX component has no declaration file.
import VoiceSelector from '@shared/components/VoiceSelector';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRightIcon, CheckCircle2Icon, MicIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PipelineFailure } from '@/components/pipeline-failure';
import { AgentFixButton } from '@/components/agent-fix-button';
import { ProfileAvatar } from '@/components/profile-avatar';
import { WaveformPlayer } from '@/components/waveform-player';
import { useEngines } from '@/hooks/use-engines';
import { useProfiles } from '@/hooks/use-profiles';
import { useRecording } from '@/hooks/use-recording';
import { apiPath, ApiError, describeError } from '@/lib/api/client';
import {
  convertSpeech,
  getConversionModels,
  getConversionProgress,
  cancelConversion,
  type ConvertResult,
} from '@/lib/api/convert';
import { recordExport } from '@/lib/export-history';
import { getBridge } from '@/components/bridge';
import { nativeSaveError } from '@/lib/native-save';
import { queryKeys } from '@/lib/query';
import { ConversionProgress } from './conversion-progress';
import { ConversionResult } from './conversion-result';
import { beginAppActivity } from '@/lib/app-activity';

export function ConvertVoice() {
  const { t } = useTranslation();
  const profiles = useProfiles();
  const engines = useEngines();
  const canClone = engines.activeTtsReady && engines.activeTts?.supports_cloning === true;
  const speechChoices = (engines.data?.tts?.backends ?? []).filter(
    (backend) =>
      backend.available &&
      backend.supports_cloning === true &&
      backend.routing_status !== 'unavailable',
  );
  const canChooseSpeechModel =
    !engines.data?.tts?.env_override && (speechChoices.length > 1 || !canClone);
  const client = useQueryClient();
  const { mode, file, voice, match, result, compute, destination } = useConversion();
  const isSpeech = mode === 'speech';
  const models = useQuery({
    queryKey: ['conversion-models'],
    queryFn: getConversionModels,
    refetchOnWindowFocus: true,
  });
  const singingModel = models.data?.singing;
  const bridge = getBridge();
  const choices: readonly ('auto' | 'cpu' | 'gpu')[] = isSpeech
    ? (models.data?.speech?.compute_options ?? ['auto'])
    : (singingModel?.compute_options ?? ['auto']);
  const effectiveCompute = choices.includes(compute)
    ? compute
    : choices.includes('gpu')
      ? 'gpu'
      : choices.includes('cpu')
        ? 'cpu'
        : 'auto';
  const [choosingDestination, setChoosingDestination] = useState(false);
  const [exporting, setExporting] = useState(false);
  const sourceVersion = useRef(0);
  const chooseDestination = async () => {
    if (!file || !bridge?.files.chooseConversionDestination) return null;
    const version = sourceVersion.current;
    setChoosingDestination(true);
    try {
      const plan = await bridge.files.chooseConversionDestination(file);
      if (version !== sourceVersion.current) return null;
      if (plan) setConversion('destination', plan);
      return plan;
    } catch (error) {
      setError(describeError(await nativeSaveError(error)));
      return null;
    } finally {
      setChoosingDestination(false);
    }
  };

  const setFile = (value: File | null) => setConversion('file', value);
  const setVoice = (value: string) => setConversion('voice', value);
  const setMatch = (value: boolean) => setConversion('match', value);
  const setResult = (value: ConvertResult | null) => setConversion('result', value);
  const [sourceUrl, setSourceUrl] = useState('');
  const [error, setError] = useState('');
  const [needsModel, setNeedsModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const [jobId, setJobId] = useState('');
  const activeJob = useRef('');
  const [startedAt, setStartedAt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false);
  const job = useQuery({
    queryKey: ['conversion-progress', jobId],
    queryFn: () => getConversionProgress(jobId),
    enabled: Boolean(jobId),
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data && ['completed', 'cancelled', 'failed'].includes(query.state.data.state)
        ? false
        : 1000,
    retry: 1,
  });
  const acceptCancellation = (id: string) => {
    if (activeJob.current !== id) return;
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setCancelling(false);
  };
  useEffect(() => {
    if (job.data?.state === 'cancelled') acceptCancellation(jobId);
    else if (job.data && ['completed', 'failed'].includes(job.data.state)) {
      setCancelling(false);
      setBusy(false);
    }
  }, [job.data, jobId]);
  const cancel = async () => {
    const id = activeJob.current;
    if (!id) return;
    cancelRequested.current = true;
    setCancelling(true);
    try {
      const receipt = await cancelConversion(id);
      await client.cancelQueries({ queryKey: ['conversion-progress', id] });
      client.setQueryData(['conversion-progress', id], receipt);
      if (receipt.state === 'cancelled') acceptCancellation(id);
      else if (receipt.state === 'completed' || receipt.state === 'failed') setCancelling(false);
    } catch {
      // Keep the job blocked: lack of an acknowledgement is not cancellation.
      setError(t('convertProgress.cancel_unknown'));
      setCancelling(false);
    }
  };
  const input = useRef<HTMLInputElement>(null);
  const invalidate = () => {
    if (request.current || cancelling) void cancel();
    else {
      setJobId('');
      activeJob.current = '';
    }
    setResult(null);
    setError('');
    setNeedsModel(false);
  };
  const ingest = (next: File) => {
    if (
      !next.size ||
      !(next.type.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|webm)$/i.test(next.name))
    ) {
      setError(t('clone.unsupported_audio'));
      return;
    }
    invalidate();
    sourceVersion.current += 1;
    setConversion('destination', null);
    setFile(next);
  };
  const recording = useRecording(ingest, false);
  const recordingBusy = recording.isStarting || recording.isRecording || recording.isCleaning;
  useEffect(() => {
    const url = file ? URL.createObjectURL(file) : '';
    setSourceUrl(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  useEffect(
    () => () => {
      request.current?.abort();
      if (activeJob.current) void cancelConversion(activeJob.current).catch(() => {});
    },
    [],
  );
  // Match the backend's profile conditioning: designs use their saved sample
  // or instructions; clones need a reference (a locked take takes precedence).
  const voices = (profiles.data ?? []).filter(
    (p) => p.kind === 'design' || p.ref_audio_path || (p.is_locked && p.locked_audio_path),
  );
  const selectedVoice = voices.find((profile) => profile.id === voice);
  const hasReference = Boolean(
    selectedVoice?.ref_audio_path || (selectedVoice?.is_locked && selectedVoice?.locked_audio_path),
  );
  const canConvert = isSpeech
    ? canClone
    : (singingModel?.available === true ||
        singingModel?.compute_options?.includes(effectiveCompute as 'cpu' | 'gpu')) &&
      hasReference;
  const valid = canConvert && file && selectedVoice && !recordingBusy;
  const run = async () => {
    if (!valid || request.current || choosingDestination || exporting) return;
    const plan = bridge?.files.chooseConversionDestination
      ? destination?.token
        ? destination
        : await chooseDestination()
      : null;
    if (bridge?.files.chooseConversionDestination && !plan) return;
    const version = sourceVersion.current;
    const controller = new AbortController();
    request.current = controller;
    const id = crypto.randomUUID();
    activeJob.current = id;
    setJobId(id);
    setStartedAt(Date.now());
    cancelRequested.current = false;
    setCancelling(false);
    const finishTranscription = isSpeech ? beginAppActivity('transcription') : () => {};
    const finishSynthesis = beginAppActivity('synthesis');
    setBusy(true);
    setError('');
    setNeedsModel(false);
    setResult(null);
    try {
      const converted = await convertSpeech(
        file,
        selectedVoice.id,
        match,
        controller.signal,
        mode,
        id,
        effectiveCompute,
      );
      if (!controller.signal.aborted && !cancelRequested.current) {
        setResult(converted);
        if (plan && bridge) {
          setExporting(true);
          setConversion('destination', { ...plan, token: '' });
          try {
            const saved = await bridge.files.saveConversion({
              token: plan.token,
              url: apiPath(converted.audio_url),
            });
            if (saved.path)
              await recordExport(saved.path, file.name.replace(/\.[^.]+$/, '') + '_convert.wav');
            if (saved.path && version === sourceVersion.current)
              recordConversionExport(converted.id, saved.path);
          } catch (error) {
            if (version === sourceVersion.current)
              setError(
                t('clone.download_failed', { message: (await nativeSaveError(error)).message }),
              );
          } finally {
            setExporting(false);
          }
        }
        void client.invalidateQueries({ queryKey: queryKeys.history });
      }
    } catch (e) {
      if (!controller.signal.aborted && !cancelRequested.current) {
        const detail = e instanceof ApiError ? e.payload?.detail : null;
        setNeedsModel(
          Boolean(
            detail &&
            typeof detail === 'object' &&
            'error' in detail &&
            detail.error === 'asr_model_missing',
          ),
        );
        setError(
          detail &&
            typeof detail === 'object' &&
            'error' in detail &&
            detail.error === 'singing_progress_timeout'
            ? t('convertProgress.stalled')
            : describeError(e),
        );
      }
    } finally {
      finishTranscription();
      finishSynthesis();
      if (request.current === controller) {
        request.current = null;
        if (!cancelRequested.current) setBusy(false);
      }
    }
  };
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('convert.convert')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('convert.need_source_and_voice')}</p>
      </div>
      <section className="space-y-3" aria-label={t('convert.audio_type')}>
        <div
          role="group"
          aria-label={t('convert.audio_type')}
          className="flex w-fit gap-1 rounded-lg border p-1"
        >
          {(['speech', 'singing'] as const).map((value) => (
            <Button
              key={value}
              variant={mode === value ? 'secondary' : 'ghost'}
              aria-pressed={mode === value}
              disabled={recordingBusy}
              onClick={() => {
                if (mode !== value) {
                  invalidate();
                  setConversion('mode', value);
                }
              }}
            >
              {t(value === 'speech' ? 'convert.speech' : 'convert.singing')}
            </Button>
          ))}
        </div>
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {t(isSpeech ? 'convert.speech_model' : 'convert.singing_model')}
              </span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {t('convert.model_required')}
              </span>
            </div>
            {isSpeech && canChooseSpeechModel && (
              <Link
                to="/settings/models/$family"
                params={{ family: 'tts' }}
                className="font-medium text-primary hover:underline"
              >
                {t(canClone ? 'convert.change_model' : 'convert.select_model')}
              </Link>
            )}
          </div>
          {isSpeech ? (
            <p className="font-semibold break-words">
              {engines.activeTts?.display_name ?? t('convert.select_model')}
            </p>
          ) : (
            <p className="font-semibold break-words">
              {effectiveCompute === 'cpu' && singingModel?.available
                ? 'Seed-VC SVC (44.1 kHz, CPU)'
                : singingModel?.available
                  ? singingModel.display_name
                  : t('convert.no_singing_model')}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t('convert.model_required_hint')}</p>
          {!isSpeech && !singingModel?.available && (
            <p role="status" className="text-sm">
              {t('convert.singing_unavailable')}
            </p>
          )}
        </div>
      </section>
      <section className="space-y-2" aria-label={t('convertOptions.compute')}>
        <h3 className="text-sm font-medium">{t('convertOptions.compute')}</h3>
        <div
          role="group"
          aria-label={t('convertOptions.compute')}
          className="flex w-fit gap-1 rounded-lg border p-1"
        >
          {(['gpu', 'cpu'] as const).map((choice) => (
            <Button
              key={choice}
              variant={effectiveCompute === choice ? 'secondary' : 'ghost'}
              aria-pressed={effectiveCompute === choice}
              disabled={busy || exporting || !choices.includes(choice)}
              onClick={() => {
                invalidate();
                setConversion('compute', choice);
              }}
            >
              {choice.toUpperCase()}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            effectiveCompute === 'auto'
              ? 'convertOptions.unavailable'
              : effectiveCompute === 'cpu'
                ? 'convertOptions.cpu_hint'
                : 'convertOptions.compute_hint',
          )}
        </p>
      </section>
      <section className="space-y-3" aria-label={t('convert.source_kicker')}>
        <h3 className="text-sm font-medium">{t('convert.source_kicker')}</h3>
        <input
          ref={input}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac,.webm"
          className="sr-only"
          aria-label={t('convert.source_kicker')}
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (chosen) ingest(chosen);
            e.target.value = '';
          }}
          disabled={recordingBusy}
        />
        <Button
          variant="outline"
          className="h-auto min-h-20 w-full whitespace-normal border-dashed p-4"
          disabled={recordingBusy}
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!recordingBusy && e.dataTransfer.files[0]) ingest(e.dataTransfer.files[0]);
          }}
        >
          {file?.name ?? t('convert.drop_audio')}
        </Button>
        {sourceUrl && <WaveformPlayer src={sourceUrl} source="convert-source" height={36} />}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={recording.isStarting || recording.isCleaning}
            onClick={() => {
              if (recording.isRecording) recording.stop();
              else {
                invalidate();
                void recording.start();
              }
            }}
          >
            {recording.isRecording ? <SquareIcon /> : <MicIcon />}
            {recording.isRecording ? t('clone.stop_recording') : t('clone.record')}
          </Button>
          {file && (
            <Button
              variant="ghost"
              onClick={() => {
                invalidate();
                sourceVersion.current += 1;
                setConversion('destination', null);
                setFile(null);
              }}
            >
              {t('clone.clear')}
            </Button>
          )}
        </div>
      </section>
      <section className="space-y-3" aria-label={t('convert.target_voice')}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{t('convert.target_voice')}</h3>
          <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('convert.model_required')}
          </span>
        </div>
        {selectedVoice ? (
          <div
            role="status"
            className="flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
          >
            <ProfileAvatar
              name={selectedVoice.name}
              imageUrl={selectedVoice.image_url}
              className="size-8"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">{t('convert.target_selected')}</p>
              <p className="text-sm font-semibold break-words">{selectedVoice.name}</p>
            </div>
            <CheckCircle2Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          </div>
        ) : (
          <p
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
          >
            {t('convert.target_required')}
          </p>
        )}
        {voices.length > 1 && (
          <VoiceSelector
            value={selectedVoice?.id ?? ''}
            onChange={(id: string) => {
              invalidate();
              setVoice(id);
            }}
            profiles={voices}
            engineDefault={false}
            gallery={false}
            menuPortal
            ariaLabel={t('convert.pick_voice')}
            placeholder={t('convert.pick_voice')}
            buttonClassName="rounded-md border border-input bg-input/20 p-2 text-sm"
          />
        )}
        {voices.length === 1 && !selectedVoice && (
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              invalidate();
              setVoice(voices[0].id);
            }}
          >
            <ProfileAvatar
              name={voices[0].name}
              imageUrl={voices[0].image_url}
              className="size-6"
            />
            {voices[0].name}
          </Button>
        )}
        {!voices.length && (
          <p className="text-sm text-muted-foreground">{t('clone.no_profiles')}</p>
        )}
      </section>
      <div className="space-y-1">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={match}
            onCheckedChange={(value) => {
              invalidate();
              setMatch(value);
            }}
          />
          {t('convert.match_duration')}
        </label>
        <p className="text-xs text-muted-foreground">{t('convert.match_duration_hint')}</p>
      </div>
      {!isSpeech && selectedVoice && !hasReference && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t('convert.singing_reference_required')}
        </p>
      )}
      {!isSpeech && models.isError && (
        <div role="alert" className="flex items-center gap-2 text-sm">
          <span>{describeError(models.error)}</span>
          <Button variant="outline" size="sm" onClick={() => void models.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {isSpeech && engines.isError && !engines.data && !busy && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          <span>{describeError(engines.error)}</span>
          <Button variant="outline" size="sm" onClick={engines.retry}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {isSpeech && !canClone && !(engines.isError && !engines.data) && !busy && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          <span>{t('convert.cloning_required')}</span>
          <Link
            to="/settings/models/$family"
            params={{ family: 'tts' }}
            className="font-medium text-primary hover:underline"
          >
            {t('modelSettings.models')}
          </Link>
        </div>
      )}
      {error && (
        <PipelineFailure
          fallback={error}
          onDismiss={() => setError('')}
          action={
            needsModel ? (
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  to="/settings/models/$family"
                  params={{ family: 'asr' }}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t('modelSettings.models')}
                </Link>
                <AgentFixButton
                  request={`Restore local ASR readiness for Voice Conversion, then keep the current source and target voice available for retry. Conversion reported: ${error}`}
                />
              </div>
            ) : undefined
          }
        />
      )}
      {bridge?.files.chooseConversionDestination && (
        <section
          className="space-y-2 rounded-lg border p-3"
          aria-label={t('convertOptions.output')}
        >
          <h3 className="text-sm font-medium">{t('convertOptions.output')}</h3>
          {destination && <p className="select-text break-all text-sm">{destination.path}</p>}
          <p className="text-xs text-muted-foreground">
            {t('convertOptions.output_hint', {
              name: (file?.name.replace(/\.[^.]+$/, '') || 'audio') + '_convert.wav',
            })}
          </p>
          <Button
            variant="outline"
            disabled={!file || busy || exporting || choosingDestination}
            onClick={() => void chooseDestination()}
          >
            {t('clone.download')}
          </Button>
        </section>
      )}
      {jobId && (
        <ConversionProgress
          snapshot={job.data}
          startedAt={startedAt}
          cancelling={cancelling}
          cpuThreads={!isSpeech ? singingModel?.cpu_threads : undefined}
        />
      )}
      {jobId && job.isError && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t('convertProgress.status_unknown')}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          className="min-w-48"
          disabled={!valid || busy || cancelling || choosingDestination || exporting}
          onClick={() => void run()}
        >
          <ArrowLeftRightIcon />
          {busy ? t('convert.converting') : t('convert.convert')}
        </Button>
        {busy && (
          <Button variant="ghost" disabled={cancelling} onClick={() => void cancel()}>
            {t(cancelling ? 'convertProgress.cancelling' : 'common.cancel')}
          </Button>
        )}
      </div>
      {!result && <p className="text-xs text-muted-foreground">{t('convert.save_hint')}</p>}
      {result && (
        <ConversionResult
          result={result}
          suggestedName={(file?.name.replace(/\.[^.]+$/, '') || 'audio') + '_convert.wav'}
          onSaved={(path) => recordConversionExport(result.id, path)}
        />
      )}
    </div>
  );
}
