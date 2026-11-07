# V0.1 发布检查表

发布前只接受 bug、文档、安全和发布打包修复。不要加入执行隔离、桌面、新适配器、新通知通道或远程 Worker。

- [x] `npm test`
- [x] `npm run typecheck`
- [x] `npm run format:check`
- [x] `npm audit`
- [x] 扫描真实密钥
- [x] 扫描真实本机身份和路径
- [x] README 与实现一致
- [x] 文档和 API 与实现一致
- [x] 许可证已选择：MIT
- [x] 版权持有人已选择：MerLin
- [ ] 创建 GitHub 仓库
- [ ] 远程仓库创建后核对 repository、homepage 和 bugs 地址
- [ ] GitHub Actions 实际运行
- [ ] 公开推送
- [ ] 创建 release tag
- [ ] 创建 GitHub Release
- [x] Codex 真实 E2E
- [x] Claude Code 真实 E2E
- [x] Windows Runtime 隔离 E2E
- [x] 测试计划任务已清理
- [x] 没有运行时数据被 Git 跟踪

Windows At-Logon Task definition has been inspected and manually started successfully. An actual Windows reboot/logon cycle was not performed during V0.1 validation. Windows startup integration verified without destructive reboot/logoff testing.

## V0.1.1 发布准备

- [x] 版本提升至 0.1.1，package-lock 同步
- [x] 更新双语 README 并添加发布说明
- [x] 格式、类型、测试和 npm audit
- [x] Windows Runtime 与 Mock 回归
- [ ] 本次提交的 Ubuntu CI
- [ ] 本次提交的 Windows CI
- [ ] 创建 v0.1.1 tag（本轮不执行）
- [ ] 创建 GitHub Release（本轮不执行）
- [ ] npm 发布（本轮不执行，包保持 private）
- [ ] 实际 Windows 重启和登录周期（未测试）
