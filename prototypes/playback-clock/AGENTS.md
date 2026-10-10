# S1 播放时钟专项原型

- 继承根 AGENTS.md。用户于 2026-10-10 明确回复“授权S1”；范围见 docs/experiments/S1/plan.md。
- 仅验证候选 C，不实现正式 UI、标注、完整缓存库或原生同步。不修改 prototypes/window-player 及其证据。
- 使用现有 Node/FFmpeg；兼容实际 Eagle Node 16、Chrome 108。不得安装依赖或修改 Eagle 安装目录。
- 仅只读既有专用素材 MUXL6QI4AJIAG 中 SHA256 匹配原 B 的文件。其他视频不自动测试。
- 新合成素材最多三段，每段不超过 5 秒；runtime/ 与 evidence/ 内实验产物总量限制为 512 MiB，RAM 缓存数据不超过 512 MiB。限额是 S1 安全边界，不改产品 5 GiB 规格。
- 写入仅限本原型的 runtime/、evidence/、tools-s1.json 和本实验源码/文档；禁止标注 API 和素材元数据写入。
- 清理仅针对经所有者标记、真实路径和文件清单验证的实验文件。不跟随链接，不删除未知内容，不递归删除任意路径。
- 原始证据使用新的时间文件名，不覆盖旧证据。模拟测试、Node/FFmpeg 本地结果、真实 Eagle 运行、用户人工观察分别记录。
- Eagle 加载和听觉/画面观察由用户手动执行；本地通过不表示 S1 在 Eagle 中通过。
