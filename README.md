# AI Copilot 🌙

一个 VS Code 插件，AI 编程助手。

## 功能

- ✅ **解释代码** — 选中代码 → 右键 → "解释选中代码"
- ✅ **代码优化** — 选中代码 → 右键 → "优化选中代码"
- ✅ **对话面板** — 在侧边栏直接和 AI 聊天，自动带上选中代码
- ⏳ **多文件上下文**（Phase 2）
- ⏳ **代码 diff 预览**（Phase 2）
- ⏳ **自定义 prompt 模板**（Phase 3）

## 使用方式

1. 安装后在设置中配置 `aiCopilot.apiKey`（DeepSeek API Key）
2. 选中代码 → 右键 → 选择功能
3. 或点击侧边栏 AI Copilot 图标打开对话面板

## 配置项

| 配置 | 说明 | 默认值 |
|------|------|--------|
| `aiCopilot.apiKey` | DeepSeek API Key | — |
| `aiCopilot.apiUrl` | API 地址 | `https://api.deepseek.com/v1/chat/completions` |
| `aiCopilot.model` | 模型 | `deepseek-chat` |

## 开发

```bash
# 安装依赖
npm install

# 在 VS Code 中按 F5 启动调试
```
