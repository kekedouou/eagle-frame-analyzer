# Eagle 视频分析

一个与 Eagle 素材库关联的 Window 视频分析插件项目。阶段 2、3A 已结束；阶段 3B 正在讨论候选架构，用户已授权 S1 播放时钟专项验证。3C 与正式开发尚未启动。

当前工作：[S1 实验计划](docs/experiments/S1/plan.md)与[实验记录](docs/experiments/S1/report.md)。S1 使用独立原型 `prototypes/playback-clock/`，已取得实际 Eagle 窗口证据；用户确认本次观察未出现声画不同步，真实 HEVC 素材的拖动、暂停与最终定位得到人工确认。慢解码下画面更新变慢，逐帧交互、全编码矩阵与长期稳定性仍未充分验证；候选 C 尚未定稿，不宣布产品性能整体通过。

S1 入口为 `prototypes/playback-clock/manifest.json`，可点击“读取 Eagle 选中视频”，测试当前单选的任意短 MP4（≤30秒，原文件只读）；三段合成样本用于已知帧/提示音验证。证据范围、性能数据和用户反馈见[真实窗口验收](docs/experiments/S1/report.md#真实窗口证据与用户人工验收)。本次仅更新文档，未重跑实验。

实验 A 已完成单素材集成与一次授权标注写入/回退；实验 B 已完成单视频缓存性能验证；重组后的新路径加载与运行已获用户人工确认。像素级逐帧准确性、长期内存稳定性及正式产品架构尚未充分验证。综合结论、数据与后续决策入口见 [阶段 2 综合验收总结](docs/progress.md#阶段-2-综合验收总结)。

已批准的 MVP 是自动准备 720p 缓存的短视频分析播放器，集成播放、快速拖动、逐帧及 Eagle 文字标注。行为、范围和待验证的性能目标见 [产品需求规格](docs/product.md)；3A 收尾与下一阶段边界见 [阶段 3A 收尾](docs/progress.md#阶段-3a-产品需求规格收尾)。

## 从哪里开始

- [Agent 规范](AGENTS.md)：全项目长期流程与权限。
- [项目说明](docs/project-profile.md)：目录职责、运行与检查命令。
- [产品需求与决定](docs/product.md)：要解决的问题及已批准范围。
- [原型架构](docs/architecture.md)：文件职责和数据流。
- [当前进度](docs/progress.md)：当前状态、验收限制及下一步边界。
- 实验 A：[说明](docs/experiments/A/plan.md) / [报告](docs/experiments/A/report.md)。
- 实验 B：[说明](docs/experiments/B/plan.md) / [报告](docs/experiments/B/report.md)。
- [目录迁移与简要复盘](docs/progress/2026-10-10-repository-reorganization.md)：旧位置映射、验证结果、正确流程与修正原因。

## 打开原型

Eagle 本地开发项目入口是 `prototypes/window-player/manifest.json`，不是仓库根目录。2026-10-10 用户在本对话确认新路径下插件能够正常加载和运行；该项记录为用户人工验收，不是 Codex 执行的窗口测试，也不代表重新完成 A/B 全项测试。

原始运行证据位于 `prototypes/window-player/evidence/`，仅保存在本机；历史证据中的绝对路径保持测量时原样。项目只有根目录一个 Git 仓库。
