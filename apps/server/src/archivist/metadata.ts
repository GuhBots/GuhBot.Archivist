import { ExifTool } from "exiftool-vendored";
import type { DateValue } from "./dates.js";

/**
 * Reads embedded metadata from original files with ExifTool, and picks the
 * file date an artifact falls back to when it has no exact or estimated date.
 *
 * Only tags embedded in the file count. Filesystem times, upload and download
 * times, and Drive dates are never used, because copying a file changes them.
 * Raw tags are stored with their group names, so anyone can check how a date
 * was read. Timezones are never guessed from location or other tags.
 */

export type MediaFormat =
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "mp4"
  | "mov"
  | "webm"
  | "mkv"
  | "avi"
  | "mp3"
  | "m4a"
  | "wav"
  | "ogg"
  | "flac";

/** Group-qualified raw tags, such as `ExifIFD:DateTimeOriginal`. */
export type RawTags = Record<string, unknown>;

let exifTool: ExifTool | undefined;

function reader(): ExifTool {
  exifTool ??= new ExifTool({ maxProcs: 2, taskTimeoutMillis: 30_000 });
  return exifTool;
}

/** Stops the ExifTool process. The bot calls this when it shuts down. */
export async function closeMetadataReader(): Promise<void> {
  const current = exifTool;
  exifTool = undefined;
  await current?.end();
}

/** Groups describing the copy on disk or ExifTool itself, not the original's content. */
const IGNORED_GROUPS = ["System:", "ExifTool:"];

export interface RawMetadata {
  tags: RawTags;
  /** ExifTool's errors for the file, such as a damaged structure. */
  errors: string[];
}

export async function readRawMetadata(file: string): Promise<RawMetadata> {
  const raw = (await reader().readRaw(file, { readArgs: ["-G1", "-a", "-s"] })) as Record<
    string,
    unknown
  >;
  const errors = ["ExifTool:Error", "Error"]
    .map((key) => raw[key])
    .filter((value): value is string => typeof value === "string");
  const tags: RawTags = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "SourceFile" || key === "errors" || key === "warnings") continue;
    if (IGNORED_GROUPS.some((group) => key.startsWith(group))) continue;
    tags[key] = value;
  }
  return { tags, errors };
}

/**
 * One embedded date field. Companion tags hold the field's own subseconds,
 * offset, or (for IPTC) time. An offset is never borrowed from another field.
 */
interface DateField {
  tag: string;
  subSeconds?: string;
  offset?: string;
  time?: string;
  /** Use the field only when it carries its own offset. */
  requireOffset?: boolean;
  /**
   * The field is free text that programs fill in their own way, so written
   * dates such as `Mon 15 Jul 2019 06:30:12 PM EDT` are read too. PNG's
   * Creation Time is one: GNOME writes it in the computer's locale.
   */
  textual?: boolean;
}

interface FieldTiers {
  capture: DateField[];
  creation: DateField[];
}

const STILL_IMAGE_FIELDS: FieldTiers = {
  capture: [
    {
      tag: "ExifIFD:DateTimeOriginal",
      subSeconds: "ExifIFD:SubSecTimeOriginal",
      offset: "ExifIFD:OffsetTimeOriginal",
    },
    { tag: "XMP-exif:DateTimeOriginal" },
    { tag: "XMP-photoshop:DateCreated" },
    { tag: "IPTC:DateCreated", time: "IPTC:TimeCreated" },
  ],
  creation: [
    {
      tag: "ExifIFD:CreateDate",
      subSeconds: "ExifIFD:SubSecTimeDigitized",
      offset: "ExifIFD:OffsetTimeDigitized",
    },
    { tag: "XMP-xmp:CreateDate" },
    { tag: "PNG:CreationTime", textual: true },
  ],
};

/** MP4, QuickTime, and M4A files share the QuickTime container and its tags. */
const QUICKTIME_FIELDS: FieldTiers = {
  capture: [
    { tag: "XMP-exif:DateTimeOriginal" },
    { tag: "UserData:DateTimeOriginal" },
    { tag: "Keys:CreationDate", requireOffset: true },
    { tag: "ItemList:CreationDate", requireOffset: true },
  ],
  // The movie header's date is often written in local time despite the
  // format calling for UTC, so it stays a local value with unknown zone.
  creation: [{ tag: "QuickTime:CreateDate" }],
};

/** AVI and WAV keep dates in RIFF chunks: a camera's original date, then the file's creation date. */
const RIFF_FIELDS: FieldTiers = {
  capture: [{ tag: "RIFF:DateTimeOriginal" }],
  creation: [{ tag: "RIFF:DateCreated" }],
};

/**
 * Formats with no accepted date tags. MP3, Ogg, and FLAC date tags hold a
 * recording's release date or year, not when the file was made, so these
 * files are dated by hand.
 */
const NO_FIELDS: FieldTiers = { capture: [], creation: [] };

/** The plan's field map. PNG modification times and filesystem dates are deliberately absent. */
const FIELDS: Record<MediaFormat, FieldTiers> = {
  jpeg: STILL_IMAGE_FIELDS,
  png: STILL_IMAGE_FIELDS,
  webp: STILL_IMAGE_FIELDS,
  gif: {
    capture: [{ tag: "XMP-exif:DateTimeOriginal" }, { tag: "XMP-photoshop:DateCreated" }],
    creation: [{ tag: "XMP-xmp:CreateDate" }],
  },
  mp4: QUICKTIME_FIELDS,
  mov: QUICKTIME_FIELDS,
  m4a: QUICKTIME_FIELDS,
  // Matroska stores one date, in UTC, which ExifTool reports with a Z.
  webm: { capture: [{ tag: "Info:DateTimeOriginal" }], creation: [] },
  mkv: { capture: [{ tag: "Info:DateTimeOriginal" }], creation: [] },
  avi: RIFF_FIELDS,
  wav: RIFF_FIELDS,
  mp3: NO_FIELDS,
  ogg: NO_FIELDS,
  flac: NO_FIELDS,
};

export interface FileDateCandidate {
  tag: string;
  raw: string;
  value: DateValue | null;
}

export interface FileDate {
  /**
   * `found` gives a value. `absent` means no accepted tag holds a date.
   * `conflict` and `malformed` need a contributor to set the date, because
   * guessing between disagreeing or damaged tags could invent history.
   */
  status: "found" | "absent" | "conflict" | "malformed";
  /**
   * Where the date came from: embedded capture or creation tags, the file's
   * name, or the modified time the uploader's computer reported.
   */
  tier: "capture" | "creation" | "filename" | "modified" | null;
  sourceTag: string | null;
  value: DateValue | null;
  candidates: FileDateCandidate[];
}

const RAW_DATE =
  /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const RAW_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
const RAW_OFFSET = /^(Z|[+-]\d{2}:?\d{2})$/;
const PLACEHOLDER = /^[0: ]*$|^\s*:\s*:/;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result ? result : undefined;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function offsetMinutes(offset: string): number | null {
  if (offset === "Z") return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59) return null;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The outcome of reading one field: no date, a damaged one, or a value. */
type FieldReading =
  | { kind: "absent" }
  | { kind: "malformed"; raw: string }
  | { kind: "value"; raw: string; value: DateValue };

function readField(tags: RawTags, field: DateField): FieldReading {
  const raw = text(tags[field.tag]);
  if (raw === undefined || PLACEHOLDER.test(raw)) return { kind: "absent" };
  let match = RAW_DATE.exec(raw);
  if (!match && field.textual) {
    const normalized = normalizeWrittenDate(raw);
    match = normalized ? RAW_DATE.exec(normalized) : null;
  }
  if (!match) return { kind: "malformed", raw };

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return { kind: "malformed", raw };
  }
  let hour = match[4] === undefined ? undefined : Number(match[4]);
  let minute = match[5] === undefined ? undefined : Number(match[5]);
  let second = Number(match[6] ?? 0);
  let fraction = match[7];
  let offset = match[8];
  let original = raw;

  if (hour === undefined && field.time) {
    const timeRaw = text(tags[field.time]);
    if (timeRaw !== undefined) {
      const time = RAW_TIME.exec(timeRaw);
      if (!time) return { kind: "malformed", raw: `${raw} ${timeRaw}` };
      hour = Number(time[1]);
      minute = Number(time[2]);
      second = Number(time[3] ?? 0);
      fraction = time[4];
      offset = time[5];
      original = `${raw} ${timeRaw}`;
    }
  }
  if (hour !== undefined && field.subSeconds && fraction === undefined) {
    const subSeconds = text(tags[field.subSeconds]);
    if (subSeconds !== undefined) {
      if (!/^\d+$/.test(subSeconds)) return { kind: "malformed", raw: `${raw}.${subSeconds}` };
      fraction = subSeconds;
      original = `${original}.${subSeconds}`;
    }
  }
  if (hour !== undefined && field.offset && offset === undefined) {
    const companion = text(tags[field.offset]);
    if (companion !== undefined) {
      if (!RAW_OFFSET.test(companion)) return { kind: "malformed", raw: `${raw} ${companion}` };
      offset = companion;
      original = `${original} ${companion}`;
    }
  }

  const calendarDay = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (hour === undefined) {
    if (offset !== undefined) return { kind: "malformed", raw };
    return {
      kind: "value",
      raw: original,
      value: { kind: "day", originalText: original, calendarDay },
    };
  }
  if (hour > 23 || (minute ?? 0) > 59 || second > 59) return { kind: "malformed", raw: original };
  if (field.requireOffset && offset === undefined) return { kind: "absent" };

  const milliseconds = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  const fractionText = fraction === undefined ? "" : `.${fraction}`;
  const localDateTime = `${calendarDay}T${pad(hour)}:${pad(minute ?? 0)}:${pad(second)}${fractionText}`;
  if (offset === undefined) {
    return {
      kind: "value",
      raw: original,
      value: { kind: "unknown_local", originalText: original, calendarDay, localDateTime },
    };
  }
  const minutes = offsetMinutes(offset);
  if (minutes === null) return { kind: "malformed", raw: original };
  const instantMs =
    Date.UTC(year, month - 1, day, hour, minute ?? 0, second, milliseconds) - minutes * 60_000;
  return {
    kind: "value",
    raw: original,
    value: { kind: "instant", originalText: original, instantMs, timezone: offsetLabel(minutes) },
  };
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * A date written out in words, as in RFC 1123 (`Mon, 15 Jul 2019 18:30:12
 * +0000`), C's `%c` in English locales (`Mon 15 Jul 2019 06:30:12 PM EDT`,
 * `Mon Jul 15 18:30:12 2019`), or ISO 8601, as ExifTool's
 * `YYYY:MM:DD HH:MM:SS` with any offset. Only numeric offsets, UTC, and GMT
 * count as zones. Abbreviations such as EDT mean different offsets in
 * different places, so a time with one keeps its wall clock and an unknown
 * zone. Null when the text is not such a date.
 */
export function normalizeWrittenDate(raw: string): string | null {
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw,
    );
  if (iso) return `${iso[1]}:${iso[2]}:${iso[3]}${iso[4] ? ` ${iso[4]}` : ""}${iso[5] ?? ""}`;
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let time: [number, number, number] | undefined;
  let meridiem: "am" | "pm" | undefined;
  let zone: string | undefined;
  for (const word of raw.replace(/,/g, " ").split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase().replace(/\.$/, "");
    const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(word);
    const monthIndex = MONTH_NAMES.findIndex((name) => lower.length >= 3 && name.startsWith(lower));
    if (monthIndex >= 0 && month === undefined) month = monthIndex + 1;
    else if (/^\d{4}$/.test(word) && year === undefined) year = Number(word);
    else if (/^\d{1,2}$/.test(word) && day === undefined) day = Number(word);
    else if (clock && time === undefined) {
      time = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)];
    } else if (lower === "am" || lower === "pm") meridiem = lower;
    else if (/^(z|utc|gmt)$/.test(lower)) zone = "Z";
    else if (/^(?:utc|gmt)?[+-]\d{2}:?\d{2}$/.test(lower)) zone = lower.replace(/^(utc|gmt)/, "");
    // Weekdays and zone abbreviations carry nothing to keep. Any other word,
    // such as a month in another language, means this is not a date to read.
    else if (!/^[a-z]{2,9}$/.test(lower)) return null;
  }
  if (year === undefined || month === undefined || day === undefined) return null;
  if (!time && (meridiem || zone)) return null;
  if (time && meridiem) {
    if (time[0] < 1 || time[0] > 12) return null;
    time[0] = (time[0] % 12) + (meridiem === "pm" ? 12 : 0);
  }
  const date = `${pad(year, 4)}:${pad(month)}:${pad(day)}`;
  if (!time) return date;
  return `${date} ${time.map((part) => pad(part)).join(":")}${zone ?? ""}`;
}

/**
 * A date in a file's name, as cameras, phones, and screenshot tools write
 * them: `IMG_20190715_183012.jpg`, `Screenshot from 2019-07-15 18-30-12.png`,
 * `Screenshot 2019-07-15 at 18.30.12.png`, or `PXL_20190715_183012345.jpg`.
 * The time is the camera's wall clock, so its zone stays unknown. Null when
 * the name holds no real date from 1990 on.
 */
export function dateFromFilename(filename: string): FileDateCandidate | null {
  const name = filename.replace(/\.[a-z0-9]{1,5}$/i, "");
  const patterns = [
    // Separated: 2019-07-15, 2019_07_15, or 2019.07.15, with an optional time after it.
    /(?<!\d)((?:19|20)\d{2})([-_.])(\d{2})\2(\d{2})(?:(?:[ _T-]|\s+at\s+)(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?(?!\d)/i,
    // Compact: 20190715 with an optional 183012 after it, which may carry milliseconds.
    /(?<!\d)((?:19|20)\d{2})()(\d{2})(\d{2})(?:[ _T-]?(\d{2})(\d{2})(\d{2})\d{0,3})?(?!\d)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(name);
    if (!match) continue;
    const [year, month, day] = [Number(match[1]), Number(match[3]), Number(match[4])];
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (year < 1990 || month < 1 || month > 12 || day < 1 || day > lastDay) continue;
    const calendarDay = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
    const raw = match[0];
    if (match[5] === undefined) {
      return { tag: "File:Name", raw, value: { kind: "day", originalText: raw, calendarDay } };
    }
    const [hour, minute, second] = [Number(match[5]), Number(match[6]), Number(match[7])];
    if (hour > 23 || minute > 59 || second > 59) {
      return { tag: "File:Name", raw, value: { kind: "day", originalText: raw, calendarDay } };
    }
    return {
      tag: "File:Name",
      raw,
      value: {
        kind: "unknown_local",
        originalText: raw,
        calendarDay,
        localDateTime: `${calendarDay}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
      },
    };
  }
  return null;
}

/** The pseudo-tag for a file's modified time as the uploader's browser reported it. */
export const MODIFIED_TAG = "Upload:FileModifyDate";

/**
 * Fills in a file date for a file with no embedded one. The owner chose on
 * 2026-11-25 that every uploaded file should get a date: first one in the
 * file's name, then, for website uploads, when the uploader's computer last
 * changed the file. Both are labeled by source and stay below exact and
 * estimated dates. Damaged or disagreeing embedded dates still wait for a
 * contributor, because the file's own date may be the right one.
 */
export function withFallbackDate(
  found: FileDate,
  input: { filename: string; modifiedMs: number | null; modifiedZone: string },
): FileDate {
  if (found.status !== "absent") return found;
  const named = dateFromFilename(input.filename);
  if (named) {
    return {
      status: "found",
      tier: "filename",
      sourceTag: named.tag,
      value: named.value,
      candidates: [named],
    };
  }
  if (input.modifiedMs !== null) {
    const raw = new Date(input.modifiedMs).toISOString();
    const candidate: FileDateCandidate = {
      tag: MODIFIED_TAG,
      raw,
      value: {
        kind: "instant",
        originalText: raw,
        instantMs: input.modifiedMs,
        timezone: input.modifiedZone,
      },
    };
    return {
      status: "found",
      tier: "modified",
      sourceTag: MODIFIED_TAG,
      value: candidate.value,
      candidates: [candidate],
    };
  }
  return found;
}

/** Wall-clock text of a value, to compare fields that may or may not carry an offset. */
function wallClock(value: DateValue): { day: string; time: string | null; offset: string | null } {
  if (value.kind === "day") return { day: value.calendarDay, time: null, offset: null };
  if (value.kind === "unknown_local") {
    return { day: value.calendarDay, time: value.localDateTime.slice(11, 19), offset: null };
  }
  const minutes = offsetMinutes(value.timezone === "UTC" ? "Z" : value.timezone) ?? 0;
  const local = new Date(value.instantMs + minutes * 60_000).toISOString();
  return { day: local.slice(0, 10), time: local.slice(11, 19), offset: value.timezone };
}

/**
 * Fields agree when they name the same day, the same time to the second when
 * both have one, and the same offset when both have one.
 */
function agree(a: DateValue, b: DateValue): boolean {
  const left = wallClock(a);
  const right = wallClock(b);
  if (left.day !== right.day) return false;
  if (left.time !== null && right.time !== null && left.time !== right.time) return false;
  return left.offset === null || right.offset === null || left.offset === right.offset;
}

const DETAIL: Record<DateValue["kind"], number> = { day: 0, unknown_local: 1, instant: 2 };

/**
 * Picks the file date from original-capture tags first, then creation tags.
 * The first tier holding any date decides. Within it, a damaged tag or two
 * disagreeing tags leave the date unknown for a contributor to review.
 */
export function extractFileDate(format: MediaFormat, tags: RawTags): FileDate {
  for (const tier of ["capture", "creation"] as const) {
    const readings = FIELDS[format][tier].map((field) => ({
      field,
      reading: readField(tags, field),
    }));
    const present = readings.filter(({ reading }) => reading.kind !== "absent");
    if (present.length === 0) continue;
    const candidates: FileDateCandidate[] = present.map(({ field, reading }) => ({
      tag: field.tag,
      raw: reading.kind === "absent" ? "" : reading.raw,
      value: reading.kind === "value" ? reading.value : null,
    }));
    const unknown = { tier, sourceTag: null, value: null, candidates };
    if (present.some(({ reading }) => reading.kind === "malformed")) {
      return { status: "malformed", ...unknown };
    }
    const values = candidates.map((candidate) => candidate.value!);
    if (values.some((value) => values.some((other) => !agree(value, other)))) {
      return { status: "conflict", ...unknown };
    }
    const best = candidates.reduce((chosen, candidate) =>
      DETAIL[candidate.value!.kind] > DETAIL[chosen.value!.kind] ? candidate : chosen,
    );
    return { status: "found", tier, sourceTag: best.tag, value: best.value, candidates };
  }
  return { status: "absent", tier: null, sourceTag: null, value: null, candidates: [] };
}
