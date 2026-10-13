# 分享界面来源

分享界面迁移自外部工程中的以下文件：

- `src/ui/components/chat/LarkMessageShareDialog.tsx`
- `src/ui/utils/lark-search.ts`
- `src/ui/index.css` 的字体与滚动条规则，以及 Tailwind 4 preflight。

保留原分享搜索和单选，适配独立窗口尺寸回报。按用户确认方案删除遮罩和卡片外框，让白底内容铺满原生窗口；确认后立即隐藏并后台发送，结果只写日志。

上述源文件无原有版权或许可头，源工程根目录未提供 LICENSE/NOTICE。本文件记录迁移来源，不声明或变更源代码许可。源工程的 `package/LICENSE.md` 适用于其附带的 Anthropic 产品，不作为本工具的 UI 许可。发行前如需对外分发，请确认源工程权利人的许可。

依赖 React、Tailwind CSS、lucide-react、sonner、qrcode 的许可保留在各 npm 包内。
