export const ROLE_TOOL_NS = "conversation.dsmm-role-tool";
export const roleToolEn = {
  call: "Call", unknownTarget: "DSMM agent · target pending",
  requested: "Requested", actual: "Actual", role: "Role", category: "Category", unknown: "Unknown",
  preparing: "Preparing", running: "Running", result: "Tool returned · child completion not inferred",
  background: "Started / handed off · child completion not confirmed", error: "Tool error", stopped: "Interrupted",
  args: "Original arguments", preparingArgs: "Arguments received so far", output: "Complete result content", failure: "Error details", metadata: "Invocation metadata",
  inspect: "Inspect tool call", copy: "Copy", copied: "Copied", emptyArgs: "Arguments not available yet",
  unavailable: "Actual identity unavailable; requested identity only", level: "Level", route: "Reported route", routeSource: "Route source",
} as const;
export const roleToolZh: Record<keyof typeof roleToolEn, string> = {
  call: "调用", unknownTarget: "DSMM 代理 · 目标待确定",
  requested: "请求", actual: "实际", role: "角色", category: "类别", unknown: "未知",
  preparing: "准备中", running: "运行中", result: "工具已返回 · 不推断子任务完成",
  background: "已启动／移交 · 尚未确认子任务完成", error: "工具错误", stopped: "已中断",
  args: "原始参数", preparingArgs: "目前已收到的参数", output: "完整结果内容", failure: "错误详情", metadata: "调用元数据",
  inspect: "检查工具调用", copy: "复制", copied: "已复制", emptyArgs: "参数尚不可用",
  unavailable: "实际身份不可用，仅显示请求身份", level: "等级", route: "报告的路由", routeSource: "路由来源",
};
declare module "@deepseek-ai/dsh-client-ui-slots" { interface LocaleNamespaceMap { "conversation.dsmm-role-tool": keyof typeof roleToolEn } }
