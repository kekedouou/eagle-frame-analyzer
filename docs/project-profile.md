# 项目说明

文档职责：根README面向使用者，介绍Eagle插件、两种体验包及快速开始；本文件承担工程目录、运行/检查入口和上下文恢复，进度与实验原始记录仍在docs/progress.md及其链接中。主页不累积实验流水账，也不把绿色展示版升级为正式开发主线。

2026-10-14当前补充：用户已确认内存设置体验通过；下面“待设置人工验收”是交接时的历史状态。急用内测包采用scripts/package-beta.cjs冻结当前plugin到dist，不替换测试入口、不修改播放器。`node scripts/package-beta.cjs`首次生成唯一展示目录/ZIP，已有则拒绝覆盖；`--verify`只读复核快照与ZIP。输出总量≤4MiB（目录≤2MiB、ZIP≤2MiB），不自动堆积多版本；dist忽略入Git，保留本次快照而不清理用户运行数据。使用说明见[内测介绍](beta-preview.md)，当前阶段/交付结果见[进度](progress.md#2026-10-14-临时内测展示交付)。继续开发仍使用plugin及现有tests，不在dist里修代码。

当前正式设置候选（A-05）：默认等效1GiB，按整机RAM百分比配置、JPEG池上限1/8，preferences.cjs仅管理plugin根本地配置，UI经session调用。下一体验入口由`node scripts/prepare-window-host.cjs --preferences`准备，复用中性目录/ID，标题“T2内存设置验收”，只记录就绪/配置，不自动拖动/长测。不要沿用下方旧RAM变体入口作为当前人工步骤；新设置操作尚未真实验收。保存仅memory-settings.json/next≤4KiB，Git忽略，原视频/磁盘缓存/标注不改；具体当前证据见[T2记录](experiments/T2/report.md#2026-10-14-1gib宿主通过及内存设置候选)。

1GiB宿主对照准备：`node scripts/prepare-window-host.cjs --ram-compare`复用tests/host/window，T2标题/ID不变，正文运行前核对指定喜多郁代及内存捕获预算；同一performance协议，仅显式1024/128MiB变体，原Player磁盘代码不改。候选源码SHA/原SHA另记launchContext，不能称与正式默认完全相同。普通无参数prepare恢复默认、清除诊断标记；resource/annotations模式拒绝此标记，T3许可不续期。真实Eagle原1.5GiB renderer观察线不变。

2026-10-14新增受限对照入口：`node scripts/verify-t1-browser.cjs --ram-compare --ram-mib=512|1024`。虽复用历史浏览器工具文件，RAM模式明确为T2证据、固定喜多郁代，使用仅内存捕获的预算变体，正式Player默认不变；参数是二选一，不能把竖线原样作为shell命令。各命令独立生成有界诊断和清理自身scratch，不生成/删除原源或完整缓存、不操作Eagle。边界见[计划](development-plan.md#当前获批范围内的生命周期补验)。

## 身份与入口

- 项目：Eagle Window 视频分析插件。2026-10-14：T3单素材通过，喜多郁代1GiB宿主六轮通过；当前设置候选默认等效1GiB、JPEG池上限1/8。保留原512MiB成绩与失败、同组长时重复性及其余覆盖缺口，T2整体/T4尚未完成；设置操作等待真实验收。
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
| 各实验与开发关卡报告 | docs/experiments/A、B、S1、T0、T1、T2、T3 | 分别保存范围、真实结果与验收边界 |
| 日期记录与旧过程 | docs/progress/ | 历史记录保留上下文 |
| 实验实现 | prototypes/window-player/、playback-clock/ | A/B 与 S1 分开，遵守局部 AGENTS.md |
| 原始证据、本机配置、合成输入 | 原型内 evidence/、tools-b.json、b-test-fixtures/ | 本机忽略，迁移保留，原始证据不覆写 |

## 运行与检查

3C 已完成 Git Diff、相对链接/锚点、R/P 与 T0～T4 对应、批准数值和受保护文件核对，并获用户最终验收；收尾仅更新状态、复核规范和固定本地版本，不运行历史实验。阶段 4 的实际检查按获批任务执行。

阶段 4 建立 `node scripts/check.cjs`：默认检查新代码语法、模块依赖、纯模块/模拟集成及文档链接，不生成媒体、不清共享缓存、不启动 Eagle、不写库。显式 `node scripts/prepare-t0.cjs` 保留本地配置中登记的四个历史输入；T0 窗口默认读取 Eagle 当前单选 MP4（≤30秒），不再自动载入旧基线，也不在窗口样本菜单保留它。点击载入或重新调用读取一次快照；重新载入保持当前成功视频，空状态时重新读取。自动性能/准备协议固定当前已载入输入的身份和 SHA，每轮核对；不同输入单列结果，不能替代旧基线或4K/60fps覆盖。写入限于 T0 隔离缓存/证据，不扫描库。已执行结果与宿主失败、修复及待重测项以 T0 记录为准。

T1 正式入口为 `plugin/manifest.json`；加载与真实窗口操作由用户执行。`node scripts/verify-t1.cjs record-checks` 执行默认检查并写 T1 回执；`media` 对四登记输入调用正式准备并逐资产读回，缺缓存时会生成；`cancel` 只在专用 H.264 尚无完整缓存时执行一次取消，已有则跳过；`profile` / `profile-final baseline|h264-cfr` 是保留既有完整缓存的有界临时生成诊断，前者至提交入口停止，后者执行最终内容校验后因已有目标拒绝覆盖，均清理自己 partial，不能充当完整首备。后三类属于有副作用的显式验证，不在默认检查中运行。详细证据、环境差异及宿主取证见 [T1 报告](experiments/T1/report.md)。

当前免命令宿主入口：Codex执行 `node scripts/prepare-window-host.cjs`，仅生成 `tests/host/window/` 四份有归属本机文件（≤256KiB）。用户在Eagle加载该目录的manifest，显示“视频分析 · T2 自动测量”。通用目录与脚本不再绑定T1；新入口独立ID为EVAWINDOWVERIFY20261013，避免与旧T1注册冲突。使用Eagle“载入本地插件”选择整个tests/host/window目录，不选择manifest文件；不会自动启动，添加后打开“视频分析 · T2 自动测量”。旧tests/host/t1入口只提示迁移，历史原件不删除。自动六轮沿用既定协议，证据新存T2的16MiB额度，不代表完整T2长期验收。`node scripts/verify-t2-cache.cjs audit-host <runId>`兼容旧T1原件和新T2封装，核对内容摘要、源码及统计。

用户关窗失败修复后的显式 `node scripts/verify-t1-close.cjs` 用登记H.264与正式cache验证首帧/最终校验前取消和完整缓存关闭；生成自己的partial、取消并清理，保留旧完整缓存，回执仍计T1预算。Eagle窗口/DOM/Player为模型，媒体/缓存真实，不能记成实际宿主关窗通过。正常退出靠beforeunload同步门禁等待异步清理，不能只返回退出通知Promise。详见[T1关闭记录](experiments/T1/report.md#用户关闭失败与修复)。

最新关闭模型另覆盖快速清理：等待首次取消响应后，在下一事件任务请求真实关闭，不把关窗实现成卸载素材。技术命令及证据统计由Codex执行，用户负责Eagle中的真实使用体验，不再要求用户输入开发者控制台命令。显式 `node scripts/verify-t1-reads.cjs` 只测用户指定片段的现存缓存读取；`node scripts/verify-t1-browser.cjs [--baseline]` 用现有Chrome/本机Node24进行独立真实JPEG/Canvas诊断，基线固定`1afcaa4`旧核心。两者仅从本机环境变量 `EVA_T1_DIAGNOSTIC_SOURCE` 读取该视频绝对路径、核对固定SHA，不扫描库/生成媒体/重置旧缓存；不在默认检查中执行。Chrome有额外本机传输和不同内核限制、64MiB临时目录/1.5GiB RSS采样停止线、90秒上限，结束只清本轮自有临时目录。证据仍受T1预算约束；独立诊断不等于Eagle宿主性能验收，细节及失败原件见[T1本轮记录](experiments/T1/report.md#完整缓存关闭与后段拖动修复)。

当前T2资源入口用 `node scripts/prepare-window-host.cjs --resource` 明确准备；不传参数仍准备既有六轮性能协议。路径、插件ID与名称不变，仅本机归属配置mode变化，正式plugin文件不变。用户关闭旧窗口后打开已有“视频分析 · T2 自动测量”，自动执行一轮60分钟负载＋5分钟静置，仅本轮关卡成功且释放/保存核对后正常关窗，失败保留错误窗口；再次独立打开形成第二轮，保持同一初选素材。每轮T2预留4MiB，分钟压缩段不丢样，缺额/超限/改源或实际画面工作停止则失败；允许窗口被其它应用覆盖、用户使用其它应用；当前最小化实测失败，暂不最小化，可见/焦点状态随采样保存。独立核对命令为 `node scripts/audit-resource.cjs <runId1> [runId2]`，仅读原件并写≤128KiB审计，不重跑；不会把单轮/加速模型或renderer子范围当作T2整体通过。测试层固定真实SDK素材快照，不改变Eagle当前选中项；完整资源/故障及手动关窗结果另行验收。

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
| plugin/preferences.cjs | 物理RAM/百分比换算与本地原子设置保存；不访问素材库或清理媒体缓存 |
| plugin/process-identity.cjs | 缓存内部只读Windows进程出生/后代证明；未知时保留，不主动终止进程，不调用Eagle API |
| plugin/frame-index.cjs | 纯时间/源帧映射；整数 PTS、呈现编号与源时间关系 |
| plugin/player.js | Canvas、Web Audio 与调度；通过缓存读取/预算句柄取得资源，不调用标注 API |
| tests/、scripts/check.cjs | 隔离测试与统一检查；正式代码不依赖 prototypes，开发检查不进入产品 UI |

新任务先读本文件和 progress，再读目标目录局部规范、相关 R/P、architecture 决策与 development-plan 中的目标任务；核对 Git 状态与既有证据后继续，不能仅靠聊天摘要或旧原型入口恢复上下文。

T2本地命令及副作用：`node scripts/verify-t2-cache.cjs checks`跑统一检查并有界保存T2回执；`filesystem`仅在2MiB自有scratch用≤512KiB小缓存及本轮Node自然退出验证文件/进程恢复，成功轮按预存清单定点清理，旧失败保留；`filesystem --retry-retained`在同一额度内新建attempt，不清旧失败；`reuse`仅对已登记H.264完整缓存调用正式media/cache及现有FFprobe，禁止生成，逐资产读回及源校验，更新本次最近使用字段后释放占用。默认检查不执行上述文件/媒体副作用。具体输入、配额、失败和真实宿主停点见[T2报告](experiments/T2/report.md#维护事务恢复和文件管理候选)；节点间连续开发，必要宿主操作仍由用户打开插件完成，不要求调试命令。

T2回归补充：`node scripts/verify-t2-cache.cjs audit-host <明确T1运行ID>`只读原回执及其选中源/缓存清单，解包复算、核对SHA后有界保存T2审计，不把保存失败改成通过。既有`verify-t1-browser.cjs --before-t2-fix`仅将捕获的Player/session替为`2d0cfb4`代码，当前代码由无参数命令捕获；两次仍使用原UE固定源、既有缓存、原64MiB scratch/90秒/T1证据配额，清自己的成功轮产物，不操作Eagle。它与`--baseline`互斥，保留旧`1afcaa4`诊断身份；不把本机对照记为真实宿主回归。


## T3验收入口与收尾

T3标注实现与本地证据见[记录](experiments/T3/report.md)，实际写入范围见[提案](experiments/T3/plan.md#一次专用素材写入提案待批准尚未执行)。`node scripts/prepare-window-host.cjs --annotations`只更新中性目录`tests/host/window/`的既有四份本机文件，名称/标题明确T3，ID不变；不加载Eagle，不执行T2长测，不写素材。用户现已具体批准原提案一次添加/测试后删除，Codex已将精确库/素材/首帧0秒/文字/回退范围转录至writeApproval；本机5条标注（含用户原生新增）必须保护，按新ID回退。普通CLI准备仍默认只读，不自动续期已消费授权；原配置由Codex程序化准备，现授权已消费，重开不会再放行一次保存。测试接线门禁不进入正式plugin，用户只需打开操作，不输入调试命令。

新证据独立`verification-runs/t3-*`，16MiB总额/2MiB单份，每轮宿主观察≤1MiB/64事件/20分钟；复用有界存储实现但保持T2原件与配额。关闭时独立验证源SHA及获准的新标注回退；任何未知结果保留、报告，不重复添加/删除。普通`node scripts/check.cjs`不触发该宿主流程。当前T3单素材真实Eagle保存/独立读回/关窗删除已核对，原5条保全；一次授权已消费，勿重复写入。用户已回复“正常”确认定位画面与输入体验，T3单素材关卡通过，收尾固定phase4-t3-verified；未知提案跨重启不持久化、旧原生即时刷新不保证、受影响性能待T4核对。

T3完成后继续阶段4：先补T2宿主/故障/资源缺口与T4样本，执行顺序见[开发计划前置核查](development-plan.md#2026-10-13-t3收尾后的t4前置核查)。不要求重跑已认可的两组65分钟长测，不以旧源码的最好成绩拼成最终候选通过。

当前T4前置的T2补验：`node scripts/verify-t2-close.cjs`显式执行指定H.265真实媒体/缓存和模型关窗，边界见[开发计划](development-plan.md#当前获批范围内的生命周期补验)。仅自身≤256MiB partial及原T2回执，不强退、不写库、不清旧完整缓存；默认检查不执行媒体副作用。新tests/t2-close-runner只模拟验证执行保护。

`node scripts/verify-t2-pipe.cjs`只对该固定源把正式媒体参数的输出丢弃，支持显式`--decoder-threads=2|4|8`用于对照；不生成缓存、不等同P-03。限时/字节/FFmpeg观察停止线及证据见上述计划；默认检查不运行。正式media仅HEVC解码采用8线程，其他编码保持2；输入并行与播放器最多两个JPEG读取/解码任务是不同层，仍只处理一个视频。
