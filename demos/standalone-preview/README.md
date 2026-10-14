# 视频分析：独立绿色展示

一次性的 Windows x64 展示包，将当前 Eagle 插件的短视频分析能力带到无 Eagle 的环境。插件仍是正式开发主线；本目录不建立第二套产品需求、架构或验收体系。

支持 MP4 / 文件夹拖入、视频列表、自动720p预览准备、正常有声播放、空格暂停、逐帧、快速拖动和RAM百分比设置。只准备当前视频；保留原文件。按本次决定省略标注，无 Eagle 数据互通，无测试按钮。范围保持≤30秒 / 单文件≤2GiB，不借此次展示扩展1080p、长视频或播放列表连续播放。

## 使用

将 `dist/video-analysis-standalone-preview-20261014.zip` 整包解压到非C盘可写目录，双击 `VideoAnalysisPreview.exe`，拖入视频或文件夹。也可用右侧打开按钮。需要 Windows 10 22H2 或更新的64位Windows，无需安装Eagle、Node.js或FFmpeg。

详细随包操作、缓存保留与清理见 [USAGE.txt](USAGE.txt)。data与软件同盘，磁盘缓存5GiB；RAM额度按本机百分比设置，默认等效1GiB。不是整个程序内存硬上限。完整缓存复用仍需核验/准备RAM，不承诺秒开。

## 文件职责与恢复

| 文件 | 作用 |
| --- | --- |
| main.cjs | 独立窗口、本地数据归属、打开对话框；阻断网络导航与新窗口 |
| preload.cjs | 隔离的本地入口；文件选择交给会话；复用播放/UI，关闭等待释放 |
| files.cjs | 有界文件夹扫描、MP4筛选、去重与取消，不读取Eagle |
| assets.cjs / extract.ps1 / assemble.cjs | 固定校验和下载、安全提取、冻结核心复制与装配 |
| compat.cjs | 仅展示副本适配FFmpeg8日志；不修改正式media模块 |
| check.cjs / verify.cjs / finalize.cjs | 本地检查、独立Electron交互验证、身份核对后清测试数据并打包 |
| RECORD.md | 授权、失败、证据、交付与插件恢复点 |

播放核心来自6693994：Player绘图/音频，session协调状态与取消，media调用工具并保存准确时间索引，cache管理磁盘与读写锁，preferences保存额度。构建时复制到包内 `resources/app/core/`；开发不回写该副本，只保存本次可重复装配方法。唯一差异是media滤镜参数兼容修正，原始和装配后SHA写入BUILD-INFO。

下载在忽略的work/，证据在忽略的evidence/，dist也是忽略输出。上限和清理边界见 [AGENTS.md](AGENTS.md)。不重跑历史Eagle实验，不改原插件入口，不创建阶段验收标签。

## 分发边界

内置Electron44.7.2和BtbN FFmpeg8.1 LGPL-shared，下载固定SHA。包内保留Electron/Chromium许可证、FFmpeg许可证、对应FFmpeg源代码、构建参数与BtbN脚本参考。脚本是邻近时间快照，不能宣称精确复现二进制；第三方依赖的完整许可证/对应源码审计仍待公开发布前处理。本次未发布GitHub或建立更新/安装机制。

自动验证是独立Electron环境，不能替代Eagle验收或人的听觉/拖动体验。结果和限制以 [执行记录](RECORD.md) 为准。展示交付后返回原T2剩余事项与T4前置工作，本目录不继续独立产品开发。
