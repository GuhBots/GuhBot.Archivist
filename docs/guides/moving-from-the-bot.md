# Moving From the Bot

Archivist used to run inside the Discord bot, which kept the archives in its own data folder and Archivist's settings in its `guhbot.db`. This guide moves them to the Archivist service once, without changing any archive. Afterwards only the service writes archives, and the bot calls its API.

## What Moves

| From the bot's data folder | To Archivist's data folder | How |
| --- | --- | --- |
| `archives/<archive ID>/` | `archives/<archive ID>/` | Copied by hand, unchanged. Archive IDs, schema versions, media, and edit logs stay as they are |
| Archivist's tables in `guhbot.db` | `operational.db` | `import-bot-state` copies the registry, whitelists, contributors' timezones, date orders, and remembered archives, logs channels, announcement history, and export history |
| `archivist-exports/` | Optional | Finished zips can stay where they are. Copy them only if you want them on the new host |

Sign-in sessions are not copied, so everyone signs in again. AFK data and the rest of the bot's state stay in the bot's `guhbot.db`. A post the bot was sending becomes indeterminate and is never resent, and an export it was writing is marked failed, as a bot restart would leave them.

## Before You Start

* Archivist is deployed and configured as [Self-Hosting](self-hosting.md) describes, but nobody uses it yet.
* The bot that runs Archivist today is the version that still has its own website. Note which data folder it uses, such as `data/` or the container's `/data` volume.
* Rehearse on copies first. Nothing here changes the bot's files, so a failed rehearsal is repaired by deleting Archivist's data and starting again.

## Steps

1. **Stop archive changes in the bot.** Stop the bot, or at least make sure nobody adds or edits archives, since anything changed in the bot after the copy would be lost. Never let both write archives.
2. **Copy the archive folders.** Copy each `archives/<archive ID>/` folder from the bot's data folder into Archivist's data folder, keeping the folder names. With the default Compose volumes on one machine, for example:

   ```sh
   docker compose -f <bot folder>/compose.yaml run --rm --no-deps -u root -v "$PWD/handoff:/out" app \
     sh -c 'cp -a /data/archives /out/ && cp /data/guhbot.db /out/'
   docker compose cp handoff/archives app:/data/
   docker compose exec -u root app chown -R app:app /data/archives
   ```

   Files copied into a container belong to root, so the last command gives them back to the service's user. Copy `guhbot.db` while the bot is stopped, so it is a consistent file.
3. **Import Archivist's settings.** Run the import against the copy of `guhbot.db`. It opens that file read-only.

   ```sh
   docker compose cp handoff/guhbot.db app:/tmp/guhbot.db
   docker compose exec app node apps/server/build/service/main.js import-bot-state /tmp/guhbot.db
   ```

   From a clone of this repository, `npm run import-bot-state -- <path to guhbot.db>` does the same with the `DATA_DIR` in `.env`.
4. **Read the import's report.** It lists the rows it copied. Fix anything it names before going on:
   * An archive whose name another archive already uses was skipped with its whitelist. Rename one of them in the bot's copy or in Archivist, then run the import again. Rows already copied are kept, so a repeat is safe.
   * A registered archive whose folder is missing needs its folder copied as in step 2.
5. **Check the result.** Restart Archivist with `docker compose restart`. Sign in to the website as an owner and open each archive: the artifacts, characters, and events should all be there. Ask a contributor to sign in and check that they see their archives.
6. **Switch the bot.** Update the bot to the version whose Archivist commands call the API, set `ARCHIVIST_API_URL` and `ARCHIVIST_SERVICE_TOKEN` as [Connecting the Bot](connecting-the-bot.md) describes, and start it. Run `/archivist-admin status`, then add a test artifact with `/archive artifact add` and check that it appears on the website and in the logs channel.
7. **Keep the backup.** Keep the bot's original data folder until you are sure everything moved. Once Archivist has accepted changes, going back means copying Archivist's archives back, because the old copy is out of date.

## Afterwards

The bot no longer needs its `archives/` folder or Archivist's tables in `guhbot.db`. They are harmless where they are. Delete them only after a backup of Archivist's data volume exists, as [Self-Hosting](self-hosting.md#data-and-backups) describes.
