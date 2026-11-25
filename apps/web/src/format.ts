/** Dates as the website shows them: month names, so no one misreads the order. */

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_MS = 86_400_000;
export const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
export const dayOfNumber = (n: number): string =>
  new Date(Math.round(n) * DAY_MS).toISOString().slice(0, 10);
export const todayDay = (): string => new Date().toISOString().slice(0, 10);

/** `2019-07-15` as `Jul 15, 2019`. */
export function dayText(day: string | null | undefined): string {
  if (!day) return "No date yet";
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function monthText(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

export function basisText(basis: string): string {
  return (
    { exact: "exact", estimated: "estimated", file: "file date, not verified", undated: "undated" }[
      basis
    ] ?? basis
  );
}

export function initials(name: string): string {
  return name
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!)
    .join("")
    .toUpperCase();
}

export const shortId = (id: string) => id.slice(0, 8);

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

/**
 * A file size such as `512 B`, `3.4 MB`, or `1.2 GB`. Each unit is 1024 of
 * the one before, as file managers on Windows count them.
 */
export function byteText(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  // Rounding through a number drops trailing zeros, so 3.40 shows as 3.4.
  return `${Number(value.toFixed(digits))} ${BYTE_UNITS[unit]}`;
}

/** Today's date in a timezone, such as the archive's, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string): string {
  try {
    // The Canadian English format is year-month-day.
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return todayDay();
  }
}
