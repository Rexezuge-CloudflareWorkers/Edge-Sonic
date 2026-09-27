/**
 * Display formatters.
 *
 * English-only on purpose. The reference project had a localization gap here while
 * everything around it was translated, which is worse than being consistently
 * English: a user gets a translated error and an untranslated `3.4 MB`.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} ${UNITS[0]}`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10, none above: `9.4 MB` is informative, `847.3 MB` is noise.
  return `${unit < 2 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatEpochSeconds(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '—';
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

export { formatBytes, formatDuration, formatEpochSeconds };
