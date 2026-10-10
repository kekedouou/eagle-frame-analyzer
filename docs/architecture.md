# 当前原型架构

本文件解释已存在的 PoC，不代表正式播放器架构已获批准。

```text
Eagle → manifest.json → index.html
                           ↓ 启动事件
                        app.js
                  素材、播放、标注、证据保存
                           ↓
                    experiment-b.js
                  队列、画布、计时、资源采样
                           ↓
                       cache-b.cjs
                  ffprobe / FFmpeg / PTS 索引
                           ↓
                帧缓存目录与本机 evidence/
```

| 文件 | 职责与主要入口 |
| --- | --- |
| manifest.json | Eagle 窗口入口；插件 ID 保持原身份，名称不再绑定 A |
| index.html | A/B 实验控件、video 播放元素与共用 canvas 画布 |
| app.js | eagle.onPluginCreate 启动；loadSelected 读素材；seek 定位；标注授权保护及证据保存 |
| experiment-b.js | init 接线；LatestQueue 控制请求积压；render 显示帧；save 保存测量 |
| cache-b.cjs | probe 读编码/PTS；build 提取 JPEG；frameAt 按时间戳选帧；cleanup 安全清理 |
| check.cjs / check-b.cjs | 本地与合成输入验证，不代替真实窗口 |
| assess-b.cjs | 复核已保存窗口证据，verify-only 不写新评估 |

HTML 放置控件，JavaScript 响应事件；Node 内置模块负责本机文件和子进程，FFmpeg 负责视频解码/帧提取。PTS 是帧的呈现时间戳。

直接模式让 video 寻帧后绘到 canvas；缓存模式读取并解码 JPEG 后绘到同一画布。两者共用请求队列，只有一个在处理请求和一个最新待处理请求。

Eagle 启动事件的 plugin.path 用于核对磁盘目录；app.js 的批准路径已更新到新原型位置，迁移时不扩大加载范围。页面 URL 可能不是 file 协议，不能据此反推目录。

原生播放进度不参与同步。标注数据读写、自定义播放器操作和原生界面刷新分别验证。像素级帧准确性、缓存长期策略、完整内存管理尚未完成验证，见 B 报告。
