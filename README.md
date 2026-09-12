<div align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="Hacker News Reader Lite logo">

# Hacker News Reader Lite

**让长讨论更轻、更快、更容易读懂。**

在 Hacker News 原生页面内提供 Reddit 式评论树、按需翻译、AI 讨论总结与离线阅读，同时保留 HN 的速度、顺序和原生交互。

[![Version](https://img.shields.io/badge/version-0.1.4-f97316?style=flat-square)](https://github.com/sunbigfly/hacker-news-reader-lite/releases)
[![Greasy Fork](https://img.shields.io/greasyfork/v/591844?style=flat-square&label=Greasy%20Fork&color=f97316)](https://greasyfork.org/scripts/591844-hacker-news-reader-lite)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Target](https://img.shields.io/badge/target-news.ycombinator.com-111827?style=flat-square)](https://news.ycombinator.com/)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)

[从 Greasy Fork 安装](https://update.greasyfork.org/scripts/591844/Hacker%20News%20Reader%20Lite.user.js) · [产品设计](docs/PRD.md) · [架构说明](docs/ARCHITECTURE.md) · [质量门禁](docs/QUALITY_GATES.md)
</div>

## 为什么是 Lite

Hacker News 已经足够快。Reader 不重建一个更重的客户端，而是在需要时展开一块专注阅读的工作区：列表仍是 HN，投票、回复、账号与链接仍走原生路径，额外能力只在用户明确使用时运行。

| 阅读长讨论 | 理解与整理 |
| --- | --- |
| Reddit 式分支线、整支折叠、父评论定位与键盘浏览 | Google / Microsoft 翻译回退，可选 OpenAI-compatible AI |
| DOM-first 秒开，只在缺失分支或手动刷新时补充 API 数据 | 全帖或当前分支总结，引用可回到真实 HN 评论 |
| 分支感知虚拟流，评论 DOM 默认不超过 120 个 | 自包含离线 HTML，保留搜索、折叠、译文与已生成总结 |
| 左右分栏可拖动，主题、字体和阅读位置本地保存 | 外链通过安全的浏览器原生新标签打开，不抓取或嵌入正文 |

## 安装

要求 Chrome 或 Edge，以及 Tampermonkey。

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击 [从 Greasy Fork 安装 Hacker News Reader Lite](https://update.greasyfork.org/scripts/591844/Hacker%20News%20Reader%20Lite.user.js)。也可使用 [GitHub raw 构建](https://raw.githubusercontent.com/sunbigfly/hacker-news-reader-lite/main/dist/hacker-news-reader-lite.user.js)。
3. 打开 [Hacker News](https://news.ycombinator.com/)，从故事卡片或 `reader` 入口进入阅读器。

脚本仅匹配 `https://news.ycombinator.com/*`。自定义 AI 翻译或总结需要在“阅读设置”中填写自己的 OpenAI-compatible Base URL、API Key 和模型；公共翻译不需要 Key。

## 设计原则

- **原生优先**：不改写 HN 的投票、回复、收藏、隐藏、登录或内容顺序。
- **按需工作**：翻译关闭、未打开 Reader 且未触发 More 时，不发业务请求；始终无轮询、无全页 MutationObserver。
- **本地优先**：阅读历史、缓存与离线文档保存在 IndexedDB / GM Storage，默认 30 天，不做遥测或云同步。
- **有界资源**：请求统一去重、限并发、可取消；评论树使用 canonical state 与虚拟投影。

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run hn-lite:verify
```

完整验证依次执行 ESLint、strict TypeScript、Vitest、生产构建，以及元数据、权限、敏感信息和复用来源审计。生产输出及可复现收据位于：

```text
dist/hacker-news-reader-lite.user.js
dist/hacker-news-reader-lite.user.js.build.json
```

### Tampermonkey 本地调试

```bash
npm run hn-lite:local-debug
```

首次使用时，为 Tampermonkey 开启“允许访问文件网址”，再导入 `work/hacker-news-reader-lite.local-debug.user.js`。每次修改源码后重新运行命令并重新导入 Loader；本地资源 URL 带内容哈希，可避免旧缓存。

## 项目结构

```text
lite/src/                 TypeScript 业务事实源
lite/styles/              Reader 与宿主样式事实源
lite/tests/               单元、合同、安全和性能边界测试
lite/userscript.meta.txt  userscript 元数据事实源
docs/                     PRD、架构、ADR、实施计划与质量门禁
scripts/                  构建和审计脚本
dist/                     版本化生产 userscript 与构建收据
work/                     本机调试生成物，不进入 Git
```

`dist/` 和 `work/` 都由构建生成，禁止直接编辑；其中生产 userscript 会提交到 GitHub，供直接安装和 Greasy Fork Webhook 同步。

## 隐私与安全

- API Key 不进入配置导出、日志、离线 HTML、fixture 或 Git。
- 只有显式触发翻译或 AI 总结时才向所选服务发送相应正文。
- HN/API 内容进入 Shadow DOM 或离线文档前执行允许列表清洗。
- 外链只允许公开 HTTP(S) 地址，并使用 `noopener noreferrer` 打开。

完整边界见 [PRD](docs/PRD.md)、[架构文档](docs/ARCHITECTURE.md) 与 [质量门禁](docs/QUALITY_GATES.md)。

## 许可

项目以 [MIT License](LICENSE) 开源。通用 owner 的复用来源、版本和适配记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [reuse-manifest.json](reuse-manifest.json)。
