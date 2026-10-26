# vendor

| 文件 | 来源 | 版本 | 许可 | SHA-256 |
| --- | --- | --- | --- | --- |
| `three.min.js` | https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.min.js | three.js r159 | MIT | `7B1C5D75B28D9DE15042E2B374F83566D8C7146697AF8FDEB4558B0FB528A585` |

选 r159 是因为它是最后一个带“普通脚本版”的版本，页面不需要服务器，双击就能打开。加载时控制台会打印一条该文件自带的弃用提示（`build/three.min.js` 将在 r160 移除），不影响使用。

以后如果要换成 ES 模块版的新 three.js，需要起一个本地服务器（浏览器不允许从 `file://` 加载模块），或者把代码打包成一个脚本。
