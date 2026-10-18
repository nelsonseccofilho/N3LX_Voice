import { FolderOpenIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getBridge } from '@/components/bridge';
import { Button } from '@/components/ui/button';
import { SaveAudioButton } from '@/components/save-audio-button';
import { WaveformPlayer } from '@/components/waveform-player';
import { apiPath } from '@/lib/api/client';
import type { ConvertResult } from '@/lib/api/convert';

export function ConversionResult({
  result,
  suggestedName,
  onSaved,
}: {
  result: ConvertResult;
  suggestedName?: string;
  onSaved: (path: string) => void;
}) {
  const { t } = useTranslation();
  const bridge = getBridge();
  const reveal = async (path: string) => {
    try {
      await bridge?.files.revealPath(path);
    } catch (error) {
      toast.error(t('common.error'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <section className="space-y-3 border-t pt-4" aria-label={t('convert.result_kicker')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('convert.result_kicker')}</h3>
        <SaveAudioButton
          url={apiPath(result.audio_url)}
          suggestedName={suggestedName ?? `voicestudio-${result.id}.wav`}
          onSaved={onSaved}
        />
      </div>
      <WaveformPlayer src={apiPath(result.audio_url)} source="convert-result" height={40} />
      <p className="text-xs text-muted-foreground">{t('convert.save_hint')}</p>
      {result.output_path && (
        <div className="space-y-1 rounded-lg border p-3 text-sm">
          <p className="font-medium">{t('convert.saved_in_app')}</p>
          <p className="select-text break-all text-muted-foreground">{result.output_path}</p>
          {bridge && (
            <Button variant="outline" size="sm" onClick={() => void reveal(result.output_path!)}>
              <FolderOpenIcon />
              {t('clone.reveal')}
            </Button>
          )}
        </div>
      )}
      {result.exported_path && (
        <div role="status" className="space-y-2 rounded-lg border border-primary/40 p-3 text-sm">
          <p className="select-text break-all">
            {t('clone.saved_to', { path: result.exported_path })}
          </p>
          {bridge && (
            <Button variant="outline" size="sm" onClick={() => void reveal(result.exported_path!)}>
              <FolderOpenIcon />
              {t('clone.reveal')}
            </Button>
          )}
        </div>
      )}
      {result.text && (
        <p className="text-sm">
          <span className="text-muted-foreground">{t('convert.transcript')}: </span>
          {result.text}
        </p>
      )}
    </section>
  );
}
