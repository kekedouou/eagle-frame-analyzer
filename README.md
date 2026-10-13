# Eagle 视频分析

一个与 Eagle 素材库关联的 Window 视频分析插件项目。T2两轮长时资源分别通过（720p、512MiB），合并核对发现两轮素材组不同，验收调整待确认。现有 `tests/host/window/` 入口与原始证据保留；T2未整体验收，暂不最小化。见[当前进度](docs/progress.md)。

历史T0完整复验及独立源帧参考已核对，限定技术关卡通过。4K H.264正常三轮约79～81次画布提交/秒、最长49ms、已提交请求P95约9ms；首次准备三轮约22秒，低于24.85秒媒体时长。保持720p、512MiB内最多64MiB压缩JPEG池、仅rAF提交。人为慢处理压力仍有约1秒停顿，不宣称全部素材/正式UI/长期性能通过；真实窗口操作来源为用户。[结果与限制](docs/experiments/T0/report.md#完整复验核对与独立源帧收尾)。T0入口保留为 `tests/host/t0/manifest.json`，无需重跑。

当前基线：[已批准技术架构](docs/architecture.md)采用统一 720p JPEG 缓存画面、实际 PTS 索引与音频时钟。正式缓存为实际插件目录下的 `cache/`，完整和临时缓存均不得位于 C 盘；未完成任务取消清理，下次重建，完整有效缓存复用。正式极简窗口已实现，生命周期与资源管理按T2继续验证。

S1 原型入口为 `prototypes/playback-clock/manifest.json`，可显式读取 Eagle 当前单选短 MP4；已有真实窗口证据及用户“未观察到不同步”的人工反馈，见 [S1 记录](docs/experiments/S1/report.md#真实窗口证据与用户人工验收)。慢解码更新停顿、真实源帧准确性、全部编码覆盖和长期稳定性仍待验证；原实验目录和限额未改动，未重跑实验。

实验 A 已完成单素材集成与一次授权标注写入/回退；实验 B 已完成单视频缓存性能验证；重组后的新路径加载与运行已获用户人工确认。综合结论见 [阶段 2 综合验收总结](docs/progress.md#阶段-2-综合验收总结)。架构批准与剩余验证交接见 [阶段 3B 收尾](docs/progress.md#阶段-3b-架构收尾)，不等于正式产品性能整体通过。

已批准的 MVP 是自动准备 720p 缓存的短视频分析播放器，集成播放、空格播放／暂停、快速拖动及上方时间数字提示、逐帧和 Eagle 文字标注。UI 参考 Eagle 主画面与侧栏结合，保持极简；常驻秒刻度留待后续。行为、范围和待验证的性能目标见 [产品需求规格](docs/product.md)；3A 收尾与下一阶段边界见 [阶段 3A 收尾](docs/progress.md#阶段-3a-产品需求规格收尾)。


## 从哪里开始

- [Agent 规范](AGENTS.md)：全项目长期流程与权限。
- [项目说明](docs/project-profile.md)：目录职责、运行与检查命令。
- [产品需求与决定](docs/product.md)：要解决的问题及已批准范围。
- [技术架构](docs/architecture.md)：已批准方案、模块/数据流、风险，以及保留的原型说明。
- [当前进度](docs/progress.md)：当前状态、验收限制及下一步边界。
- [测试与验收协议](docs/verification.md)：R/P 追踪、样本、性能测量和异常安全验证。
- [阶段 4 开发计划](docs/development-plan.md)：T0～T4、正式文件职责、PoC 迁移及每阶段关卡。
- [T1 正式窗口报告](docs/experiments/T1/report.md)：已通过的人工体验与六轮早期性能，以及覆盖限制。
- [T2 执行报告](docs/experiments/T2/report.md)：维护、恢复、文件管理验证及当前宿主关卡。
- 实验 A：[说明](docs/experiments/A/plan.md) / [报告](docs/experiments/A/report.md)。
- 实验 B：[说明](docs/experiments/B/plan.md) / [报告](docs/experiments/B/report.md)。
- [目录迁移与简要复盘](docs/progress/2026-10-10-repository-reorganization.md)：旧位置映射、验证结果、正确流程与修正原因。

## 打开正式开发入口

正式入口是 `plugin/manifest.json`，在 Eagle 中以本地开发项目加载；用户已确认T1体验通过，技术量化范围见[T1报告](docs/experiments/T1/report.md#六轮真实-eagle-测量核对与-t1-限定关卡收尾)。单选MP4后自动准备，首帧就绪暂停；改选另一素材后再次调用插件入口切换。界面没有性能测试按钮，不要求用户输入调试命令。T2自动维护候选尚未完成真实宿主验收，T3标注尚未实现，不将此体验节点视为完整MVP。

## 打开历史原型

Eagle 本地开发项目入口是 `prototypes/window-player/manifest.json`，不是仓库根目录。2026-10-10 用户在本对话确认新路径下插件能够正常加载和运行；该项记录为用户人工验收，不是 Codex 执行的窗口测试，也不代表重新完成 A/B 全项测试。

原始运行证据位于 `prototypes/window-player/evidence/`，仅保存在本机；历史证据中的绝对路径保持测量时原样。项目只有根目录一个 Git 仓库。
