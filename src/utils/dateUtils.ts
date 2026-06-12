export function parseDate(dateStr: string): Date {
  return new Date(dateStr);
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDateTime(date: Date): string {
  const datePart = formatDate(date);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${datePart} ${h}:${m}:${s}`;
}

export function parseDateTime(dateTimeStr: string): Date {
  return new Date(dateTimeStr);
}

export function getTimePart(dateTimeStr: string): string {
  const dt = parseDateTime(dateTimeStr);
  const h = String(dt.getHours()).padStart(2, '0');
  const m = String(dt.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function getDatePart(dateTimeStr: string): string {
  return formatDate(parseDateTime(dateTimeStr));
}

export function isSameDay(date1: string, date2: string): boolean {
  return formatDate(parseDate(date1)) === formatDate(parseDate(date2));
}

export function isDateTimeSameDay(dt1: string, dt2: string): boolean {
  return formatDate(parseDateTime(dt1)) === formatDate(parseDateTime(dt2));
}

export function addDays(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

export function addDaysToDate(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function diffDays(startDate: string, endDate: string): number {
  const s = parseDate(startDate).getTime();
  const e = parseDate(endDate).getTime();
  return Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
}

export function diffMinutes(startDt: string, endDt: string): number {
  const s = parseDateTime(startDt).getTime();
  const e = parseDateTime(endDt).getTime();
  return Math.round((e - s) / (1000 * 60));
}

export function diffHours(startDt: string, endDt: string): number {
  return diffMinutes(startDt, endDt) / 60;
}

export function generateDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = parseDate(startDate);
  const end = parseDate(endDate);
  while (current <= end) {
    dates.push(formatDate(current));
    current = addDaysToDate(current, 1);
  }
  return dates;
}

export function isWeekend(dateStr: string, weekendDays: number[] = [0, 6]): boolean {
  const d = parseDate(dateStr);
  return weekendDays.includes(d.getDay());
}

export function getDayOfWeek(dateStr: string): number {
  return parseDate(dateStr).getDay();
}

export function createDateTime(dateStr: string, timeStr: string): string {
  return `${dateStr} ${timeStr}:00`;
}

export function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function getMonthRange(year: number, month: number): { start: string; end: string } {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

export function isInRange(date: string, start: string, end: string): boolean {
  const d = parseDate(date).getTime();
  const s = parseDate(start).getTime();
  const e = parseDate(end).getTime();
  return d >= s && d <= e;
}

export function isDateTimeInRange(dt: string, start: string, end: string): boolean {
  const d = parseDateTime(dt).getTime();
  const s = parseDateTime(start).getTime();
  const e = parseDateTime(end).getTime();
  return d >= s && d <= e;
}

export function roundToHalfHour(minutes: number): number {
  return Math.round(minutes / 30) * 30;
}

export function roundHours(hours: number, precision: number = 2): number {
  return Math.round(hours * Math.pow(10, precision)) / Math.pow(10, precision);
}
