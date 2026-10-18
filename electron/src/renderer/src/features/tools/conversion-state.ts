import { Store } from '@tanstack/store';
import { useStore } from '@tanstack/react-store';
import type { ConvertResult } from '@/lib/api/convert';
type Conversion = {
  mode: 'speech' | 'singing';
  compute: 'auto' | 'cpu' | 'gpu';
  destination: { token: string; path: string } | null;
  file: File | null;
  voice: string;
  match: boolean;
  result: ConvertResult | null;
};
const empty = (): Conversion => ({
  mode: 'speech',
  compute: 'auto',
  destination: null,
  file: null,
  voice: '',
  match: true,
  result: null,
});
const conversion = new Store<Conversion>(empty());
export const useConversion = () => useStore(conversion);
export function setConversion<K extends keyof Conversion>(key: K, value: Conversion[K]) {
  conversion.setState((current) => ({ ...current, [key]: value }));
}
export const clearConversion = () => conversion.setState(empty);

/** A late native dialog must not restore a result the user already replaced. */
export function recordConversionExport(id: string, path: string) {
  conversion.setState((current) =>
    current.result?.id === id
      ? { ...current, result: { ...current.result, exported_path: path } }
      : current,
  );
}
