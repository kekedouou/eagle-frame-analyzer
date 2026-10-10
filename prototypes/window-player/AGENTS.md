# Window 播放器原型：局部约束

- 继承根目录 AGENTS.md。本目录是实验 A、B 共用的 PoC，不是已批准的正式播放器工程。
- Eagle 加载本目录 manifest.json。启动时使用官方 plugin.path 核对 app.js 中的批准路径；页面 URL 不保证是 file 协议。
- 原始 MP4 只读；不得直接写素材库 metadata.json，不实现原生播放器注入或双向播放同步。
- write-approval.json 由 Codex 在取得聊天中的具体授权后创建，插件不能自动创建；必须匹配提案、素材、时间和文本。写入尝试不得盲目重试，删除只针对授权回执中的测试 ID。
- evidence/ 保存运行原始证据与新检查记录；tools-b.json、write-approval.json 和测试输入均为本机文件，保持 Git 忽略。
- 仅使用现有 Node 和 FFmpeg，不自动下载依赖。缓存只在 cache-b/cache-b-test，清理先确认所有者、目录和全部文件，不递归、不跟随链接、不删除未知文件。
- 保持现有视频长度、帧数、磁盘、单帧大小和资源采样上限；此次目录整理不得扩大产品功能或授权。
- check.cjs 是本地/VM 检查，check-b.cjs 使用隔离合成视频；二者不能替代真实 Eagle 交互。
- assess-b.cjs --verify-only 只读复核已有 B 记录；默认复算生成新的带日期记录，不覆盖原始验收。
