# GitHub CI

工作流：`/.github/workflows/ci.yml`。在 `main` 的 push 和 pull request 上运行，权限仅 `contents: read`。

## 检查项

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm build`
4. `package.json` / `dsh.bundle` 元数据：
   - 包名 `dsh-code-navigation`；
   - description 非空且少于 120 字符；
   - MIT license；
   - repository 指向本仓库；
   - `dsh.bundle.patch` 存在，且 patch 安装 `dsh-code-navigation`；
   - DSH peer 范围显式包含 `0.2.0-rc.2` 与 `0.2.1-rc.2` 预发布分支；
   - `dist/index.js` 已生成。
5. `npm pack --dry-run`：确认发布包包含 `dist/index.js`、`cordis.patch.yml`、`README.md`、`LICENSE`。
6. bundle patch 的 installability 快速检查。

## 本地等价命令

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
npm pack --dry-run
```

该工作流不启动模型、不需要 API key，也不做网络插件安装；它验证构建、bundle 元数据和发布包形状。
