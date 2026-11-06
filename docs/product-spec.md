# TaskCircuit 产品规格

TaskCircuit 是面向 CLI Agent 的本地持久化任务运行时，负责保存、调度和恢复长时间工作。V0.1 通过本机 Hub 和 mock adapter 演示 Event → Work Item → Execution → Worker → Agent → Ask → Answer → Resume → Done。它不连接真实 Agent，不提供重试、定时调度、通知、桌面端或多用户功能。
