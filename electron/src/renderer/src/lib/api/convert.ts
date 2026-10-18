import { apiJson, ApiError } from './client';
import { acquireSynthesis } from '@/lib/synthesis-lock';
import { tr } from '@/lib/i18n-text';
import { beginAppActivity } from '@/lib/app-activity';
export interface ConvertResult {
  id: string;
  audio_url: string;
  output_path?: string;
  /** Chosen by the user through native Save As; not a backend output. */
  exported_path?: string;
  text: string;
  duration_s: number;
  gen_time_s: number;
}
export async function convertSpeech(
  audio: File,
  profileId: string,
  matchDuration: boolean,
  signal: AbortSignal,
  mode: 'speech' | 'singing' = 'speech',
  jobId?: string,
  compute: 'auto' | 'cpu' | 'gpu' = 'auto',
): Promise<ConvertResult> {
  signal.throwIfAborted();
  const release = acquireSynthesis();
  if (!release) throw new Error(tr('tts_errors.generation_in_progress'));
  const finishActivity = beginAppActivity('synthesis');
  try {
    const body = new FormData();
    body.append('audio', audio);
    if (jobId) body.append('job_id', jobId);
    body.append('mode', mode);
    body.append('compute', compute);
    body.append('profile_id', profileId);
    body.append('match_duration', matchDuration ? '1' : '0');
    return await apiJson<ConvertResult>('/convert', { method: 'POST', body, signal });
  } finally {
    finishActivity();
    release();
  }
}

export interface ConversionModels {
  speech?: { compute_options: ('auto' | 'cpu' | 'gpu')[] };
  singing: {
    id: string;
    display_name: string;
    available: boolean;
    device: string;
    sample_rate: number;
    cpu_threads?: number;
    compute_options?: ('cpu' | 'gpu')[];
  };
}
export const getConversionModels = () => apiJson<ConversionModels>('/convert/models');

export interface ConversionProgress {
  job_id: string;
  state: 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
  stage: string;
  elapsed_s: number;
  step: number | null;
  total: number | null;
  chunk: number | null;
  chunk_total?: number | null;
  percent: number | null;
  eta_s: number | null;
  eta_scope: 'stage' | null;
}
export async function getConversionProgress(jobId: string): Promise<ConversionProgress | null> {
  try {
    return await apiJson<ConversionProgress>(`/convert/jobs/${jobId}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
export const cancelConversion = (jobId: string) =>
  apiJson<ConversionProgress>(`/convert/jobs/${jobId}/cancel`, { method: 'POST' });
