# vendor

| File | Source | Version | License | SHA-256 |
| --- | --- | --- | --- | --- |
| `three.min.js` | https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.min.js | three.js r159 | MIT ([LICENSE-three.txt](LICENSE-three.txt)) | `7B1C5D75B28D9DE15042E2B374F83566D8C7146697AF8FDEB4558B0FB528A585` |
| `fonts/InstrumentSans-latin.woff2` | https://fonts.gstatic.com/s/instrumentsans/v4/pxiTypc9vsFDm051Uf6KVwgkfoSxQ0GsQv8ToedPibnr0SZe1Q.woff2 (the Latin subset Google Fonts serves; one variable file, weights 400 to 700) | Instrument Sans v4 | SIL OFL 1.1 ([fonts/OFL-InstrumentSans.txt](fonts/OFL-InstrumentSans.txt), from https://github.com/Instrument/instrument-sans) | `2EE17598A98D8A59E4DF8152D015BEC9AB8E4D5672CC0AB42BEF806B568E3971` |

The font is the page's only typeface. It is kept here so the page looks the same on every system, works offline, and asks no other server for anything.

r159 was chosen because it is the last version that ships a "plain script build", so the page needs no server and opens with a double-click. When loaded, the console prints one deprecation notice that comes with the file itself (`build/three.min.js` will be removed in r160); it does not affect anything.

If you later want to switch to a newer ES-module build of three.js, you will need a local server (browsers do not allow loading modules from `file://`), or bundle the code into a single script.
