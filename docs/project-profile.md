# 项目说明

## 身份与入口

- 项目：Eagle Window 视频分析插件。产品规格v1及补充、架构v1、3C工程文档已批准；用户整体授权阶段4。T1用户体验与真实Eagle六轮早期技术关卡通过，保留体验节点并固定`phase4-t1-early-verified`；当前推进T2，见[技术收尾](progress.md#阶段-4-t1真实测量核对与技术收尾)。
- Git 根目录：eagle-video-analysis/；只有一个 .git，不在父级或原型内初始化新仓库。
- 正式Eagle入口：plugin/manifest.json，main.url为同目录index.html。prototypes/window-player/manifest.json仅保留A/B历史原型入口。
- S1 入口：prototypes/playback-clock/manifest.json，实验边界和检查方法见 [S1 计划](experiments/S1/plan.md)。
- T0 核心与测试入口：plugin/frame-index.cjs、plugin/player.js；tests/host/t0/manifest.json为独立宿主测试入口。[T0计划](experiments/T0/plan.md)固定输入、预算与验证边界。正式入口已获用户T1阶段体验认可，尚非完整MVP或全项技术验收版本。
- T0 当前结果与人工步骤见 [执行记录](experiments/T0/report.md)；默认检查 `node scripts/check.cjs`，保存新本地检查证据 `node scripts/verify-t0.cjs record-checks`。后者只新增有界证据，不重新生成媒体或执行历史实验。
- A-04选定`compressed-ram`（JPEG池≤64MiB，包含在512MiB内，仍仅rAF提交）。T0修正版完整复验18轮已核对，正常79～81次提交/秒、最长约49ms、P95约9ms；首次3轮约22秒，102点独立源JPEG指纹匹配、1490帧PTS一致。六次首备/复用含选中读取，实验重置单记，不包含插件创建；旧超时/取消记录保留。压力仍有约1秒停顿，不推广到全编码或长期稳定。T1分层入口用户体验及正式代码六轮真实宿主早期回归已通过，快拖67～73次提交/秒、最长67.3ms、随机P95约10～11ms；T4全矩阵/长期资源仍待验，不能以T0数据代替。[T0收尾证据与边界](experiments/T0/report.md#完整复验核对与独立源帧收尾)。
- 框架：HTML/CSS/JavaScript、Eagle Plugin API、Node 内置模块、现有 FFmpeg/ffprobe，无新增依赖。
- 已验收 Eagle 运行时：Node 16.17.1 / Chrome 108；本机检查 Node 24.20.0。代码必须兼容实际插件运行时。

## 资料位置

| 内容 | 位置 | 更新原则 |
| --- | --- | --- |
| 全项目长期规范 | AGENTS.md | 权限、阶段与证据原则，不堆当前状态 |
| 产品需求与决定 | docs/product.md | 区分已决定和待确认 |
| 技术与模块说明 | docs/architecture.md | 已批准架构与验证边界；另保留历史 PoC 结构，不把批准记成已实现 |
| 测试与验收协议 | docs/verification.md | R/P 追踪、样本及统一测量；批准的协议不记成运行通过 |
| 正式开发计划 | docs/development-plan.md | T0～T4 的依赖、关卡、版本节点和迁移；不在此处提前实施 |
| 当前进度 | docs/progress.md | 当前事实、限制、下一步授权边界 |
| 各实验与开发关卡报告 | docs/experiments/A、B、S1、T0、T1 | 分别保存范围、真实结果与验收边界 |
| 日期记录与旧过程 | docs/progress/ | 历史记录保留上下文 |
| 实验实现 | prototypes/window-player/、playback-clock/ | A/B 与 S1 分开，遵守局部 AGENTS.md |
| 原始证据、本机配置、合成输入 | 原型内 evidence/、tools-b.json、b-test-fixtures/ | 本机忽略，迁移保留，原始证据不覆写 |

## 运行与检查

3C 已完成 Git Diff、相对链接/锚点、R/P 与 T0～T4 对应、批准数值和受保护文件核对，并获用户最终验收；收尾仅更新状态、复核规范和固定本地版本，不运行历史实验。阶段 4 的实际检查按获批任务执行。

阶段 4 建立 `node scripts/check.cjs`：默认检查新代码语法、模块依赖、纯模块/模拟集成及文档链接，不生成媒体、不清共享缓存、不启动 Eagle、不写库。显式 `node scripts/prepare-t0.cjs` 保留本地配置中登记的四个历史输入；T0 窗口默认读取 Eagle 当前单选 MP4（≤30秒），不再自动载入旧基线，也不在窗口样本菜单保留它。点击载入或重新调用读取一次快照；重新载入保持当前成功视频，空状态时重新读取。自动性能/准备协议固定当前已载入输入的身份和 SHA，每轮核对；不同输入单列结果，不能替代旧基线或4K/60fps覆盖。写入限于 T0 隔离缓存/证据，不扫描库。已执行结果与宿主失败、修复及待重测项以 T0 记录为准。

T1 正式入口为 `plugin/manifest.json`；加载与真实窗口操作由用户执行。`node scripts/verify-t1.cjs record-checks` 执行默认检查并写 T1 回执；`media` 对四登记输入调用正式准备并逐资产读回，缺缓存时会生成；`cancel` 只在专用 H.264 尚无完整缓存时执行一次取消，已有则跳过；`profile` / `profile-final baseline|h264-cfr` 是保留既有完整缓存的有界临时生成诊断，前者至提交入口停止，后者执行最终内容校验后因已有目标拒绝覆盖，均清理自己 partial，不能充当完整首备。后三类属于有副作用的显式验证，不在默认检查中运行。详细证据、环境差异及宿主取证见 [T1 报告](experiments/T1/report.md)。

T1免命令宿主入口：Codex执行 `node scripts/prepare-t1-host.cjs` 只生成`tests/host/t1/`四份有归属的本机入口文件，总量≤256KiB，不加载Eagle、不处理媒体、不清旧文件。用户加载该目录后自动运行既定六轮并保存，不输控制台命令；真实SDK创建目录仅在独立测试窗口映射到`plugin/`，其余使用原正式HTML/脚本及SDK。回执分开记录SDK回调→正式就绪、正式app入口→就绪及首次/复用；不冒充原正式manifest启动。源码或生成文件变化拒绝继续，统一检查会核对已准备入口指纹；缺口与操作见[T1恢复记录](experiments/T1/report.md#t1-免命令宿主测量入口)。

用户关窗失败修复后的显式 `node scripts/verify-t1-close.cjs` 用登记H.264与正式cache验证首帧/最终校验前取消和完整缓存关闭；生成自己的partial、取消并清理，保留旧完整缓存，回执仍计T1预算。Eagle窗口/DOM/Player为模型，媒体/缓存真实，不能记成实际宿主关窗通过。正常退出靠beforeunload同步门禁等待异步清理，不能只返回退出通知Promise。详见[T1关闭记录](experiments/T1/report.md#用户关闭失败与修复)。

最新关闭模型另覆盖快速清理：等待首次取消响应后，在下一事件任务请求真实关闭，不把关窗实现成卸载素材。技术命令及证据统计由Codex执行，用户负责Eagle中的真实使用体验，不再要求用户输入开发者控制台命令。显式 `node scripts/verify-t1-reads.cjs` 只测用户指定片段的现存缓存读取；`node scripts/verify-t1-browser.cjs [--baseline]` 用现有Chrome/本机Node24进行独立真实JPEG/Canvas诊断，基线固定`1afcaa4`旧核心。两者仅从本机环境变量 `EVA_T1_DIAGNOSTIC_SOURCE` 读取该视频绝对路径、核对固定SHA，不扫描库/生成媒体/重置旧缓存；不在默认检查中执行。Chrome有额外本机传输和不同内核限制、64MiB临时目录/1.5GiB RSS采样停止线、90秒上限，结束只清本轮自有临时目录。证据仍受T1预算约束；独立诊断不等于Eagle宿主性能验收，细节及失败原件见[T1本轮记录](experiments/T1/report.md#完整缓存关闭与后段拖动修复)。

### 历史原型命令及副作用

下列命令的工作目录均为 `prototypes/window-player`，使用现有 Node：

```text
node check.cjs
node check-b.cjs
node assess-b.cjs --verify-only
```

本机 Node：`D:\软件\工具类\nodejs\node.exe`。在 PowerShell 通过 `& '完整路径' check.cjs` 调用。check-b 会使用现有 FFmpeg 提取隔离合成视频，再清理自己产生的测试缓存；检查结果生成新日期文件。assess-b 只读复核已有 B 会话，不重测性能。

目录变动检查额外运行 `git diff --check`，核对 ignored 文件未误入提交、历史证据哈希和 Git 历史未改变。真实 Eagle 重新加载/播放由用户操作，本地模拟通过不能代替它。

S1 的工作目录为 `prototypes/playback-clock/`：`node check-local.cjs` 保存语法、播放器/接线模拟证据；`node check-prepare.cjs --reset --baseline` 会安全清理 S1 runtime 后运行限定 FFmpeg 检查，不重跑 A/B。`node check-selected.cjs` 使用现存合成输入验证新增选中素材链路，不扫描用户素材库；生成/清理检查前应关闭正在测试的 S1 窗口，避免共用 runtime 的并发清理。真实窗口操作、具体证据与测量限制见 [S1 记录](experiments/S1/report.md)。

## 版本与证据

- `poc-a-verified`：2a4000e，原位置下 A 的单素材验收版本。
- `poc-b-performance-verified`：becf389，原位置下 B 的单视频性能验收版本，准确性和长期内存限制仍成立。
- `phase3c-approved`：2026-10-11 用户验收后的工程文档节点；覆盖产品/架构交接、测试协议、MVP 文件组织与迁移计划，不表示阶段 4 实现或性能通过。指向以 Git 标签核对为准。
- `phase4-t1-experience-approved`：2026-10-12用户整体确认T1阶段体验通过后的收尾节点，代码沿用`14d7f44`。只固定体验认可与文档交接，不表示正式宿主P-01～P-03量化、T2或MVP总验收通过。
- `phase4-t1-early-verified`：2026-10-12核对`c1a5fa0`候选的六轮真实Eagle原始事件后固定的限定早期关卡；正常3×30秒、随机3×200及单次复用就绪/资源绑定。不是T4全矩阵、首次/复用三轮、长期资源或MVP总验收；播放器未改动。
- 标签用于固定代码快照；原始窗口会话、回执与评估 JSON 单独保存在 evidence，不由标签替代。
- 迁移前版本使用旧路径，标签可以查看代码但不能保证在新目录直接运行。若需复跑应另获范围并适配路径，不能通过切换标签覆盖当前文件或证据。
- 不自动创建远程、推送、发布或生成正式安装包。

正式缓存设计为经实际路径校验的 `plugin.path/cache/`，与插件同盘且不得位于 C 盘；临时缓存同样受限，失败不回退 C/TEMP。T0 使用实际测试插件根下 `tests/host/t0/cache/` 和独立 `verification-runs/t0-*`，本机配置 `tests/host/t0/config.local.json` 均忽略入 Git；不改变现有原型产物，不写素材库。

## 正式文件组织与边界（计划）

正式实现只设一个 plugin/ 入口，保持 HTML/CSS/JavaScript、Node 内置模块和现有工具链。下表是批准的职责规划；T0 先实现 frame-index/player 和独立测试入口，其余模块及正式入口按 T1～T3 逐步建立，不能把表内全部内容记成已实现。

| 文件 | 职责与边界 |
| --- | --- |
| plugin/manifest.json、index.html | Eagle Window 与页面入口 |
| plugin/app.js | 宿主生命周期、依赖装配和事件接线，不承载媒体、缓存、标注业务 |
| plugin/ui.js、styles.css | 极简主画面与侧栏、状态及实际帧时间提示、带输入焦点保护的空格操作；只向会话发出操作，不直接访问文件或 Eagle 素材/标注 API；正式页面无测试控制 |
| plugin/session.cjs | 素材/库快照、状态与任务所有权，协调适配、准备、缓存和播放 |
| plugin/eagle.cjs | 唯一素材/标注 API 边界；独立读回，不直接写 metadata.json |
| plugin/media.cjs | 只读源媒体、分析和 FFmpeg；通过缓存句柄受限写入，不自行淘汰目录 |
| plugin/cache.cjs | 文件所有权、实际路径、预算、锁、完整提交、淘汰与清理；不操作 UI 或素材元数据 |
| plugin/frame-index.cjs | 纯时间/源帧映射；整数 PTS、呈现编号与源时间关系 |
| plugin/player.js | Canvas、Web Audio 与调度；通过缓存读取/预算句柄取得资源，不调用标注 API |
| tests/、scripts/check.cjs | 隔离测试与统一检查；正式代码不依赖 prototypes，开发检查不进入产品 UI |

新任务先读本文件和 progress，再读目标目录局部规范、相关 R/P、architecture 决策与 development-plan 中的目标任务；核对 Git 状态与既有证据后继续，不能仅靠聊天摘要或旧原型入口恢复上下文。
