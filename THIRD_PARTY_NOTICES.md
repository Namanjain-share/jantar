# Third-party notices

Jantar is built with ideas and, where noted, code from the open-source
projects below. Every file that contains adapted code starts with

    // Portions adapted from <project> (c) <holder>, MIT. See THIRD_PARTY_NOTICES.md

and has a row in `docs/PROVENANCE.md` (our file, upstream file, commit,
changes). `pnpm lint:provenance` checks that both exist. Files from Noblot
(below) name its author, the licensor in `LICENSE`, with no license name:
they come under this repository's `LICENSE`.

## Projects code may be adapted from (MIT)

The commit listed is the one reviewed while designing Jantar; the commit a
file was actually copied from is recorded per file in `docs/PROVENANCE.md`.

| Project | Upstream | Copyright holder | Reviewed commit |
|---|---|---|---|
| Shed | https://github.com/IAmUnbounded/shed | Sukhad Anand | `44fc121a1266` |
| Happy | https://github.com/slopus/happy | Happy Coder Contributors | `2cab104da578` |
| Orca | https://github.com/stablyai/orca | Lovecast Inc. | `abbea996d0a4` |
| CC Pocket | https://github.com/K9i-0/ccpocket | K9i | `0ee5387b1b62` |
| claude-control | https://github.com/sverrirsig/claude-control | the claude-control authors (the upstream LICENSE names no holder) | `58ee685f2842` |
| claude-code-monitor | https://github.com/onikan27/claude-code-monitor | onikan27 | `74d82696d56f` |
| Noblot | the maintainer's earlier private project (not published); its author relicenses these files under this repository's `LICENSE` (not MIT) | Naman Jain, the licensor in `LICENSE` | `c84299e` | <!-- jantar-secrets-allow: the licensor, as in LICENSE -->

## Ideas only (no code copied)

These projects informed the design. No code, comments or identifiers were
taken from them; features inspired by them are implemented clean-room from
our own specs (for hooks: `docs/hook-protocol.md`).

- Open Vibe Island (GPL)
- HAPI (AGPL)
- CloudCLI / claudecodeui (AGPL)
- Port22 (closed source; only its public website was read)

v0.5's Chrome extension (packages/extension) is written fresh. These
caption-saving extensions (all MIT) were read for how Meet and Teams draw
their live captions and how a line grows and settles; no code was copied:

- TranscripTonic (https://github.com/vivek-nexus/transcriptonic)
- MS Teams Live Captions Saver (https://github.com/Zerg00s/Live-Captions-Saver)
- Meeting Transcripts (https://github.com/saigonosenpai/meet-transcripts-chrome-extension)
- Google Meet Captions Exporter (https://github.com/nikooo777/google-meet-captions-exporter)
- meet-caption-log-extension (https://github.com/yhotta240/meet-caption-log-extension)

## External tools used, not vendored

- **cswap / claude-swap** (MIT, https://github.com/realiti4/claude-swap): used
  through its command line and by reading its data files. None of its code is
  included.
- **Claude Code** (Anthropic): Jantar works with its hook interface and file
  formats. None of its code is included.

## npm runtime dependencies

Installed from npm and not modified. Their licenses ship inside each package.

| Package | License |
|---|---|
| fastify, @fastify/websocket, @fastify/static, @fastify/cookie | MIT |
| zod | MIT |
| ulid | MIT |
| web-push | MPL-2.0 (used unmodified) |
| react, react-dom | MIT |
| zustand | MIT |
| qrcode | MIT |
| @base-ui/react | MIT |
| motion | MIT |
| @phosphor-icons/react | MIT |
| cmdk | MIT |
| clsx | MIT |
| @fontsource-variable/archivo (Archivo font) | OFL-1.1 |
| @fontsource-variable/jetbrains-mono (JetBrains Mono font) | OFL-1.1 |
| prismjs (v0.3 Files viewer: syntax highlighting, in a worker) | MIT |
| @tanstack/react-virtual, @tanstack/virtual-core (v0.3: long files and lists) | MIT |
| pdfjs-dist (v0.3 Files viewer: PDFs, loaded on demand, with its worker) | Apache-2.0 |
| @date-fns/tz (v0.4 Life: wall-clock times in a time zone; by Sasha Koss) | MIT |
| ws (v0.6 Fleet: a server's link to the Mac) | MIT |
| playwright-core 1.63.0 (v0.8 Intel: the headless browser tier drives the Mac's own Chrome; imported only when that tier runs; it downloads no browser for Jantar) | Apache-2.0 |

### pdf.js's standard fonts

The web build ships the 14 standard font files from `pdfjs-dist/standard_fonts/`
unmodified, as separate files in `packages/web/dist/assets/` (about 788 KB,
fetched only when a PDF names one of the base-14 fonts without embedding it,
and never precached by the service worker). `dist/` is built on your Mac and is
not part of this repository.

| Files | Copyright | License |
|---|---|---|
| `FoxitDingbats.pfb`, `FoxitFixed*.pfb`, `FoxitSerif*.pfb`, `FoxitSymbol.pfb` | PDFium Authors | BSD-3-Clause style (`LICENSE_FOXIT`, text below) |
| `LiberationSans-Regular.ttf`, `-Bold`, `-Italic`, `-BoldItalic` | Red Hat, Inc. and others | GNU GPL v2 with the font exception (`LICENSE_LIBERATION` in `pdfjs-dist/standard_fonts/`): a document that uses or embeds the fonts is not covered by the GPL by that alone. "Liberation" is a Red Hat trademark; the files are shipped unmodified under their own names |

### Optional native module: @napi-rs/canvas

`pdfjs-dist` lists `@napi-rs/canvas` (MIT) as an optional dependency for
rendering under Node, so pnpm installs it, with its platform binary
(`@napi-rs/canvas-darwin-arm64` on Apple silicon), under `node_modules`.
Jantar never runs pdf.js under Node, and the browser never loads it: the only
trace in the web build is the module name inside pdf.js's Node-only canvas
factory, which the browser never calls, and no `.node` binary is emitted into
`dist/`.

Development tools (TypeScript, Vite, Tailwind CSS, Vitest, tsx, Testing
Library, jsdom, playwright-core, esbuild, @types/chrome and their
dependencies) are used to build and test Jantar and are not shipped in it;
their licenses are in their packages. esbuild (MIT) bundles the Chrome
extension's own code only: the extension ships no third-party code.
playwright-core (Apache-2.0) drives a headless Chromium in the browser checks
of `test/integration`; the browser is downloaded by its installer and is not
part of this repository. Since 0.8 playwright-core is also a runtime
dependency of the daemon (above), where it drives only the system Chrome.
yt-dlp (Unlicense), which 0.8 can use when you installed it yourself, is
not bundled or installed by Jantar.

## License texts

### Noblot

`packages/life-core/src/{adherence,meds,recurrence,recurrence-rule}.ts` and
their tests in `packages/life-core/test/` come from Noblot, the maintainer's
earlier private project. Its author relicenses these files under this
repository's `LICENSE`, the same terms as the rest of Jantar (they are not
MIT-licensed); `docs/PROVENANCE.md` lists each file, the Noblot commit and
what changed.

### Shed (IAmUnbounded/shed)

```
MIT License

Copyright (c) 2026 Sukhad Anand

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Happy (slopus/happy)

```
MIT License

Copyright (c) 2026 Happy Coder Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Orca (stablyai/orca)

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### CC Pocket (K9i-0/ccpocket)

```
MIT License

Copyright (c) 2026 K9i

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### claude-control (sverrirsig/claude-control)

```
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### claude-code-monitor (onikan27/claude-code-monitor)

```
MIT License

Copyright (c) 2026 onikan27

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### pdf.js standard fonts: Foxit (pdfjs-dist/standard_fonts/LICENSE_FOXIT)

```
Copyright 2014 PDFium Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

