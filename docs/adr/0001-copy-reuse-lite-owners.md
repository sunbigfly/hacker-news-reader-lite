# ADR-0001：复制 Lite owner 后改造

- 状态：已接受
- 日期：2026-08-16

## 决策

对已在 Awesome LinuxDo Reader Lite 中形成完整 owner 与测试的通用能力，优先复制最小依赖闭包和对应测试，然后改造为 HN 领域类型和适配器。不从零重写已验证的生命周期、调度、缓存、树、虚拟流、翻译、AI Completion、离线 runtime 和浮窗算法。

## 原因

- 这些能力已有直接源码、合同和历史回归证据。
- 复制测试能在改名/解耦前建立行为基线。
- 项目的差异主要在宿主数据和组合，不在通用算法。

## 边界

- 不复制大型 Discourse app/bootstrap 编排器。
- 不保留跨仓库运行时依赖。
- 每批复制都必须有源 SHA-256、目标 owner、对应测试和 Discourse 依赖归零证据。
- 保留 MIT License 与必要归属。

## 后果

实施必须以 `docs/REUSE_MATRIX.md` 为路由表。复制和 HN 行为扩展分开批次，以便独立归因。
