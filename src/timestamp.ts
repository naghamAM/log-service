const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseIsoTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = ISO_TIMESTAMP.exec(value);
  if (!match) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const maxDay = new Date(
    Date.UTC(Number(year), monthNumber, 0),
  ).getUTCDate();

  if (
    monthNumber < 1 || monthNumber > 12 ||
    dayNumber < 1 || dayNumber > maxDay ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
  ) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
