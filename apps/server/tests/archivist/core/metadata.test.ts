import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dateFromFilename,
  extractFileDate,
  MODIFIED_TAG,
  withFallbackDate,
} from "../../../src/archivist/metadata.js";

test("an IPTC date without a time is a calendar-only file date", () => {
  const date = extractFileDate("jpeg", { "IPTC:DateCreated": "2010:05:06" });
  assert.deepEqual(date.value, {
    kind: "day",
    originalText: "2010:05:06",
    calendarDay: "2010-05-06",
  });
});

test("an IPTC date uses its own time and offset", () => {
  const date = extractFileDate("jpeg", {
    "IPTC:DateCreated": "2010:05:06",
    "IPTC:TimeCreated": "08:30:00+02:00",
  });
  assert.equal(date.value?.kind === "instant" && date.value.instantMs, Date.UTC(2010, 4, 6, 6, 30));
});

test("zeroed placeholder dates count as absent, so creation tags are used", () => {
  const date = extractFileDate("jpeg", {
    "ExifIFD:DateTimeOriginal": "0000:00:00 00:00:00",
    "ExifIFD:CreateDate": "2011:01:01 10:00:00",
  });
  assert.equal(date.status, "found");
  assert.equal(date.tier, "creation");
});

test("a damaged capture date needs review instead of falling back", () => {
  const date = extractFileDate("jpeg", {
    "ExifIFD:DateTimeOriginal": "2019:13:45 10:00:00",
    "ExifIFD:CreateDate": "2011:01:01 10:00:00",
  });
  assert.equal(date.status, "malformed");
  assert.equal(date.tier, "capture");
  assert.equal(date.value, null);
  assert.equal(
    extractFileDate("jpeg", {
      "ExifIFD:DateTimeOriginal": "2019:01:01 10:00:00",
      "ExifIFD:OffsetTimeOriginal": "nonsense",
    }).status,
    "malformed",
  );
});

test("agreeing capture tags pick the one with the most detail", () => {
  const date = extractFileDate("jpeg", {
    "IPTC:DateCreated": "2019:07:15",
    "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00",
    "XMP-exif:DateTimeOriginal": "2019:07:15 13:45:00-04:00",
  });
  assert.equal(date.status, "found");
  assert.equal(date.sourceTag, "XMP-exif:DateTimeOriginal");
  assert.equal(date.candidates.length, 3);
});

test("tags agreeing on the time but not the offset conflict", () => {
  const date = extractFileDate("jpeg", {
    "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00",
    "ExifIFD:OffsetTimeOriginal": "-04:00",
    "XMP-exif:DateTimeOriginal": "2019:07:15 13:45:00+02:00",
  });
  assert.equal(date.status, "conflict");
});

test("an MP4 creation date counts only with its own offset", () => {
  const withoutOffset = extractFileDate("mp4", {
    "Keys:CreationDate": "2019:07:15 13:45:00",
    "QuickTime:CreateDate": "2019:07:15 17:45:00",
  });
  assert.equal(withoutOffset.tier, "creation");
  assert.equal(withoutOffset.sourceTag, "QuickTime:CreateDate");
});

test("formats ignore tags outside their field map", () => {
  const gif = extractFileDate("gif", { "ExifIFD:DateTimeOriginal": "2019:07:15 13:45:00" });
  assert.equal(gif.status, "absent");
  const png = extractFileDate("png", { "PNG:ModifyDate": "2015:05:05 05:05:05" });
  assert.equal(png.status, "absent");
});

test("a PNG creation time written out in words is read, keeping its wall clock when only an abbreviation names the zone", () => {
  // GNOME writes the computer's locale format. EDT could mean several offsets, so the zone stays unknown.
  const gnome = extractFileDate("png", { "PNG:CreationTime": "Mon 15 Jul 2019 06:30:12 PM EDT" });
  assert.equal(gnome.status, "found");
  assert.equal(gnome.tier, "creation");
  assert.deepEqual(gnome.value, {
    kind: "unknown_local",
    originalText: "Mon 15 Jul 2019 06:30:12 PM EDT",
    calendarDay: "2019-07-15",
    localDateTime: "2019-07-15T18:30:12",
  });
  const utc = extractFileDate("png", { "PNG:CreationTime": "Mon, 15 Jul 2019 18:30:12 GMT" });
  assert.equal(
    utc.value?.kind === "instant" && utc.value.instantMs,
    Date.UTC(2019, 6, 15, 18, 30, 12),
  );
  const c = extractFileDate("png", { "PNG:CreationTime": "Mon Jul 15 18:30:12 2019" });
  assert.equal(c.value?.kind === "unknown_local" && c.value.localDateTime, "2019-07-15T18:30:12");
  const iso = extractFileDate("png", { "PNG:CreationTime": "2019-07-15T18:30:12-04:00" });
  assert.equal(
    iso.value?.kind === "instant" && iso.value.instantMs,
    Date.UTC(2019, 6, 15, 22, 30, 12),
  );
  // Words that are not a date still need a contributor.
  assert.equal(
    extractFileDate("png", { "PNG:CreationTime": "sometime last summer" }).status,
    "malformed",
  );
  assert.equal(
    extractFileDate("png", { "PNG:CreationTime": "Mo 15 Juli 2019" }).status,
    "malformed",
  );
  // Other tags keep ExifTool's own format only.
  assert.equal(
    extractFileDate("jpeg", { "ExifIFD:DateTimeOriginal": "Mon 15 Jul 2019 06:30:12 PM" }).status,
    "malformed",
  );
});

test("dates are read from the names cameras, phones, and screenshot tools give files", () => {
  const cases: [string, string, string | null][] = [
    ["IMG_20190715_183012.jpg", "2019-07-15", "2019-07-15T18:30:12"],
    ["PXL_20240715_183012345.jpg", "2024-07-15", "2024-07-15T18:30:12"],
    ["Screenshot_20240715-183012.png", "2024-07-15", "2024-07-15T18:30:12"],
    ["Screenshot from 2024-07-15 18-30-12.png", "2024-07-15", "2024-07-15T18:30:12"],
    ["Screenshot 2024-07-15 at 18.30.12.png", "2024-07-15", "2024-07-15T18:30:12"],
    ["WhatsApp Image 2019-07-15 at 18.30.12.jpeg", "2019-07-15", "2019-07-15T18:30:12"],
    ["signal-2024-07-15-183012.jpg", "2024-07-15", "2024-07-15T18:30:12"],
    ["IMG-20190715-WA0001.jpg", "2019-07-15", null],
    ["holiday 2019-07-15.png", "2019-07-15", null],
  ];
  for (const [name, day, local] of cases) {
    const found = dateFromFilename(name);
    assert.ok(found, name);
    assert.equal(found.tag, "File:Name");
    if (local) {
      assert.deepEqual(found.value, {
        kind: "unknown_local",
        originalText: found.raw,
        calendarDay: day,
        localDateTime: local,
      });
    } else
      assert.deepEqual(found.value, { kind: "day", originalText: found.raw, calendarDay: day });
  }
  // IDs, counters, and impossible dates are not dates.
  for (const name of [
    "1259876543210987654.png",
    "image0.png",
    "photo_2019.jpg",
    "scan_20191345.png",
    "201907151.png",
    "1985-07-15.png",
  ]) {
    assert.equal(dateFromFilename(name), null, name);
  }
});

test("a file with no date inside takes one from its name, then from the uploader's computer", () => {
  const absent = extractFileDate("png", {});
  const named = withFallbackDate(absent, {
    filename: "Screenshot_20240715-183012.png",
    modifiedMs: Date.UTC(2025, 0, 2),
    modifiedZone: "America/Toronto",
  });
  assert.equal(named.status, "found");
  assert.equal(named.tier, "filename");
  assert.equal(named.sourceTag, "File:Name");

  const modified = withFallbackDate(absent, {
    filename: "unknown.png",
    modifiedMs: Date.UTC(2025, 0, 2, 3, 4, 5),
    modifiedZone: "America/Toronto",
  });
  assert.equal(modified.tier, "modified");
  assert.equal(modified.sourceTag, MODIFIED_TAG);
  assert.deepEqual(modified.value, {
    kind: "instant",
    originalText: "2025-01-02T03:04:05.000Z",
    instantMs: Date.UTC(2025, 0, 2, 3, 4, 5),
    timezone: "America/Toronto",
  });

  assert.equal(
    withFallbackDate(absent, { filename: "unknown.png", modifiedMs: null, modifiedZone: "UTC" })
      .status,
    "absent",
  );
  // An embedded date wins, and a damaged one still waits for a contributor.
  const embedded = extractFileDate("png", { "XMP-xmp:CreateDate": "2011:01:01 10:00:00" });
  assert.equal(
    withFallbackDate(embedded, {
      filename: "IMG_20190715_183012.png",
      modifiedMs: 1,
      modifiedZone: "UTC",
    }),
    embedded,
  );
  const damaged = extractFileDate("png", { "XMP-xmp:CreateDate": "2019:13:45 10:00:00" });
  assert.equal(
    withFallbackDate(damaged, {
      filename: "IMG_20190715_183012.png",
      modifiedMs: 1,
      modifiedZone: "UTC",
    }).status,
    "malformed",
  );
});
