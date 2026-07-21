# Third-Party Licenses

Tonedrop is distributed as an Electron application that bundles its production
dependencies. This file records those dependencies and their licenses, and
provides the attribution required by Apache-2.0 §4(d) for the components
licensed under those terms.

Tonedrop itself is MIT licensed — see [LICENSE](LICENSE).

## Apache-2.0 components

The following components are licensed under the Apache License, Version 2.0.
You may obtain a copy of the license at
<http://www.apache.org/licenses/LICENSE-2.0>.

- **usbmux-client** — Copyright © Tim Perry / HTTP Toolkit
- **@httptoolkit/util** — Copyright © Tim Perry / HTTP Toolkit

Unless required by applicable law or agreed to in writing, software
distributed under the Apache License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

## Full dependency list

| Package | Version | License |
| --- | --- | --- |
| @borewit/text-codec | 0.2.2 | MIT |
| @httptoolkit/util | 0.1.9 | Apache-2.0 |
| @tokenizer/inflate | 0.4.1 | MIT |
| @tokenizer/token | 0.3.0 | MIT |
| @xmldom/xmldom | 0.8.13 | MIT |
| base64-js | 1.5.1 | MIT |
| big-integer | 1.6.52 | Unlicense |
| bplist-parser | 0.3.2 | MIT |
| content-type | 1.0.5 | MIT |
| debug | 4.4.3 | MIT |
| file-type | 21.3.4 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| media-typer | 1.1.0 | MIT |
| ms | 2.1.3 | MIT |
| music-metadata | 11.12.3 | MIT |
| plist | 3.1.0 | MIT |
| strtok3 | 10.3.5 | MIT |
| token-types | 6.1.2 | MIT |
| uint8array-extras | 1.5.0 | MIT |
| usbmux-client | 0.2.1 | Apache-2.0 |
| win-guid | 0.2.1 | MIT |
| xmlbuilder | 15.1.1 | MIT |

Regenerate with `npm ls --all --omit=dev`.

## A note on the device protocols

Tonedrop speaks Apple's usbmux, lockdown, and AFC protocols. The implementations
in `src/` are original work written against observed protocol behaviour and
public documentation. No code is derived from libimobiledevice or any other
copyleft-licensed project, and no Apple-proprietary code, headers, libraries,
or certificates are embedded or redistributed.

The app invokes macOS system tools (`afconvert`, `afinfo`, `plutil`) at runtime
rather than bundling them, and authenticates using the pairing record the user's
own machine created when they tapped "Trust This Computer" — it does not
circumvent any protection mechanism.
