# 每次 push 时如何修改版本号

## 1. 只改一个地方：`VERSION`

项目根目录的 **`VERSION`** 是唯一需要你手动改的文件，内容是一行版本号，例如：`1.0.1`（语义化版本 major.minor.patch）。

## 2. 同步到前端和后端

在项目根目录执行：

```bash
chmod +x scripts/sync-version.sh   # 首次需要
./scripts/sync-version.sh
```

脚本会把 `VERSION` 里的版本号写入：

- `frontend/package.json` 的 `version`
- `backend/app/main.py` 里 FastAPI 的 `version`

## 3. 推荐 push 流程

每次要 push 前：

1. **改版本号**：编辑 `VERSION`，例如 `1.0.1` → `1.0.2`
2. **同步**：`./scripts/sync-version.sh`
3. **查看修改**：`git add -A`
4. **提交所有并 push**：
   ```bash
   git add -A
   git commit -m "v1.0.2"
   git push origin main
   ```
5. **（可选）打 tag**：
   ```bash
   git tag v1.0.2
   git push origin v1.0.2
   ```

这样每次 push 的版本号都会在 `VERSION`、前端和后端里保持一致。
