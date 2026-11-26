# Bot API

The Archivist service holds every archive, its media, and its rules. The GuhBot Discord bot keeps its Archivist commands as thin clients of the service's JSON API. This document is the contract between them. The [Archivist plan](../proposals/ARCHIVIST-PLAN.md) specifies the product rules. The source of truth for request and response shapes is the server code in [`apps/server`](../../apps/server/README.md).

## Addresses and Transport

The bot's `ARCHIVIST_API_URL` is the service's base address, including any path the website lives under, such as `https://guhbot.example.com/archivist` or `http://archivist:3000` on a private network. Every path below is relative to it, so `/api/me` means `<ARCHIVIST_API_URL>/api/me`.

* Requests and responses are JSON, except artifact uploads, which are `multipart/form-data`, and media and previews, which are bytes.
* Use HTTPS except on localhost or a private container network. The service refuses a plain `http` base address for browsers unless it is localhost.
* Do not follow redirects on authenticated requests, so the credential never reaches another host.
* Give every request a deadline. Retry a read that timed out at most twice. Never retry a change after a timeout, because it may have been saved. Re-read the record instead, or rely on duplicate review for uploads.
* There is no fallback. When the service cannot be reached, the command replies with a private error and nothing is saved anywhere else.

## Authentication

The bot authenticates with one shared secret, the service token, configured as `ARCHIVIST_SERVICE_TOKEN` in both services.

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <ARCHIVIST_SERVICE_TOKEN>` |
| `X-Archivist-User` | The Discord user ID of the contributor who ran the command, taken from the interaction |

* Every route that acts for a contributor needs both headers. The service checks that contributor's current owner status and whitelist on each request, exactly as it does for a signed-in browser. The token never makes a request an owner request.
* Owners are the Discord user IDs in the service's `ARCHIVIST_OWNER_IDS`. The bot's own application owner or team has no say.
* Routes under `/api/service/` act for nobody. They need the token and no `X-Archivist-User`.
* A wrong token answers `401` with reason `invalid_service_token`. A valid token without a valid `X-Archivist-User` answers `400` with reason `acting_user_required`. A request carrying both the token and a browser session cookie answers `400` with reason `mixed_credentials`.
* Bot requests do not need an `Origin` header and never receive a session cookie.

### Managing the Token

1. Generate a token on any trusted machine with `openssl rand -hex 32`. It must be at least 32 bytes.
2. Put the same value in the service's `.env` and the bot's `.env` as `ARCHIVIST_SERVICE_TOKEN`. Keep it out of Git, chat, logs, and archive folders. It is not the bot token, the OAuth client secret, or the session secret.
3. Restart both services. The service reads the token at startup.

To rotate it, generate a new value, update both `.env` files, and restart the service and then the bot. The old value stops working when the service restarts, and browser sessions are unaffected. To turn the bot's access off, remove the token from the service and restart it. Browsers keep working.

## Errors

Every error is `{code, message, details}`. `message` is safe to show the contributor. `details.reason`, when present, names the specific case.

| Status | Code | When |
| --- | --- | --- |
| `400` | `invalid_input` | Input the contributor can fix. `details.field` names the field. Reasons include `archive_required`, `acting_user_required`, and `mixed_credentials` |
| `401` | `no_session` | The token is wrong (`invalid_service_token`) |
| `403` | `forbidden` | The contributor sees the archive but may not do this, such as a member running an owner command. `service_only` for a browser on a bot route |
| `404` | `archive_not_found`, `not_found` | No such archive or record, or the contributor cannot see it |
| `409` | `stale_version`, `reference_blocked`, `name_taken` | Someone changed the record (details carry `currentVersion` and `current`), something still links to it (details carry `references`), or the name is used |
| `413`, `415` | `media_too_large`, `unsupported_media_type` | The file is over 100 MiB or not an accepted format |
| `429` | `upstream_rate_limited` | Google is limiting Drive downloads. Try later |
| `503` | `dependency_unavailable` | A dependency, such as Google Drive or the archive folder, is unavailable |
| `500` | `internal_error` | Unexpected. Nothing was half-saved |

## Routes

`<id>` is an archive ID, from `/api/archives` or the archive selection. Record IDs may be full IDs or unique prefixes of at least eight characters, except where a full ID is stated. Changes to versioned records send `expectedVersion`, the version the contributor last saw.

### The Contributor

| Route | Purpose |
| --- | --- |
| `GET /api/me` | `{user: {id, name, avatarUrl}, isOwner, via, sessionExpires, preferences: {timeZone, dateOrder}}`. `via` is `service` for the bot |
| `PUT /api/me/timezone` | Body `{timeZone}`, a named zone such as `America/Toronto` |
| `PUT /api/me/date-order` | Body `{dateOrder}`: `ymd`, `mdy`, or `dmy` |
| `DELETE /api/me/preferences` | Clears both |
| `POST /api/me/archive-selection` | Body `{archiveId?}`. With an archive, checks access and remembers it. Without one, returns the remembered archive while the contributor can still open it. Answers `{archiveId, name}`, or `400` with reason `archive_required` |
| `GET /api/archives` | `{archives: [{archiveId, name}]}` the contributor can open. Owners see all |
| `GET /api/archives/<id>` | The archive's details: name, version, timezone, main server, lane gap, colors |

### Lookups for Commands and Autocomplete

| Route | Purpose |
| --- | --- |
| `GET /api/archives/<id>/lookup/characters?names=` | Resolves a comma-separated list of names, aliases, or `Name (shortid)` tags to `{characters: [{id, knownName}]}`. Refuses unknown or ambiguous names with a message naming them |
| `GET /api/archives/<id>/lookup/events?names=` | Resolves event titles or short IDs to `{events: [{id, title}]}` |
| `GET /api/archives/<id>/lookup/character-suggestions?typed=` | `{suggestions: [{name, value}]}` completing the last name in a comma-separated list, at most 25 |
| `GET /api/archives/<id>/lookup/search?kind=&q=&limit=` | `{items: [{id, label}]}` for `artifact`, `character`, `account`, `server`, `channel`, `event`, or `request`. Channels also have `detail`: `group chat`, `direct message`, or their server's name. `limit` from 1 to 100, default 25 |
| `GET /api/archives/<id>/lookup/names?character=&event=` | Display names by ID, repeating each parameter: `{characters: {id: name}, events: {id: title}}`. Unknown IDs map to `null` |
| `GET /api/archives/<id>/date-preview?text=` | How typed text will be read with the contributor's preferences: `{value, archiveDay, assumedZone, display}`. `display` is `{local, zone, offset}` for a date and time, which Discord may show before saving |

### Artifacts

| Route | Purpose |
| --- | --- |
| `POST /api/archives/<id>/artifacts/intake` | Adds an artifact. See [Adding an Artifact](#adding-an-artifact) |
| `POST /api/archives/<id>/artifacts/reviews/<token>/apply` | Body `{selected: [...]}`, the difference keys to apply from a duplicate reply. Only the contributor who submitted, within 15 minutes, once |
| `GET /api/archives/<id>/artifacts/<artifactId>` | The artifact with `names` for its links |
| `PATCH /api/archives/<id>/artifacts/<artifactId>` | Full ID. Body `{expectedVersion, description?, exactDate?, estimatedDate?: {day, reason} \| null, unidentifiedCharacters?, addLinks?, removeLinks?}`. Links are `{characters?, accounts?, servers?, channels?, events?}` lists of IDs |
| `DELETE /api/archives/<id>/artifacts/<artifactId>?expectedVersion=` | Permanent. Its media stays in the archive. `204` |
| `GET /api/archives/<id>/media/<mediaId>/preview` | The preview image, for a reply's embed |

### Characters, Accounts, Servers, and Channels

`<kind>` is `character`, `account`, `server`, or `channel`.

| Route | Purpose |
| --- | --- |
| `POST /api/archives/<id>/entities/<kind>` | Creates one. Characters take `{knownName, realName?, birthDay?, metInPerson?}`. Accounts take `{kind: human \| bot, label, discordId?, characterId?}`. Servers take `{label, discordId?, color?}`. Channels take `{kind, label, serverId?, parentChannelId?, discordId?, color?}` |
| `GET /api/archives/<id>/entities/<kind>/<entityId>/summary` | `{kind, id, version, createdAt, createdBy, name, fields: [[label, value]]}`, the labeled values a reply shows |
| `PATCH /api/archives/<id>/entities/<kind>/<entityId>` | Body `{expectedVersion, ...fields}`. Accounts and channels change their kind with `subkind` |
| `GET /api/archives/<id>/entities/<kind>/<entityId>/deletion-check` | `{id, deletable: true}`, or `409 reference_blocked` naming what still links to it. Run it before showing a delete confirmation |
| `DELETE /api/archives/<id>/entities/<kind>/<entityId>?expectedVersion=` | Permanent. Rechecks links. `204` |

### Events and Missing-Media Requests

| Route | Purpose |
| --- | --- |
| `POST /api/archives/<id>/events` | `{title, description, dateKind, certainty, start, end?, color?, disputedReason?, links?}` |
| `GET`, `PATCH /api/archives/<id>/events/<eventId>` | Read, or change with `{expectedVersion, ..., addLinks?, removeLinks?}` |
| `GET /api/archives/<id>/events/<eventId>/deletion-check` | As for entities. A missing-media request that uses the event as its date blocks deletion |
| `DELETE /api/archives/<id>/events/<eventId>?expectedVersion=` | Permanent. `204` |
| `POST /api/archives/<id>/requests` | `{description, characters: [ids], constraint: {kind, day?, start?, end?, eventId?}, events?, researchNotes?}` |
| `GET`, `PATCH /api/archives/<id>/requests/<requestId>` | Read, or change with `{expectedVersion, description?, constraint?, researchNotes?, addCharacters?, removeCharacters?, addEvents?, removeEvents?}`. A request's `status` is `needed` or `unrecoverable`. Moving between buckets is website-only, and a request found there is deleted, so later reads answer `404` |

### The Logs Channel

| Route | Purpose |
| --- | --- |
| `GET /api/archives/<id>/artifact-logs-channel` | `{channel: {guildId, channelId} \| null}` |
| `PUT /api/archives/<id>/artifact-logs-channel` | Body `{guildId, channelId}`. The bot checks first that it can post embeds and files there and that the contributor can see the channel. Browsers get `503`, because only the bot can check Discord |
| `DELETE /api/archives/<id>/artifact-logs-channel` | Stops future posts. `{removed}` |

### Owner Administration

These need an acting user in `ARCHIVIST_OWNER_IDS`.

| Route | Purpose |
| --- | --- |
| `POST /api/archives` | `{name}`. Creates an archive. `201` with its details |
| `POST /api/archives/register` | `{archiveId, name?}`. Hosts an archive folder already copied into the service's archives folder. `201` with `{archive, warnings}` |
| `PUT /api/archives/<id>/name` | `{name, expectedVersion}` |
| `PATCH /api/archives/<id>/settings` | `{expectedVersion, timezone?, mainServerId?, laneGapDays?, colors?}` |
| `DELETE /api/archives/<id>` | Unregisters. The folder stays. `204` |
| `GET /api/archives/<id>/members` | `{members: [{userId, grantedAt, grantedBy}]}` |
| `PUT`, `DELETE /api/archives/<id>/members/<userId>` | `{added}` or `{removed}`. Idempotent. Takes effect on that user's next request |
| `POST /api/archives/<id>/exports` | Starts an export. `202` with the job. The zip is written on the service's host, never sent |
| `GET /api/exports?limit=`, `GET /api/exports/<jobId>` | `{exports: [...]}` or one job: `{id, archiveId, archiveName, state, path, byteLength, onDisk, errorCode}`. `path` is on the service's host |

### Announcements

These act for nobody, so they take the token without `X-Archivist-User`.

| Route | Purpose |
| --- | --- |
| `POST /api/service/announcements/claim` | Body `{archiveId?, artifactId?, limit?}`, limit from 1 to 25, default 10. `{items: [...]}`, see [Posting Announcements](#posting-announcements) |
| `GET /api/service/announcements/<id>/<artifactId>/preview` | The preview image of a claimed post |
| `POST /api/service/announcements/<id>/<artifactId>/result` | Body `{claimId, state: sent \| failed \| indeterminate, messageId?, reason?}`. `messageId` is required for `sent`. `204`. Repeating the same report is harmless. A conflicting report or an older claim answers `409` with reason `stale_claim` |

## Flows

### Adding an Artifact

1. Resolve the archive with `POST /api/me/archive-selection`, and the typed characters and event with the lookup routes. A refusal there is the reply.
2. A time without a zone is read in the contributor's timezone, falling back to the archive's. The bot may call `GET /date-preview` and show `display` before saving. Since 2026-11-25 the service no longer requires `zoneConfirmed`, and it ignores the field when sent.
3. Send `POST /artifacts/intake` as `multipart/form-data`, every field before the file:
   * `description`, and optionally `exactDate`, `estimatedDay` with `estimateReason`, and repeated `characters` and `events` IDs.
   * For an attachment, `discordAttachmentId` (the attachment's ID, its identity for duplicates) and `discordAttachmentUrl` (kept without its query), then the bytes as `file` with the attachment's file name. The bot downloads the attachment from Discord and streams it on.
   * For a Drive link, `driveLink` and no file. The service downloads it.
   * `submissionGuildId`, `submissionChannelId`, and `submissionMessageId` where known.
4. A `201` reply is `{status: "created", artifact, announcement: {status}}`. `queued` means the bot will post it. Claim it right away with `{archiveId, artifactId}`, post it, and report, so the reply can say whether it was announced.
5. A `200` reply with `status: "duplicate"` carries the existing `artifact`, the `differences`, and a `reviewToken` (null when nothing differs). Show the differences as choices and send the ticked keys to the review's apply route. Nothing is saved before that.

Only the bot may send the `discordAttachment*` and `submission*` fields. A browser that sends them gets `403`.

### Posting Announcements

Every new artifact, from the website or Discord, queues a post when its archive has a logs channel. Each claimed item is:

```json
{
  "archiveId": "…",
  "artifactId": "…",
  "claimId": "…",
  "channel": { "guildId": "…", "channelId": "…" },
  "archiveName": "…",
  "archiveTimeZone": "America/Toronto",
  "artifact": { "id": "…", "description": "…", "dates": {}, "links": {}, "media": {} },
  "characterNames": ["…"],
  "previewPath": "/api/service/announcements/…/…/preview"
}
```

`artifact` and `characterNames` are as the artifact was submitted, so a delayed post shows the upload rather than later edits.

The bot polls `claim` every few seconds while it is connected, posts each item, and reports its result with the item's `claimId`:

* `sent` with the message ID once Discord accepts the message.
* `failed` when Discord definitely refused it, such as a missing permission.
* `indeterminate` when the outcome is unknown, such as a timeout after sending. It is never sent again.

A claim the bot does not report on within ten minutes becomes indeterminate. Queued posts wait while the bot is offline, and the website keeps working.

### Deleting

Call the deletion check first and show the confirmation only when it passes. Send the delete with the version the contributor saw. The delete checks links again.
