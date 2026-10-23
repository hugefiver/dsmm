export const ROLE_TOOL_NS = "conversation.dsmm-role-tool";
export const roleToolEn = {
  call: "Call", calling: "Calling", unknownTarget: "DSMM agent · target pending",
  requested: "Requested", actual: "Actual", role: "Role", category: "Category", unknown: "Unknown",
  actualUnknown: "Actual unknown",
  preparing: "Preparing", running: "Calling", result: "Returned",
  background: "Background", error: "Failed", stopped: "Interrupted",
  technicalDetails: "Technical details",
  args: "Original arguments", preparingArgs: "Arguments received so far", output: "Complete result content", failure: "Error details", metadata: "Invocation metadata",
  inspect: "View call details", copy: "Copy", copied: "Copied", emptyArgs: "Arguments not available yet",
  unavailable: "Actual identity unavailable; requested identity only", level: "Level", route: "Reported route", routeSource: "Route source",
  table: "Table", json: "JSON", viewMode: "View mode", property: "Property", value: "Value",
} as const;
export const roleToolZh: Record<keyof typeof roleToolEn, string> = {
  call: "调用", calling: "正在调用", unknownTarget: "DSMM 代理 · 目标待确定",
  requested: "请求", actual: "实际", role: "角色", category: "类别", unknown: "未知",
  actualUnknown: "实际未知",
  preparing: "准备中", running: "调用中", result: "已返回",
  background: "后台调用", error: "失败", stopped: "已中断",
  technicalDetails: "技术详情",
  args: "原始参数", preparingArgs: "目前已收到的参数", output: "完整结果内容", failure: "错误详情", metadata: "调用元数据",
  inspect: "查看调用详情", copy: "复制", copied: "已复制", emptyArgs: "参数尚不可用",
  unavailable: "实际身份不可用，仅显示请求身份", level: "等级", route: "报告的路由", routeSource: "路由来源",
  table: "表格", json: "JSON", viewMode: "视图模式", property: "属性", value: "值",
};
declare module "@deepseek-ai/dsh-client-ui-slots" { interface LocaleNamespaceMap { "conversation.dsmm-role-tool": keyof typeof roleToolEn } }
