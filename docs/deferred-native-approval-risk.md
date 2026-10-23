# 原生审批与运行中配置边界

DSMM 0.3.15 精确面向 DSH `0.2.1-rc.2`。原生批准仅对同次调用及其批准范围有效，不扩展到其他输入或后续调用。配置来源变化不把 DSMM epoch 变成第二次审批，也不取消已经等待的原生审批。

## 当前限制

已执行或恢复的 root 在原生子树真正空闲时可显式切换 overlay。事务使用原生 maintenance 和 admission CAS，保留会话 ID、历史、草稿及原生模型选择。仍有活动工作、未结束 turn、排队输入、工具／审批或待处理委派时拒绝切换，不能强制重绑运行中的父 Agent 或待审批调用。已有子 Agent 保留捕获的配置和权限上限，新委派使用新配置；无法证明外部 provider 启动边界时仍拒绝。观测范围限定为共享同一 Host 生命周期和 agents registry 的原生服务。

Use profile model 与普通模式操作具有独立 capability，不因 Apply 不可用而一并关闭，也不授予新的 overlay 权限。

## 调用与生命周期

取消、精确 Agent／owner／realm、工具及 provider 身份和输入隔离仍然有效。原生 once 批准不是可复用授权，批准也不保证工具或操作系统执行成功。

## 自动 Git 范围与规则记忆

`guards.gitWriteScope` 默认为 `all-writes`，可选 `high-risk`，与 `gitWriteGuard: ask | deny | off` 正交。`high-risk` 仅缩小自动 Git 保护的动作集合，不过滤显式 shell ask/deny，也不关闭对象型 nativeCommands ask；readonly、原生策略和既有 Full access/simple 路径的优先级不变。配置沿用全局、当前 DSH 配置和具名 profile 的继承规则；修改规则本身不授予 overlay 切换资格。

DSMM 的命令规则批准仅在精确的存活 Agent 对象内记忆；需完整原生审批服务最终返回 `allowed-once` 且调用绑定有效。同一规则允许的参数变化可以复用 DSMM 规则批准，不能扩展显式精确匹配或跨动作、工具注册、目录及规则语义借用。配置来源／规则变更使未来记忆失效，Agent 销毁、session 对象替换或控制器退休结束记忆。子 Agent 可捕获设置，但不继承父批准；记忆不持久化，也不跨恢复或重启。

规则记忆只消除 DSMM 自己已满足的 ask，不复用原生 once／sandbox target、不提高 standing 权限，也不替新的提权请求自动作答。原生提权、第三方或独立下游审批仍可能每次询问；deny、cancel、`approval.policy=never` 仍生效。来源变化不取消已经等待的原生请求；旧请求最终批准仍只按其单次契约执行，不向新来源写入记忆。

减少重复人工介入改变了风险，不能宣称总体风险不变。通用 Git 路径在既有 guard 边界重核调用，仍信任宿主后续可变的同进程 middleware；managed Shell 保持受控最终入口检查，但二者都不承诺隔离主动绕过管线的同进程插件或提供 OS 隔离，也不承诺所有工具没有弹窗。

遇到拒绝时先检查实际结果，不无条件重跑整个父任务。成功的空闲切换使精确子树的命令规则记忆失效，失败不清除记忆，旧 capture 不能迟到提交新记忆。运行中切换仍不提供；不得通过取消任务或复用批准绕过空闲条件。
