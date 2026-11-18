import type { Locale } from '../types/commandCenter';

export function formatBytes(bytes: number | null | undefined, locale: Locale): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return locale === 'ar' ? 'غير متاح' : 'N/A';
  }
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatTimestamp(isoString: string | null | undefined, locale: Locale): string {
  if (!isoString) return locale === 'ar' ? 'غير متاح' : 'N/A';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}
