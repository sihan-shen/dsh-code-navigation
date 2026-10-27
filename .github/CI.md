# GitHub CI

工作流：`/.github/workflows/ci.yml`。在 `main` 的 push 和 pull request 上运行，权限仅 `contents: read`。

## 检查项

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm build`
4. `package.json` / `dsh.bundle` 元数据：
   - 包名 `@han_05/dsh-code-navigation`，且 `private` 不为 true；
   - `publishConfig.access` 为 `public`；
   - description 非空且少于 120 字符；
   - MIT license；
   - repository 指向本仓库；
   - `engines.node` 为 `^22.19.0 || >=24.0.0`；
   - `dsh.bundle.patch` 存在，且 patch 安装 `@han_05/dsh-code-navigation`；
   - `@deepseek-ai/cordis` peer 范围显式包含 `4.0.4` 与 `<5.0.0`；
   - DSH peer（含可选 `dsh-lsp`）范围显式包含 `0.2.0-rc.2` 与 `0.2.1-rc.2` 预发布分支；
   - `dist/index.js` 已生成。
5. `npm pack --dry-run`：确认发布包包含 `dist/index.js`、`cordis.patch.yml`、`README.md`、`LICENSE`。
6. bundle patch 的静态内容检查（id/name），不是实际安装 smoke。

## 本地等价命令

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
npm pack --dry-run
```

该工作流不启动模型、不需要 API key，也不做网络插件安装或 npm 发布；它验证构建、bundle 元数据、发布包形状和 patch 内容。
