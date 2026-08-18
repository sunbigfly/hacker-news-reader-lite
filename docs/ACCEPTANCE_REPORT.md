# Hacker News Reader Lite 验收报告

- 日期：2026-08-17（Asia/Shanghai）
- 浏览器：Chrome 151.0.0.0 / Windows 10 x64
- 构建环境：Node.js 24.18.0 / npm 12.0.1
- 生产脚本：`dist/hacker-news-reader-lite.user.js`
- 大小：107,385 bytes
- SHA-256：`0f084fd0a0ea0ec5bbb8a59d0eb15c0b738c73a5633bd841a54d24bea5911bde`

## 1. 验收结论

项目按单一 TypeScript userscript 交付，覆盖 HN 评论树阅读、公共/AI 翻译、讨论与文章 AI 总结、文章浮窗、离线 HTML、全帖本地预热和虚拟流。HN 列表页已改为左侧宿主 + 右侧阅读器的嵌入工作区，评论线为局部 segmented branch，不再使用跨根评论的全局轨道。

浏览器验收使用用户已安装的本地 resource loader；强制刷新 HN 后由 Tampermonkey 重新载入当前资源，不是临时 DOM 注入。本轮未发布、提交或推送。

## 2. 自动化验证

本轮等价门禁最终结果：

- ESLint：通过。
- strict TypeScript：通过。
- Vitest：25 个测试文件、72 个测试全部通过。
- 生产构建：通过。
- userscript 审计：metadata、精确权限、禁用 token、敏感信息、复用来源哈希全部通过。
- 复用清单：15 个复用 owner，源文件哈希与目标/测试合同均通过。

构建收据位于 `dist/hacker-news-reader-lite.user.js.build.json`。

## 3. 真实 HN 浏览器验收

目标页：`https://news.ycombinator.com/news`，选中故事 `49325185`。验收期间 HN 评论数实时变化，评论数量只作为动态页面状态记录，不作为布局结论。

- Reader 显式接管 HN 的 `html > body > center > #hnmain` 几何，覆盖原生 `width="85%"` 和 `min-width:796px`；Reader 根节点直接挂在 `html` 下，避免百分比继续相对已压缩的 `body` 计算。
- 2,033px 视口下宿主右边界与 Reader 左边界均为 976px：宿主 48%、Reader 52%、接缝偏差 0px；Reader 右边界为 2,033px，与视口右边界完全重合。
- Reader 正文右边界为 1,956px，距工作区右边界 77px；长评论在正文列内换行，不再被视口裁切。
- 评论区为具名 `role=tree`，右侧工作区为 `complementary`，Reader 为非模态 `region`。
- 分支折叠按钮中心与父评论主干对齐；进入下一条根评论前的末后子节点 `railContinues=false` 且无 stem，证明线在当前子树收尾。
- 标题与关闭按钮固定在首行，六个阅读工具固定在第二行；所有控件均位于 Reader 边界内。
- 真实 click 路径使分支按钮从“收起分支”切换为“展开分支”并隐藏子树；完成提示 4 秒后 `hidden=true`。
- 末子节点与弯头重叠的 current-parent rail 为 `display:none`，弯头底部与头像中心同高，不再留尾线。
- 关闭后撤销 Reader 根节点，并逐项恢复 `html`、`body`、`center`、`#hnmain` 打开前的内联值与优先级；焦点交还入口。
- Escape 按最前层依次关闭设置/摘要/文章浮窗/Reader，不穿透销毁底层表面。
- 最终截图后浏览器 Console `error` 列表为空。

翻译、AI 和外链文章使用受控响应验收，避免真实凭据、付费调用和第三方不稳定性影响复现：

- 公共翻译覆盖 Google 成功及 Google → Microsoft 回退；公共服务失败不会自动调用 AI。
- 分支总结使用真实输入评论 ID，60,000 字符预算下明确显示覆盖 141/175 条及截断说明。
- 文章浮窗只保留一个实例；受控文章正文为 115 words，内部链接在同一浮窗导航，返回、翻译和文章总结可用。
- 离线 HTML 为 335,145 bytes，包含 361 条评论、讨论摘要和 2 篇已打开文章；搜索、折叠、显示模式均存在，不含测试 API Key、外部脚本或未回收 Blob URL。

外部服务的真实可用性和模型输出质量不在本次受控验收结论内；网络协议、匿名 GM 请求、URL/重定向/类型/5 MiB 安全限制由自动化合同覆盖。

## 4. 1,000 评论性能验收

以下为虚拟流 owner 的 1,000 评论历史基线；本轮没有改动其布局算法，但该数据不替代本轮右侧嵌入几何的实时证据。环境：同一 Chrome 页面、4× CPU、1,000 条 HN 结构合成评论。

| 场景 | 5 次结果（ms） | 中位数 | 最大值 | 门禁 |
| --- | --- | ---: | ---: | ---: |
| 冷启动 | 41.2, 23.4, 24.2, 22.2, 25.6 | 24.2 | 41.2 | <=250 |
| 执行路径预热后重复启动 | 23.5, 36.5, 24.0, 41.7, 43.6 | 36.5 | 43.6 | <=120 |

全帖预热在 Reader 首屏后以 idle slice 执行，完成 1,000 条后状态为“未发起网络请求”，待执行 idle callback 为 0。预热前首屏挂载 9 条，完成后挂载 11 条。

滚动挂载结果：

| scrollTop | 挂载评论 | 虚拟索引范围 |
| ---: | ---: | --- |
| 0 | 11 | 0-10 |
| 15,000 | 14 | 104-117 |
| 35,000 | 13 | 246-258 |
| 70,000 | 14 | 490-503 |
| 110,000 | 13 | 769-781 |
| 末尾 | 8 | 992-999 |

峰值挂载 14 条，显著低于 120 条上限；末尾不再为了凑满窗口反向挂载 120 条。

20 次 Reader 打开/关闭结果：

- 同时存在的 Reader 根节点峰值：1。
- 打开时 pending idle callback 峰值：1。
- 每轮关闭后的根节点/idle callback 清理失败：0。
- 焦点返回失败：0。
- 最终根节点、pending idle callback、Observer 计数：均为 0。

## 5. 安装与边界

当前浏览器已安装本地 resource loader。每次本地构建后需在 Tampermonkey 重新导入 `work/hacker-news-reader-lite.local-debug.user.js`，使 `@require` 查询哈希更新；脚本只匹配 `https://news.ycombinator.com/*`。

本轮没有执行真实第三方翻译/AI 服务质量验收，也没有在强制 GC 条件下测量堆漂移；20 次开关的 DOM、idle callback、Observer 和焦点清理作为当前可重复的生命周期证据。未执行发布、Greasy Fork 上传、Git commit 或 push。
