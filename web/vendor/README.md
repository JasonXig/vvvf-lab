# vendor

| File | Source | Version | License | SHA-256 |
| --- | --- | --- | --- | --- |
| `three.min.js` | https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.min.js | three.js r159 | MIT ([LICENSE-three.txt](LICENSE-three.txt)) | `7B1C5D75B28D9DE15042E2B374F83566D8C7146697AF8FDEB4558B0FB528A585` |

r159 was chosen because it is the last version that ships a "plain script build", so the page needs no server and opens with a double-click. When loaded, the console prints one deprecation notice that comes with the file itself (`build/three.min.js` will be removed in r160); it does not affect anything.

If you later want to switch to a newer ES-module build of three.js, you will need a local server (browsers do not allow loading modules from `file://`), or bundle the code into a single script.
