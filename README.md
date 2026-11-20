# PrintSetu Printer App

The small program a print shop installs on the computer connected to its
printer. When a customer sends a document to the shop through
PrintSetu and the shop accepts it, the Printer App
downloads the file and prints it — no USB stick, email or WhatsApp needed.

Works on **Windows 10/11** and **Linux** (Ubuntu, Debian, Mint, Fedora and
others that print through CUPS).

> This repository contains only the Printer App. The PrintSetu website and
> server are separate and not open source. The Printer App needs a PrintSetu
> shop account to do anything.

## What it does on a shop's computer

- Connects to the PrintSetu server with its own ID and secret key, which it
  gets once, when the shopkeeper types a setup code into the installer.
- Waits for print orders that the shop has accepted, downloads each file over
  HTTPS, prints it with the chosen paper size, colour, sides and copies, and
  reports back: printing → printed (or why it failed).
- Tells PrintSetu which printers the computer has and whether it is online.
- Updates itself. Updates come only from the PrintSetu server and are
  installed only when their SHA-256 checksum matches.
- Deletes each downloaded file as soon as it has printed (or failed to).

It does not read other files on the computer, and it accepts no incoming
connections: it only connects out to the PrintSetu server.

## Installing (for shops)

Download it from your PrintSetu shop dashboard: **Printer App → Download**.
Follow the three steps on that page. Don't install a copy built by someone
else.

## Building it yourself

You need Node.js 20.

```bash
npm ci
npm test                 # unit tests
npm run build            # TypeScript → dist/
npm run build:exe:all    # release/PrintSetuAgent.exe and release/printsetu-agent-linux
```

The Windows installer (`release/installer/PrintSetu-Setup.exe`) is built
with Inno Setup in Docker. The server address is fixed in the installer at
build time:

```bash
npm run build:exe && npm run package
PRINTSETU_BACKEND_HTTP_URL=https://your-printsetu-server/api npm run build:installer
```

Optional code signing: `scripts/sign-windows.sh` (see the comments in it).

### Running it while developing

Copy `.env.example` to `.env`, point it at a PrintSetu server you run, and
use the mock printer so nothing really prints:

```bash
PRINTSETU_PRINT_DRIVER=mock npm run dev
```

## How the code is organised

| Folder / file | What it is |
|---|---|
| `src/index.ts` | Starts everything, checks for updates |
| `src/socket-client.ts`, `src/http-client.ts` | Talking to the PrintSetu server |
| `src/job-processor.ts`, `src/job-state.ts` | Taking an order from "assigned" to "printed" |
| `src/printing/` | Windows (via SumatraPDF) and Linux/CUPS printing |
| `src/updater.ts` | Automatic updates with checksum check |
| `service/` | Windows and Linux install/uninstall scripts |
| `installer/windows/` | The Inno Setup installer |
| `vendor/` | Bundled SumatraPDF (see `vendor/README.md`) |

## Reporting problems

- A bug or a printer that doesn't work: open an issue with your operating
  system, printer model and what happened. Remove any customer documents or
  personal details first.
- A security problem: see [SECURITY.md](SECURITY.md) — please don't open a
  public issue.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

The bundled SumatraPDF is a separate program under the GNU GPL v3
([vendor/SumatraPDF-LICENSE.txt](vendor/SumatraPDF-LICENSE.txt)).

"PrintSetu" and the PrintSetu logo are trademarks of PrintSetu and are not
covered by the licence. If you publish a modified version, give it a
different name.
