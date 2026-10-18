import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Progress } from '@/components/ui/progress';
import type { ConversionProgress as Snapshot } from '@/lib/api/convert';

const stageKeys: Record<string, string> = {
  uploading: 'synthesisState.preparing',
  queued: 'batch.status_queued',
  loading: 'synthesisState.loading',
  analyzing: 'convertProgress.analyzing',
  transcribing: 'dub.transcribing',
  synthesizing: 'convert.converting',
  diffusion: 'convertProgress.diffusion',
  vocoder: 'convertProgress.vocoder',
  validating: 'convertProgress.validating',
  matching: 'convert.match_duration',
  marking: 'convertProgress.marking',
  saving: 'common.saving',
  cancelling: 'convertProgress.cancelling',
  cancelled: 'convertProgress.cancelled',
  completed: 'convertProgress.completed',
  failed: 'common.error',
};
export const clockTime = (seconds: number) => {
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
};
export function ConversionProgress({
  snapshot,
  startedAt,
  cancelling,
  cpuThreads,
}: {
  snapshot?: Snapshot | null;
  startedAt: number;
  cancelling?: boolean;
  cpuThreads?: number;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const terminal = snapshot && ['completed', 'cancelled', 'failed'].includes(snapshot.state);
  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);
  const stage = cancelling ? 'cancelling' : (snapshot?.stage ?? 'uploading');
  const numeric = !cancelling && stage === 'diffusion' && typeof snapshot?.percent === 'number';
  const elapsed = terminal
    ? snapshot.elapsed_s
    : Math.max(snapshot?.elapsed_s ?? 0, (now - startedAt) / 1000);
  return (
    <section
      className="space-y-2 rounded-lg border p-3 text-sm"
      aria-label={t('convertProgress.title')}
    >
      <p role="status" className="font-medium">
        {t(stageKeys[stage] ?? 'convert.converting')}
      </p>
      <p className="tabular-nums">
        <span>{t('calls.elapsed')}: </span>
        <span role="timer" aria-live="off">
          {clockTime(elapsed)}
        </span>
      </p>
      {numeric && (
        <>
          <Progress value={snapshot.percent} aria-label={t('convertProgress.stage_progress')} />
          <p>
            {t('convertProgress.steps', {
              chunk: snapshot.chunk_total
                ? `${snapshot.chunk}/${snapshot.chunk_total}`
                : snapshot.chunk,
              step: snapshot.step,
              total: snapshot.total,
              percent: snapshot.percent,
            })}
          </p>
        </>
      )}
      {!terminal && !cancelling && (
        <p className="text-muted-foreground">
          {numeric && snapshot.eta_s !== null
            ? t('convertProgress.eta', { time: clockTime(snapshot.eta_s) })
            : t('convertProgress.eta_unknown')}
        </p>
      )}
      {numeric && (
        <p className="text-xs text-muted-foreground">{t('convertProgress.stage_scope')}</p>
      )}
      {cpuThreads && (
        <p className="text-xs text-muted-foreground">
          {t('convertProgress.cpu_limit', { threads: cpuThreads })}
        </p>
      )}
    </section>
  );
}
