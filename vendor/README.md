# Third-party programs bundled with the Printer App

## SumatraPDF 3.6.1 (64-bit)

`SumatraPDF-3.6.1-64.exe` sends PDFs and images to the Windows print queue
(`src/printing/windows-printer-adapter.ts`). `pkg` embeds it in
`PrintSetuAgent.exe` (see `pkg.assets` in `package.json`), and the agent
copies it out to `%TEMP%\printsetu-agent\` the first time it prints.

- Source: https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip
  (official portable build, Authenticode-signed by Krzysztof Kowalczyk)
- SHA-256 of the zip: `98b33a518d42986856d225064b0cd2d3643ecf78cbf84ab873d26cc51877a544`
- SHA-256 of the exe: `719f689b34f47be8ca105ce8484948474dafde0e106bab599e4a89326070c3d0`
- License: GNU GPL v3 (`SumatraPDF-LICENSE.txt`, which the Windows installer
  also installs). Source code: https://github.com/sumatrapdfreader/sumatrapdf

### Upgrading

1. Download the new `SumatraPDF-<version>-64.zip` from
   https://www.sumatrapdfreader.org/download-free-pdf-viewer and unzip the exe here.
2. Update `SUMATRA_ASSET` in `src/printing/windows-printer-adapter.ts`, the
   `pkg.assets` entry in `package.json`, and this file. Delete the old exe.
3. Test on a real Windows printer: B&W, duplex, A4/Legal, copies, a large
   PDF and a JPG/PNG.
