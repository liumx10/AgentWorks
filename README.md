# AgentWorks

`AgentWorks` 是一个 VS Code 扩展原型，用来把开发者、Codex、Claude 放到同一个聊天线程里讨论工作，而不是只和单个 agent 对话。

当前版本已经直接桥接本机已登录的 `codex` 和 `claude` CLI：

- 同一聊天面板内展示 `Developer / Codex / Claude`
- 开发者消息默认触发双 agent 讨论
- 支持 `@codex`、`@claude` 定向发言
- 支持 `general / design / coding / review` 模式，并为不同模式定义双 agent 讨论顺序
- 支持附带当前选区或当前文件作为讨论上下文
- 支持流式输出
- 默认直接使用本机 CLI 登录态
- 保留 provider 抽象，后续仍可切到 HTTP API 或流式协议

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 编译

```bash
npm run build
```

3. 在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host

4. 运行命令：

```text
AgentWorks: Open Chat
```

聊天会默认开在代码右侧的编辑区，不占用左侧目录树。也可以直接从当前编辑器进入，并自动把上下文带过去：

```text
AgentWorks: Discuss Selection
AgentWorks: Discuss Current File
```

## 运行方式

扩展不会自己管理 API Key，而是复用你当前机器上的：

- `codex` CLI 登录态和 `~/.codex` 配置
- `claude` CLI 登录态和 `~/.claude` 配置

内部桥接方式：

- Codex: `codex exec --ephemeral -s workspace-write ...`
- Claude: `claude -p --verbose --output-format stream-json --permission-mode acceptEdits --tools default ...`

## 配置

在 VS Code Settings 中可配置：

- `agentWorks.codexModel`
- `agentWorks.codexReasoningEffort`
- `agentWorks.codexSandbox`
- `agentWorks.codexCliPath`
- `agentWorks.claudeModel`
- `agentWorks.claudePermissionMode`
- `agentWorks.claudeTools`
- `agentWorks.claudeCliPath`
- `agentWorks.systemPrompt`
- `agentWorks.enableMockResponses`

说明：

- `agentWorks.codexApiKey` / `agentWorks.claudeApiKey` 现在保留只是为了兼容后续 API 方案，当前版本不会使用。
- `agentWorks.enableMockResponses=true` 时，可以退回本地 mock 模式。
- 如果 VS Code 是从桌面图标启动、拿不到 shell PATH，可以显式设置 `agentWorks.codexCliPath=/opt/homebrew/bin/codex` 和 `agentWorks.claudeCliPath=/opt/homebrew/bin/claude`。

## 当前工作流

- 你可以在界面顶部选择 `Primary`，决定谁先发言
- `general`
  由你选择的主 agent 先回答，另一个 agent 跟进反馈，双方继续讨论直到达成一致或达到轮数上限。
- `design`
  由你选择的主 agent 先给方案，另一个 agent 会质疑、补充或认可，然后双方继续讨论。
- `coding`
  由你选择的主 agent 先给实施路径，另一个 agent 继续批评风险、维护性或直接认可。
- `review`
  由你选择的主 agent 先给 review，另一个 agent 一定会给反馈，即使只是 `LGTM`。

默认最多讨论若干轮，避免无限循环；如果双方明确输出 `CONSENSUS: agreed`，讨论会提前停止。
无论谁是主 agent，另一个 agent 都至少会给一轮反馈，即使只是 `LGTM`。
如果达到轮数上限仍未收敛，界面会明确提示需要开发者仲裁。

## 界面位置

插件现在挂在 VS Code 的 secondary sidebar 容器中：

- 不再占用 markdown 预览、git diff 等编辑器 tab 区域
- 可以像 Codex 一样通过侧边容器切换到聊天界面
- 代码编辑器仍然可以和聊天同时展示
- 点击消息里的代码引用时，会在主代码区打开并定位

## 文件上下文

面板支持：

- `Attach Selection`
- `Attach File`
- `Detach`

上下文会挂在开发者消息上，并自动注入后续 agent prompt。大文件会压缩成更适合讨论的片段，而不是整文件硬塞进去。

## 输入与取消

- `Shift+Enter` 发送消息
- `Enter` 只换行
- 讨论进行中可以点 `Cancel`

## 流式输出

- Claude 现在使用 CLI 的 `stream-json` 事件流，能逐段实时显示回复。
- Codex 当前通过 `codex exec --json` 接入。这个 CLI 版本会返回结构化事件，但消息正文粒度仍偏粗，所以界面上会先显示运行状态，再在完成时落下完整回复。

## 可直接编程

当前默认已经不是只读讨论模式：

- Codex 默认使用 `workspace-write`，可以修改工作区文件并运行本地测试
- Claude 默认开启 `default` 工具集，并使用 `acceptEdits` 权限模式
- 公共提示词会优先鼓励直接动手完成实现、验证和修正，而不是只停留在方案讨论

如果后续 Codex CLI 提供更细粒度的文本增量事件，这一层已经预留好了，直接补解析即可。

## 下一步接入真实模型

现在 `src/providers.ts` 里已经有真实模型桥接和 mock 两套路径：

- `generateMockReply`
- `generateLiveReply`

如果你以后不想依赖本机 CLI，而想直接调 HTTP API，可以把 `generateLiveReply` 替换为真正的远程请求逻辑。建议继续保持当前抽象：

- `ChatSession` 负责消息历史和分发策略
- `AgentProvider` 负责单个模型调用
- `Webview` 只负责展示和交互

## 建议的后续能力

- 流式输出
- 消息级别的回复/引用
- 让某个 agent 提交 patch，另一个 agent 做 review
- 对接 VS Code `ChatParticipant` / `Language Model` API
- 会话持久化和多线程讨论
