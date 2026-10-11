# Eagle 视频分析

一个与 Eagle 素材库关联的 Window 视频分析插件项目。阶段 2、3A、3B、3C 已结束，工程文档节点为 phase3c-approved。2026-10-11 用户另行整体授权阶段 4；当前实施 [T0 核心风险专项](docs/experiments/T0/plan.md)，自动检查与修复连续推进，仅必要人工测试或变更授权处暂停。正式产品界面在 T0 关卡通过后的 T1 接入。

T0 选中入口修复`641e11b`已获用户人工确认；1080p HEVC专项结果保留。4K正常复测及方向预测后的人工快拖未通过，滑块捕获/回写修复待Eagle确认。用户已批准并实现两项互斥定向试验：在原512MiB内分配压缩图片池，或受控提前提交已就绪的最新画面；本地回归通过，实际改善尚未验证。新“三项短对照”固定视频，每项6秒、合计一个≤2MiB记录；运行方法和测量限制见 [T0最新记录](docs/experiments/T0/report.md#固定512mib的两项定向对照已实现待宿主比较)。入口仍为 `tests/host/t0/manifest.json`；不提高预算/降低画质，不代表正式采纳，T0尚未通过，不进入T1。

当前基线：[已批准技术架构](docs/architecture.md)采用统一 720p JPEG 缓存画面、实际 PTS 索引与音频时钟。正式缓存为实际插件目录下的 `cache/`，完整和临时缓存均不得位于 C 盘；未完成任务取消清理，下次重建，完整有效缓存复用。T0 仅建立可复用核心及独立验证入口，完整生命周期和正式 UI 尚待后续任务。

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
- [阶段 4 开发计划](docs/development-plan.md)：T0～T4、正式文件职责、PoC 迁移及每阶段关卡；已整体授权，从 T0 开始执行。
- 实验 A：[说明](docs/experiments/A/plan.md) / [报告](docs/experiments/A/report.md)。
- 实验 B：[说明](docs/experiments/B/plan.md) / [报告](docs/experiments/B/report.md)。
- [目录迁移与简要复盘](docs/progress/2026-10-10-repository-reorganization.md)：旧位置映射、验证结果、正确流程与修正原因。

## 打开原型

Eagle 本地开发项目入口是 `prototypes/window-player/manifest.json`，不是仓库根目录。2026-10-10 用户在本对话确认新路径下插件能够正常加载和运行；该项记录为用户人工验收，不是 Codex 执行的窗口测试，也不代表重新完成 A/B 全项测试。

原始运行证据位于 `prototypes/window-player/evidence/`，仅保存在本机；历史证据中的绝对路径保持测量时原样。项目只有根目录一个 Git 仓库。
