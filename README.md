# Eagle Window 视频分析：实验 A

状态：代码准备与本地检查阶段；真实 Eagle Window 验收尚待执行。实验 B 未启动。

## 目标与假设

验证选中一个 MP4 → Window 插件读取 ID/路径 → 播放/暂停/秒数定位 → 读取时间标注 → 标注定位。
获得具体授权后，再验证一条测试标注添加、独立读回与原生界面显示，最后按获准范围回退。

依据是官方文档，不是已完成的运行结论：

- [Window](https://developer.eagle.cool/plugin-api/get-started/plugin-types/window)：独立网页窗口。
- [item](https://developer.eagle.cool/plugin-api/api/item)：getSelected、getById、filePath/fileURL、Build22+ comments/标注方法。
- [manifest](https://developer.eagle.cool/plugin-api/tutorial/manifest)：入口与窗口配置。
- [Node.js 内置 API](https://developer.eagle.cool/plugin-api/tutorial/node-js-native-api)：无需下载依赖的文件操作。

不假设原生播放位置同步。不验证缓存性能，不宣称逐帧精度。自定义时间轴当前在拖动松手后定位。

## 文件与技术

- `manifest.json`：告诉 Eagle 打开 `index.html`；不自动启动，不开多个实例。
- `index.html`：HTML 摆放视频、秒数输入、时间轴和标注；少量 CSS 仅用于可读性。
- `app.js`：JavaScript 响应事件，调用 API。搜索 `核心入口` 可找到 `eagle.onPluginCreate`，类似蓝图的启动事件。
- `app.js` 中 `loadSelected` 读取素材；`mediaURL` 处理路径；`seek` 设置当前秒数；`renderComments` 显示标注；`addComment/removeComment` 是受保护的元数据操作。
- `<video>` 使用 Eagle 窗口的媒体能力解码播放。即使扩展名是 MP4，具体编码是否能解码仍须实际验证。
- Node.js 内置 `fs/path/url/crypto` 负责实验文件、路径转换和唯一测试编号；不安装第三方依赖。
- `check.cjs`：本地输入/权限边界检查，不连接 Eagle。
- `AGENTS.md`：开发权限与停止条件。`RECORD.md`：结果、证据、已验证/未验证的区别。
- `.gitignore`：运行证据和授权文件保留在本机，不进入 Git。Git 只记录代码与文档，不连接远程。

## 只读验收操作

1. 在 Eagle 中选择一条专用测试 MP4，最好已有时间标注，实际文件路径含中文及空格。不要为了本次实验改真实收藏素材。
2. 在 Eagle 插件面板的开发者功能中选择“导入本地项目”（具体按钮以本机界面为准），选择**本目录**。若界面只要求清单，选择本目录 `manifest.json`。不要打包安装或复制到安装目录。
3. 打开“视频分析 PoC A（默认只读）”。检查素材 ID、路径、API 可用性和状态。如果当前选择为空，重新选择后点击读取按钮。
4. 点击播放、暂停。输入一个中间秒数并定位，观察画面；再测试 0 秒及接近结尾。日志中的 `seek-request` / `media-seeked` 说明请求和媒体事件，不能单独证明画面正确。
5. 查看已有标注列表和轴上 ▼；点击不同标注，观察是否定位到对应内容。标注为空只证明空数组读取，不能算已有标注定位通过。
6. 在人工观察中填入画面检查结果，点击“保存当前证据”。输出为本目录 `evidence/session-*.json`。这些文件包含路径与标注，仅保存在本机。
7. 向 Codex 报告是否正常，以及保存的证据文件名。Codex 读取证据后更新记录。无需用户使用终端。

如果没有合适的专用素材，先反馈；导入副本和创建准备标注都需要单独授权，当前代码不会自动执行。

## 写入必须另行确认

当前没有 `write-approval.json`，写入和回退按钮默认禁用。

1. 只读验收后，暂停到测试时间，点击“暂停并准备写入提案”。这一步只生成本目录 `evidence/proposal.json` 和会话证据，不修改 Eagle。
2. Codex 读取提案，在聊天中展示精确的素材 ID、路径、时间、唯一文本，取得添加及回退删除的明确授权。授权文件由 Codex 在确认后创建；用户不用编辑 JSON。
3. 保持窗口和当前提案，点击“检查授权文件”。不要重新准备提案；更换提案会使旧授权失效。
4. 写入前手动打开同一测试素材的原生播放器，保持该视图打开；插件仍停在获准时间。点击添加按钮，只执行一次。
5. 插件先保存原有标注快照及持久化尝试记录，再调用 addComment；保存返回的标注 ID，重新 getById 验证数据。失败不会自动重试，需核对是否已提交。
6. 不切换原生素材视图，观察约 5 秒，记录是否出现标注；这是人工观察窗口，不是精确刷新延迟测量。随后关闭并重新打开素材，再记录是否显示。
7. 原生检查结束后保存证据。在已授权删除的情况下，点击回退；只删除回执中那条 ID 且内容未变的测试标注，重新读取确认，并在 Eagle 中复查。

授权文件形状仅供理解（现在不创建）：`proposalId/itemId/filePath/seconds/annotation` 与提案完全相同，加 `allowAdd: true`，以及按授权决定的 `allowRemove`。

如果插件重启导致内存提案丢失，先交由 Codex 核对磁盘回执；不要重新添加以替代核对。
回退只清除本次标注，不能保证恢复素材修改时间；不覆盖旧标注数组，也不直接写 metadata.json。

## 诊断与成功标准

| 现象 | 先检查 | 所需证据 |
| --- | --- | --- |
| 窗口不出现或停在启动提示 | 本地项目导入、manifest、启动脚本 | Eagle 提示/窗口状态；必要时 F12 Console 错误 |
| 读不到 ID 或路径 | getSelected 返回、是否只选一个 MP4 | selected-file 或阶段错误 |
| 路径正确但视频不播放 | fileURL、文件访问、编码解码 | media-error、loadedmetadata、实际画面 |
| 有标注但定位不对 | comments 的 duration、目标秒数、seeked、画面 | 原始 comments + 定位事件 + 人工观察 |
| 添加后读回没有标注 | addComment 返回、再次 getById、素材身份 | before/attempt/receipt/session 证据 |
| API 读回有、原生没显示 | 即时与重开分别检查 | 用户观察，不把它判为写入 API 失败 |

A1 通过需要真实 Window 读取、实际播放/暂停/定位，以及中文/空格真实路径验证。
A2 读取/显示/定位、获准添加/独立读回、原生即时/重开显示分项报告。即时刷新不通过不等于数据读写失败。
本地检查或代码完成均不代表实验 A 通过。完成 A 后停止。

## 开发检查与资源边界

在本目录运行 `node check.cjs`。只用现有 Node 与 Git；不下载、不生成视频或预览缓存。
内存诊断日志保留最近 300 条；会话证据覆盖同一会话文件，标注操作保留各自凭据。
仅在本目录写文件；不向网络发送素材。实验期保留证据，不自动清理，不提供目录外删除命令。
