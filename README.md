# dsh-skills

DeepSeek Harness（DSH）的全局 skill 集合。每个子目录是一个独立 skill，按 DSH 的 skill 目录约定组织。

## 安装到本机

把需要的 skill 目录复制到 DSH 的全局 skill 根（所有 profile 共享，落盘即生效，无需重启）：

```powershell
# 单个 skill
Copy-Item -Recurse .\.agents\skills\dsh-tap-codebuddy "$env:USERPROFILE\.dsh\skills\dsh-tap"
```

装好后在 DSH 的新会话里即可被识别（skill 目录是动态扫描的）。

## 目录

| skill | 用途 |
|---|---|
| `dsh-tap-codebuddy` | dsh-tap 插件与 CodeBuddy 渠道（`copilot.tencent.com` 网关）的排障：400/11128 等错误码定位、本地 3901 桥、模型清单、额度、OAuth、会话现场还原 |

### dsh-tap-codebuddy

面向一类具体问题的操作手册，核心是「不要猜，从会话文件取真实字节回放」：

- 固定事实表：插件路径、3901/3912/3913 端口分工、哨兵头、设置层与用量文件、会话记录结构
- 生效方式按层区分（`providers/codebuddy/` 改动必须重启桌面应用）
- **11128 标准二分流程**：会话导出 → 四变体回放 → 前缀扫描找临界 → 找最小触发串
- 已定位的两个触发源：`role:"developer"` 字面量、system 里 `@` 路径说明段的 `workspace root` 组合短语
- 其它错误码分流、模型清单判读、文档地图、交付纪律

自带两个脚本：

```powershell
# 从会话文件还原真实请求（多帧 zstd 解压 + system/user/tools/失败原文导出）
node .\.agents\skills\dsh-tap-codebuddy\scripts\dsh-session-dump.js <session.v4.jsonl.zstd>

# 直打 3901 桥，区分「渠道级」还是「内容级」失败
node .\.agents\skills\dsh-tap-codebuddy\scripts\probe-codebuddy.js --text "hi"
node .\.agents\skills\dsh-tap-codebuddy\scripts\probe-codebuddy.js --from-session <session.v4.jsonl.zstd>
```

## 编辑注意

本机 `powershell.exe` 是 5.1，`Get-Content -Raw` 默认按 GBK/ANSI 解码 UTF-8 文件。**不要用 PowerShell 的 `Get-Content` + `Set-Content`/`WriteAllText` 改本仓库的文件** —— 中文会被解码成乱码再写回，skill 的 frontmatter 一旦损坏，会直接从 DSH 的 catalog 掉线。请用 UTF-8 安全的编辑器。

## License

MIT
