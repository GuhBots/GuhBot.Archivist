# Tests

Automated tests for the Archivist service, run with the Node.js built-in test runner. `tsconfig.test.json` compiles `src/` and `tests/` together into the ignored `.test-build/` directory, so tests import source files with the same `.js` extensions the service uses.

## Layout

| Path | Contents |
| --- | --- |
| `archivist/core/` | Archive storage, migrations, and shared rules, tested against temporary databases and folders |
| `archivist/web/` | The website's listener, sign-in, and routes, with Discord and Google Drive replaced by stand-ins |
| `archivist/helpers/` | Shared test helpers, such as temporary directories that are removed after each test |

The `archivist/` tests came from GuhBot.Discord with the code they cover. The Discord adapter tests stayed in the bot.

## Running Tests

Run the commands from the repository root. Each one compiles the tests first.

| Command | Purpose |
| --- | --- |
| `npm test` | Run every suite |
| `npm run test:core` | Run the archive core suite |
| `npm run test:web` | Run the website suite |

`npm run check` also type checks the tests.

Tests create their own temporary databases and folders and never read `.env` or `data/`. Name test files `<subject>.test.ts`.
