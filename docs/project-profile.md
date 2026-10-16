# 项目说明

当前恢复入口：stability-vp9首轮已运行并于约35分钟因监测工具child-image/Windows错误5主动中止，原件209～220、无损复算与独立审计221见[T4失败核对](experiments/T4/report.md#2026-10-16-首轮长期验证中断原因核对)。不是RAM停止线或播放器错误触发，后半段缺数据/关闭后未观察不能记泄漏或通过。先修工具退出分类、失败上下文和加载中取消判读，短验证后再准备长期；本次未改正式plugin，既有P-03/帧准确性/人工体验保留，不重测。唯一stability-scratch已started/finished失败、cache现场保留，不能直接重开/覆盖；更换入口前按F规则核对归属/占用。现余33槽不足同时按19槽预留两轮，须先核查证据容量，不自动扩容或删原件。实际两轮长期与T2/T4/MVP整体仍未通过，下方“未启动”是历史描述。

测试模块：mvp-stability负责宿主协调，stability-runtime负责唯一stability-scratch副本及两素材归属，window-resource复用原工作循环，mvp-monitor负责短/长外部采样，long-trace负责无损有界轨迹及读取。原T4 readReceipt仍验证封装/摘要，长段用long-trace.decode还原窗口与外部原始行后按mvp-resource和window-resource趋势规则复算；旧audit-resource的T2文件入口不适用于新T4长段。14份运行副本仅worker磁盘缩至240MiB，正常plugin5GiB/偏好不动；第一轮核对后再按F规则切换--stability-hevc（索尼克＋喜多郁代），不覆盖started/finished。阶段记录、失败及清理分别引用报告，不把模型或短Windows检查当65分钟Eagle成绩。

最新事实：VP9完整六次准备已通过并由205独立审计，测试cache清完；三种代表编码完整P-03专项已有结果，见[T4报告](experiments/T4/report.md#2026-10-16-vp9完整准备计时通过)。当前不重跑--preparation-vp9、HEVC或索尼克；接续只准备新后台结构的两轮60分钟＋5分钟长期证据，正式plugin保持f35fb8c，T2/T4整体未通过。下方待VP9运行描述为历史。

最新接续：已`--preparation-vp9`准备同一tests/host/t4目录/ID，固定“地狱野蛮之锤”/MUXL6QI4AJIAG/828帧，默认1GiB，只补完整P-03六次首次/复用，不重复Canvas/拖动/人工体验。统一检查与Eagle Node26项协调检查通过，入口10584B/38源指纹，未启动/无cache。用户仅需选中该源、打开既有阶段4验收；[准备/整理回执](experiments/T4/report.md#2026-10-16-vp9补验入口准备)190/189。旧HEVC副本/生成入口已核对归属后退役，原件169～188保留，正常plugin/设置/缓存未改；不要重开--preparation-hevc或以本地检查当实际运行成绩。

当前恢复入口：f35fb8c的HEVC完整准备/实际Canvas已在Eagle通过并由188独立审计。喜多郁代首次约8.1～8.8秒、复用约1.7秒；24处主画布原源对比及206张既有编号片实际Canvas通过，测试cache清完。详细范围与原件见[T4结果](experiments/T4/report.md#2026-10-16-hevc完整准备与实际画布核对通过)。当前入口已一次运行完成，不再次执行--preparation-hevc覆盖；后续合并补VP9完整窗口与两轮长期的新后台资源证据，T2/T4整体未通过。以下待运行描述保留为历史，不要求重复已完成步骤。

当前接续入口：显式`node scripts/prepare-mvp-host.cjs --preparation-hevc`复用T4，对“喜多郁代”默认1GiB做完整6次准备＋独立Canvas/已有编号片核对，不重跑索尼克或已认可体验。`window-frame-reference.cjs`仅测试源参考与实际Canvas；`preparation-runtime.cjs`明确区分sonic/hevc源profile，仍一次归属/副本/缓存边界。HEVC缩放1→4已有同内容管道收益，完整就绪未实测；[计划](experiments/T4/plan.md#2026-10-16-准确性兼容与长期收尾)及[证据](experiments/T4/report.md#2026-10-16-hevc缩放瓶颈与集中宿主入口准备)为恢复入口。生成前需关闭旧验收窗口；完成/已开始副本不覆盖，正常cache/设置/素材只读。当前阶段整体仍未通过。

2026-10-16当前补充：末帧边界/双向逐帧准备/【/】及实际当前/总帧数已实现，用户三项集中反馈“全部正常”。7份既有/指定输入的后端时间及源JPEG/编号核对通过，不代替实际Canvas/全编码性能/长期，见[T4本轮](experiments/T4/report.md#2026-10-16-末帧边界修复与逐帧体验)。显式`node scripts/verify-frame-accuracy.cjs [--remaining-formats]`在accuracy-scratch生成有界隔离缓存并清理自己产物，不在默认检查执行，不默认重跑已通过数据；旧P-03副本已核对后清理，原配置保留于161。同一T4入口已`--experience`准备，只映射实际正式插件，无自动测量/记录/观察器；日常使用plugin。继续独立画布/真实编码性能/两轮长期，并诊断喜多郁代单次后端准备32.8秒风险，不提前宣称MVP通过。

2026-10-16当前：7dc4fc8准备模式的真实Eagle索尼克/720p/默认1GiB三次首次＋三次复用已通过，独立审计140，首次约9～11秒、复用约2.6秒；证据/范围见[本轮结果](experiments/T4/report.md#2026-10-16-索尼克完整准备计时限定通过)。正式plugin仍21a623f。此单素材首次专项收尾，T2/T4其余矩阵/独立帧参考/长期资源缺口保留，不重测手感或本组6次。入口已一次运行完成、测试cache不存在；约225KiB副本和started/finished暂为配置入口校验及拒重复所需，切换/停用时按F规则处理。当前不要执行无参数prepare（旧拖动）或--preparation覆盖已开始历史；不把准备/模型当真实成绩，不把本次通过外推全产品。

2026-10-16实现入口：首次准备专项已按正序/反序收益证据接入JPEG图片包/批量预载；新`plugin/frame-pack.cjs`仅负责纯布局校验，cache负责物理I/O/安全，media负责写帧，Player准备时批量读原JPEG，task/session/app只接线。旧完整散图继续复用、关闭交接/画质/预算不变；[A-08](architecture.md#a-08-jpeg集中存储与批量预载2026-10-16)、[后端结果与限制](experiments/T4/report.md#2026-10-16-首次准备优化jpeg集中存储与批量预载)为恢复入口。完整窗口后续已在索尼克限定验证，其他素材保留缺口；不按下面历史安排重开流畅度或要求重复手测。

显式专项工具`scripts/verify-preparation-pack.cjs compare [--reverse]`生成/清理自己的隔离配对缓存，`scripts/verify-packed-runtime.cjs`使用自有运行副本验证真实守护/媒体/恢复；后者的`--resume-owned`仅用于已留存且身份/内容完整匹配的本次失败，不是普通重试。两者有媒体/清理副作用，不在默认检查执行；预算、所有权及源以[T4计划](experiments/T4/plan.md#2026-10-16-首次准备专项集中存储与批量预载)为准，现有成功数据不需默认重跑。新T4入口指纹包括frame-pack；日常使用plugin，不需要重新导入或打开自动拖动入口。

2026-10-15当前：0204ce3索尼克默认1GiB/720p真实六轮短回归通过，快拖约99～100次有效提交/秒、最长48.7ms、随机P95为10.8ms，资源集合未超线。用户批准沿用既有人工体验验收，不再要求重测；本轮没有新增人工观察，流畅度专项收尾。同一tests/host/t4入口保留但不再要求反复打开，旧T2停用；日常使用plugin入口。首次完整P-03及其余未验矩阵/新进程长期资源仍保留，单次复用就绪9.75秒不抵首次，T2/T4未整体验收。player预测/media并行度候选保留，关闭/磁盘格式/偏好不变，同步预载尝试已撤回。进度见[当前记录](progress.md)，原授权/32MiB记录/停止线见[T4计划](experiments/T4/plan.md)，实际/未测结果见[T4记录](experiments/T4/report.md)。

当前入口和检查以此段为准，下面旧宿主入口说明保留为历史：使用`plugin/manifest.json`既有“视频分析”入口，无需重新导入T2插件。`task-client.cjs`发送控制请求，`native/task-host.cs`用Windows系统互斥/进程组持有本会话任务，`task-worker.cjs`复用media/cache准备和清理；Player直接在本地读帧，Eagle/标注API不迁移。本机11776B守护产物及构建指纹已就绪、Git忽略；源码变更/新检出由Codex执行`node scripts/build-task-host.cjs`构建，无需用户安装依赖或输入命令。

当前统一检查为`node scripts/check.cjs --without-prepared-host`：保留全部正式代码、纯/接线模型、文档及manifest检查，仅不核对已经停用且源码过时的T2准备入口。显式Windows/媒体检查入口及副作用见[专项验证](verification.md#生命周期整改验证-l-01l-03)。不执行旧自动测量、不清真实库、不改旧展示包；新的发行包必须包含新增运行模块与守护产物，旧白名单未更新时脚本明确拒绝新打包。

新验证工具：`scripts/audit-mvp.cjs --read-only --samples`只读证据/输入；`scripts/build-resource-sampler.cjs`用已有编译器构建tests/native下采样器，`scripts/prepare-mvp-host.cjs`生成阶段4入口≤256KiB。统一检查在新入口存在时始终核对其来源/构建指纹，--without-prepared-host只排除旧入口。`mvp-launch`负责测试协调，`mvp-monitor/mvp-resource`负责外部采样和纯统计，`t4-evidence`负责有界记录；共用window-host计量核显式选择T4，未开启旧T2 writer。正式app/player/cache不依赖这些文件，资源/记录问题不能成为产品启动或关闭条件。显式Windows/磁盘自检范围见[T4计划](experiments/T4/plan.md#文件与入口)。

文档职责：根README面向使用者，介绍Eagle插件、两种体验包及快速开始；本文件承担工程目录、运行/检查入口和上下文恢复，进度与实验原始记录仍在docs/progress.md及其链接中。主页不累积实验流水账，也不把绿色展示版升级为正式开发主线。

2026-10-14当前补充：用户已确认内存设置体验通过；下面“待设置人工验收”是交接时的历史状态。急用内测包采用scripts/package-beta.cjs冻结当前plugin到dist，不替换测试入口、不修改播放器。`node scripts/package-beta.cjs`首次生成唯一展示目录/ZIP，已有则拒绝覆盖；`--verify`只读复核快照与ZIP。输出总量≤4MiB（目录≤2MiB、ZIP≤2MiB），不自动堆积多版本；dist忽略入Git，保留本次快照而不清理用户运行数据。使用说明见[内测介绍](beta-preview.md)，当前阶段/交付结果见[进度](progress.md#2026-10-14-临时内测展示交付)。继续开发仍使用plugin及现有tests，不在dist里修代码。

历史正式设置候选（A-05，已被A-06替代）：默认等效1GiB，按整机RAM百分比配置、JPEG池上限1/8，preferences.cjs仅管理plugin根本地配置，UI经session调用。其体验入口由`node scripts/prepare-window-host.cjs --preferences`准备，复用中性目录/ID，标题“T2内存设置验收”，只记录就绪/配置，不自动拖动/长测；原操作后来获用户人工确认。保存仅memory-settings.json/next≤4KiB，Git忽略，原视频/磁盘缓存/标注不改；具体历史证据见[T2记录](experiments/T2/report.md#2026-10-14-1gib宿主通过及内存设置候选)。

1GiB宿主对照准备：`node scripts/prepare-window-host.cjs --ram-compare`复用tests/host/window，T2标题/ID不变，正文运行前核对指定喜多郁代及内存捕获预算；同一performance协议，仅显式1024/128MiB变体，原Player磁盘代码不改。候选源码SHA/原SHA另记launchContext，不能称与正式默认完全相同。普通无参数prepare恢复默认、清除诊断标记；resource/annotations模式拒绝此标记，T3许可不续期。真实Eagle原1.5GiB renderer观察线不变。

2026-10-14新增受限对照入口：`node scripts/verify-t1-browser.cjs --ram-compare --ram-mib=512|1024`。虽复用历史浏览器工具文件，RAM模式明确为T2证据、固定喜多郁代，使用仅内存捕获的预算变体，正式Player默认不变；参数是二选一，不能把竖线原样作为shell命令。各命令独立生成有界诊断和清理自身scratch，不生成/删除原源或完整缓存、不操作Eagle。边界见[计划](development-plan.md#当前获批范围内的生命周期补验)。

## 身份与入口

- 项目：Eagle Window视频分析插件。T3单素材通过，喜多郁代1GiB/2GiB宿主对照与实际设置体验已记录。当前默认1GiB、512MiB及1～10GiB固定档位、JPEG池上限1/8；并非整个程序内存的硬上限。保留原512MiB成绩/失败、同组长时重复性及其余覆盖缺口，T2整体/T4尚未完成。
- Git 根目录：eagle-video-analysis/；只有一个 .git，不在父级或原型内初始化新仓库。
- 正式Eagle入口：plugin/manifest.json，main.url为同目录index.html。prototypes/window-player/manifest.json仅保留A/B历史原型入口。
- S1 入口：prototypes/playback-clock/manifest.json，实验边界和检查方法见 [S1 计划](experiments/S1/plan.md)。
- T0 核心与测试入口：plugin/frame-index.cjs、plugin/player.js；tests/host/t0/manifest.json为独立宿主测试入口。[T0计划](experiments/T0/plan.md)固定输入、预算与验证边界。正式入口已获用户T1阶段体验认可，尚非完整MVP或全项技术验收版本。
- T0 当前结果与人工步骤见 [执行记录](experiments/T0/report.md)；默认检查 `node scripts/check.cjs`，保存新本地检查证据 `node scripts/verify-t0.cjs record-checks`。后者只新增有界证据，不重新生成媒体或执行历史实验。
- A-04选定`compressed-ram`（JPEG池≤64MiB，包含在512MiB内，仍仅rAF提交）。T0修正版完整复验18轮已核对，正常79～81次提交/秒、最长约49ms、P95约9ms；首次3轮约22秒，102点独立源JPEG指纹匹配、1490帧PTS一致。六次首备/复用含选中读取，实验重置单记，不包含插件创建；旧超时/取消记录保留。压力仍有约1秒停顿，不推广到全编码或长期稳定。T1分层入口用户体验及正式代码六轮真实宿主早期回归已通过，快拖67～73次提交/秒、最长67.3ms、随机P95约10～11ms；T4全矩阵/长期资源仍待验，不能以T0数据代替。[T0收尾证据与边界](experiments/T0/report.md#完整复验核对与独立源帧收尾)。
- 框架：HTML/CSS/JavaScript、Eagle Plugin API、Node内置模块、现有FFmpeg/ffprobe；A-07新增小型Windows C#守护源码，使用已有.NET Framework编译器/运行时，无新增安装依赖。
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

## 当前工作区与正式文件边界

正式开发只维护plugin/这一套播放器，使用HTML/CSS/JavaScript、Node内置模块和现有工具链。下列正式模块已经存在，模块存在不代表T2/T4全部验收完成；原型和发行副本不作为第二套开发主线。

| 主要目录/文件 | 通俗说明 |
| --- | --- |
| plugin/ | 真正继续开发的插件；改播放器功能从这里开始。cache/是自动生成的视频预览，memory-settings.json是本机记住的内存选择，不是源码 |
| tests/ | 检查功能与安全边界的测试。host/window/是Eagle里的专用测试入口，调用正式代码；不另养一套播放器。host/t0/保留早期测试，host/t2/cache-scratch/只放可清理的小测试现场 |
| scripts/ | 开发者使用的检查、准备测试入口、核对记录和打包命令；用户日常播放不需要手工运行 |
| docs/ | 产品要求、架构、开发任务、进度及验收报告；product说“需要什么”，architecture说“怎样分工”，development-plan说“按什么顺序做”，progress说“做到哪一步” |
| verification-runs/ | 测试产生的原始记录及核对回执，相当于验收凭据；被Git忽略仍需有界保留，不能当普通垃圾清空 |
| prototypes/ | A/B与S1的早期实验，保留探索过程和必要证据；正式插件不依赖它们 |
| demos/standalone-preview/ | 临时独立版的装配方法、说明和证据；work/中的软件零件用于重建冻结版，不用于插件日常运行 |
| dist/ | 打包好的交付副本及ZIP；不在里面开发。过期重复包可整理，当前交付包和用户运行数据先保护 |
| AGENTS.md、README.md、.gitignore、.git/ | 分别是长期工作约束、项目使用入口、不提交的文件名单、Git版本历史；忽略名单不负责自动清理，也不代表删除授权 |

工作协作可理解为：app接线 → ui接收鼠标/键盘 → session调度当前视频 → eagle读素材/标注、media准备、cache管文件 → player显示画面和声音。frame-index负责“这个时间是哪一帧”，preferences负责记住内存档位。详细边界如下。

| 文件 | 职责与边界 |
| --- | --- |
| plugin/manifest.json、index.html | Eagle Window 与页面入口 |
| plugin/app.js | 宿主生命周期、依赖装配和事件接线，不承载媒体、缓存、标注业务 |
| plugin/ui.js、styles.css | 极简主画面与侧栏、状态及实际帧时间提示、带输入焦点保护的空格操作；只向会话发出操作，不直接访问文件或 Eagle 素材/标注 API；正式页面无测试控制 |
| plugin/session.cjs | 素材/库快照、状态与任务所有权，协调适配、准备、缓存和播放 |
| plugin/eagle.cjs | 唯一素材/标注 API 边界；独立读回，不直接写 metadata.json |
| plugin/media.cjs | 只读源媒体、分析和 FFmpeg；通过缓存句柄受限写入，不自行淘汰目录 |
| plugin/cache.cjs | 文件所有权、实际路径、预算、锁、完整提交、淘汰与清理；不操作 UI 或素材元数据 |
| plugin/preferences.cjs | 固定RAM档位/物理上限与旧百分比只读转换、本地原子保存；不访问素材库或清理媒体缓存 |
| plugin/process-identity.cjs | Windows进程出生/后代只读证明；独占句柄核对后接管空writer记录；未知时保留，不终止进程、不调用Eagle API |
| plugin/frame-index.cjs | 纯时间/源帧映射；整数 PTS、呈现编号与源时间关系 |
| plugin/player.js | Canvas、Web Audio 与调度；通过缓存读取/预算句柄取得资源，不调用标注 API |
| tests/、scripts/check.cjs | 隔离测试与统一检查；正式代码不依赖 prototypes，开发检查不进入产品 UI |

### 工作区整理入口

长期约束见根AGENTS，详细规则见[开发计划F-01～F-07](development-plan.md#t2-文件自动管理计划f-01f-07执行中)，实际清单/证据见progress最新整理记录。任务结束清当轮无用临时文件，阶段结束再查旧构建和重复副本；这由Codex执行，不要求用户记得手动删。当前未新增后台清理服务。视频缓存运行时已有1天闲置/容量淘汰，与开发工作区整理分开。

待判断：独立版work中的两份下载ZIP约227.8MiB，是同版本重建的软件零件；T0缓存约227.8MiB，是早期性能实验的预览图像和声音。它们并非正式插件运行依赖，但仍有重建/复查用途，本轮保留，删除前说明输入、工具及恢复成本。当前公开独立包的解压目录也保留，避免影响本地体验/核对；工作区不会因为文件在忽略名单里就自动清空它。

新任务先读本文件和 progress，再读目标目录局部规范、相关 R/P、architecture 决策与 development-plan 中的目标任务；核对 Git 状态与既有证据后继续，不能仅靠聊天摘要或旧原型入口恢复上下文。

T2本地命令及副作用：`node scripts/verify-t2-cache.cjs checks`跑统一检查并有界保存T2回执；`filesystem`仅在2MiB自有scratch用≤512KiB小缓存及本轮Node自然退出验证文件/进程恢复，成功轮按预存清单定点清理，旧失败保留；`filesystem --retry-retained`在同一额度内新建attempt，不清旧失败；`reuse`仅对已登记H.264完整缓存调用正式media/cache及现有FFprobe，禁止生成，逐资产读回及源校验，更新本次最近使用字段后释放占用。默认检查不执行上述文件/媒体副作用。具体输入、配额、失败和真实宿主停点见[T2报告](experiments/T2/report.md#维护事务恢复和文件管理候选)；节点间连续开发，必要宿主操作仍由用户打开插件完成，不要求调试命令。

T2回归补充：`node scripts/verify-t2-cache.cjs audit-host <明确T1运行ID>`只读原回执及其选中源/缓存清单，解包复算、核对SHA后有界保存T2审计，不把保存失败改成通过。既有`verify-t1-browser.cjs --before-t2-fix`仅将捕获的Player/session替为`2d0cfb4`代码，当前代码由无参数命令捕获；两次仍使用原UE固定源、既有缓存、原64MiB scratch/90秒/T1证据配额，清自己的成功轮产物，不操作Eagle。它与`--baseline`互斥，保留旧`1afcaa4`诊断身份；不把本机对照记为真实宿主回归。


## T3验收入口与收尾

T3标注实现与本地证据见[记录](experiments/T3/report.md)，实际写入范围见[提案](experiments/T3/plan.md#一次专用素材写入提案待批准尚未执行)。`node scripts/prepare-window-host.cjs --annotations`只更新中性目录`tests/host/window/`的既有四份本机文件，名称/标题明确T3，ID不变；不加载Eagle，不执行T2长测，不写素材。用户现已具体批准原提案一次添加/测试后删除，Codex已将精确库/素材/首帧0秒/文字/回退范围转录至writeApproval；本机5条标注（含用户原生新增）必须保护，按新ID回退。普通CLI准备仍默认只读，不自动续期已消费授权；原配置由Codex程序化准备，现授权已消费，重开不会再放行一次保存。测试接线门禁不进入正式plugin，用户只需打开操作，不输入调试命令。

新证据独立`verification-runs/t3-*`，16MiB总额/2MiB单份，每轮宿主观察≤1MiB/64事件/20分钟；复用有界存储实现但保持T2原件与配额。关闭时独立验证源SHA及获准的新标注回退；任何未知结果保留、报告，不重复添加/删除。普通`node scripts/check.cjs`不触发该宿主流程。当前T3单素材真实Eagle保存/独立读回/关窗删除已核对，原5条保全；一次授权已消费，勿重复写入。用户已回复“正常”确认定位画面与输入体验，T3单素材关卡通过，收尾固定phase4-t3-verified；未知提案跨重启不持久化、旧原生即时刷新不保证、受影响性能待T4核对。

T3完成后继续阶段4：先补T2宿主/故障/资源缺口与T4样本，执行顺序见[开发计划前置核查](development-plan.md#2026-10-13-t3收尾后的t4前置核查)。不要求重跑已认可的两组65分钟长测，不以旧源码的最好成绩拼成最终候选通过。

当前T4前置的T2补验：`node scripts/verify-t2-close.cjs`显式执行指定H.265真实媒体/缓存和模型关窗，边界见[开发计划](development-plan.md#当前获批范围内的生命周期补验)。仅自身≤256MiB partial及原T2回执，不强退、不写库、不清旧完整缓存；默认检查不执行媒体副作用。新tests/t2-close-runner只模拟验证执行保护。

`node scripts/verify-t2-pipe.cjs`只对该固定源把正式媒体参数的输出丢弃，支持显式`--decoder-threads=2|4|8`用于对照；不生成缓存、不等同P-03。限时/字节/FFmpeg观察停止线及证据见上述计划；默认检查不运行。正式media仅HEVC解码采用8线程，其他编码保持2；输入并行与播放器最多两个JPEG读取/解码任务是不同层，仍只处理一个视频。
