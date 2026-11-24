# Archivist Website

The frontend of Archivist's website, built with React, Vite, and Tailwind into `dist/`. The [Archivist service](../server/README.md) serves it, along with the JSON routes in [`src/archivist/web/`](../server/src/archivist/web/README.md). It follows the prototype the owner approved, recorded in the plan's prototype review decisions. It came from `web/` in GuhBot.Discord at commit `2e7c752`.

| Path | Contents |
| --- | --- |
| `index.html` | The page every address loads. The server adds a `<base>` tag for the path the website lives under |
| `src/main.tsx`, `src/App.tsx` | Sign-in, choosing an archive, and the archive's shared state |
| `src/Shell.tsx` | The top bar, the place and character columns, the account menu, search, and windows over the page |
| `src/views/` | One file per view: timeline, album, places, graph, heatmap, board, and the character page |
| `src/modals/` | Windows such as an artifact's details, adding an artifact, filters, the calendar, and place editing |
| `src/components/` | Pieces several views share, such as pictures, pickers, and typed dates |
| `src/api.ts` | Calls to the website's own routes. Response types come from the server workspace's code |
| `src/router.ts` | Addresses under the base path, such as `/a/<archive>/album` |
| `src/styles.css` | The approved prototype's styles: flat, dark, and responsive |

## Building

From the repository root, `npm run build` compiles the server and then this frontend. To build only the frontend:

```sh
npm run build --workspace apps/web
```

`npm run check` type checks it with `apps/web/tsconfig.json`.

## Trying It Without Discord

[`tests/archivist/e2e/serve.ts`](../server/tests/archivist/e2e/serve.ts) serves the built website on a made-up archive and prints session cookies, so a browser can sign in without Discord. From the repository root:

```sh
npm run build && npm run build:tests --workspace apps/server
node apps/server/.test-build/tests/archivist/e2e/serve.js 3100 /archivist
```

Set the printed `member` or `owner` value as the `archivist_session` cookie for `127.0.0.1`, then open the printed address.

## Per-Viewer Settings

The timeline's lane order, hidden lanes, zoom, and marker layers, the album's sort and tile size, and the last archive and timeline position are kept in the browser's storage. They change only that viewer's view and are not archive data.

## Places

A server's page shows its artifacts oldest first, with channel filters and a channel-lane view. Group chats show the same historical list. Channel lanes group artifacts by day, week, or month to keep dots apart. They draw up to the first 2,000 matching artifacts and state when that limit is reached. The paged list retains access to every matching artifact.

Edit Place changes the base name, Discord ID, lane color, dated names, and server icons or the group chat's current icon. It also adds, renames, and deletes a server's channels. Each save checks the current version. A stale save reloads the record for review.

## Heatmap

The heatmap shows a selected year's artifacts and event starts in separate monthly calendars. A duration or occurrence window counts once, on its start or earliest possible day. Dashed outlines identify estimates and file dates. Undated artifacts are counted separately. The tray changes the year, cell size, and shared filters. Selecting a day opens the timeline with those filters.

## Graph

Characters are nodes, with a picture when one is known. The tray toggles four layers: shared artifacts, shared events, introductions, and servers where both were members at the same time. A membership with no join date is left out, and one with no leave date continues. The tray also hides pairs with fewer than one, three, or five shared artifacts. The layout is the approved deterministic one in `src/views/graph-layout.ts`: every pair pushes apart and each visible connection pulls its pair together, so the same data always draws the same picture. The pull only places nodes, and no strength score is shown. Large archives take fewer layout steps so the page stays responsive.

Pointing at a character lights up their connections. Selecting one focuses it and links to their page. Selecting a line opens an album of the artifacts the two share under the current filters, or lists the events, introductions, and memberships that connect them when they share none. The wheel or a pinch zooms around the pointer, dragging pans, and the tray zooms out, in, and to fit. `/a/<archive>/graph?focus=<character>` opens it focused on a character.

## Board

The research board lists missing-media requests and gap cards in Needed, Resolved, and Unrecoverable, highest priority first. Gap cards that follow the data clear by themselves. Date-research flags are marked done by hand. A request moves to Unrecoverable with a reason, resolves when a contributor links the artifact that has the media, including from Unrecoverable, and can be reopened. The tray adds a request, flags an artifact's date for research, and shows all cards, only requests, or only gaps. Nobody is assigned anything.

## Character Page

A character's page shows their facts, picture, aliases, main accounts, each account's dated names, avatars, and memberships, who introduced them and whom they introduced, and their artifacts and events. The picture is the latest one known and says where it comes from. Selecting it opens every picture they have had, oldest first, with arrow keys to step through. Originals are shown, so GIF avatars play.

Edit History adds and removes dated entries, saves the facts, uploads avatars and the fallback picture, links an existing account or adds a new one, and merges a duplicate character after reviewing every difference. Each change checks the version just loaded. An introduction this character made is changed on the page of the character who was introduced. The tray shows the character on the timeline or the graph.
