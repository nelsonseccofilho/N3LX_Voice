import { useTranslation } from 'react-i18next';
import type { NativeGpuRuntime } from '@/hooks/use-device-usage';

/** Compute identity is useful even when device-wide counters are unavailable. */
export function GpuRuntimeSummary({ runtime }: { runtime: NativeGpuRuntime }) {
  const { t } = useTranslation();
  const device =
    runtime.verified && runtime.device_name
      ? `${runtime.device_name} · ${runtime.provider}`
      : runtime.provider;
  return (
    <div role="status" data-slot="gpu-runtime-summary" className="min-w-0 space-y-1">
      <div className="text-[11px] text-muted-foreground">{t('settings.device_family_gpu')}</div>
      <div className="text-xs font-medium break-words">{device}</div>
      <div className="text-[11px] text-muted-foreground">
        {t(runtime.verified ? 'performanceHardware.gpuUsing' : 'performanceHardware.gpuSelected')}
      </div>
    </div>
  );
}
