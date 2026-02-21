# 测试命令：上传、切割、转录流程

## 前提条件

1. 确保后端服务正在运行：
   ```bash
   cd backend
   source .venv/bin/activate  # macOS/Linux
   # 或 .venv\Scripts\activate.bat  # Windows
   uvicorn app.main:app --reload --port 8000
   ```

2. 准备一个音频文件用于测试（例如：`/path/to/your/audio.m4a`）

---

## 完整流程测试

### 步骤 1：上传音频文件

```bash
curl -s -X POST "http://127.0.0.1:8000/api/upload" \
  -F "audio=@/path/to/your/audio.m4a"
```

**响应示例：**
```json
{
  "upload_id": "a15d5e77-e11e-46b5-8216-a74ea38dfc2b"
}
```

**保存 upload_id：**
```bash
# 将响应保存到变量（bash/zsh）
UPLOAD_ID=$(curl -s -X POST "http://127.0.0.1:8000/api/upload" \
  -F "audio=@/path/to/your/audio.m4a" | jq -r '.upload_id')

echo "Upload ID: $UPLOAD_ID"
```

---

### 步骤 2：切割音频文件

```bash
curl -s -X POST "http://127.0.0.1:8000/api/split" \
  -H "Content-Type: application/json" \
  -d "{\"upload_id\": \"$UPLOAD_ID\"}"
```

**或者直接使用 upload_id：**
```bash
curl -s -X POST "http://127.0.0.1:8000/api/split" \
  -H "Content-Type: application/json" \
  -d '{"upload_id": "a15d5e77-e11e-46b5-8216-a74ea38dfc2b"}'
```

**响应示例：**
```json
{
  "temp_dir": "/var/folders/.../T/audio_split_xxxxx",
  "chunks": [
    {
      "path": "/var/folders/.../T/audio_split_xxxxx/audio_part_001.mp3",
      "filename": "audio_part_001.mp3",
      "upload_id": "b6ec2a1e-9c83-49d1-9d8b-db39692b7aec"
    },
    {
      "path": "/var/folders/.../T/audio_split_xxxxx/audio_part_002.mp3",
      "filename": "audio_part_002.mp3",
      "upload_id": "915be5ed-6bef-425b-8ce7-48ccd54b5538"
    }
  ]
}
```

**提取所有 chunk upload_ids（使用 jq）：**
```bash
CHUNK_IDS=$(curl -s -X POST "http://127.0.0.1:8000/api/split" \
  -H "Content-Type: application/json" \
  -d "{\"upload_id\": \"$UPLOAD_ID\"}" | jq -r '.chunks[].upload_id' | tr '\n' ' ')

echo "Chunk IDs: $CHUNK_IDS"
```

**或者手动提取（不使用 jq）：**
```bash
# 将响应保存到文件
curl -s -X POST "http://127.0.0.1:8000/api/split" \
  -H "Content-Type: application/json" \
  -d "{\"upload_id\": \"$UPLOAD_ID\"}" > split_response.json

# 手动查看并复制 upload_ids
cat split_response.json
```

---

### 步骤 3：转录所有 chunks

**方式 1：使用多个 upload_ids（推荐）**

```bash
curl -s -X POST "http://127.0.0.1:8000/api/transcribe" \
  -F "upload_ids=b6ec2a1e-9c83-49d1-9d8b-db39692b7aec" \
  -F "upload_ids=915be5ed-6bef-425b-8ce7-48ccd54b5538"
```

**方式 2：使用循环（如果有多个 chunks）**

```bash
# 假设有多个 chunk_ids
CHUNK_IDS=("b6ec2a1e-9c83-49d1-9d8b-db39692b7aec" "915be5ed-6bef-425b-8ce7-48ccd54b5538")

# 构建 curl 命令
CURL_CMD='curl -s -X POST "http://127.0.0.1:8000/api/transcribe"'
for id in "${CHUNK_IDS[@]}"; do
  CURL_CMD="$CURL_CMD -F \"upload_ids=$id\""
done

# 执行
eval $CURL_CMD
```

**响应示例（成功）：**
```json
{
  "text": "这是第一段转录文本...\n\n这是第二段转录文本...",
  "failed_chunk_ids": null
}
```

**响应示例（部分失败）：**
```json
{
  "text": "这是第一段转录文本...",
  "failed_chunk_ids": ["915be5ed-6bef-425b-8ce7-48ccd54b5538"]
}
```

**如果部分失败，可以重试失败的 chunks：**
```bash
curl -s -X POST "http://127.0.0.1:8000/api/transcribe" \
  -F "upload_ids=915be5ed-6bef-425b-8ce7-48ccd54b5538"
```

**如果选择放弃失败的 chunks（清理文件）：**
```bash
curl -s -X POST "http://127.0.0.1:8000/api/transcribe" \
  -F "upload_ids=915be5ed-6bef-425b-8ce7-48ccd54b5538" \
  -F "cleanup_failed=true"
```

---

## 一键测试脚本

创建一个测试脚本 `test_flow.sh`：

```bash
#!/bin/bash

# 配置
AUDIO_FILE="/path/to/your/audio.m4a"
API_BASE="http://127.0.0.1:8000"

echo "🎵 步骤 1: 上传音频文件..."
UPLOAD_RESPONSE=$(curl -s -X POST "$API_BASE/api/upload" -F "audio=@$AUDIO_FILE")
UPLOAD_ID=$(echo $UPLOAD_RESPONSE | jq -r '.upload_id')

if [ "$UPLOAD_ID" == "null" ] || [ -z "$UPLOAD_ID" ]; then
  echo "❌ 上传失败: $UPLOAD_RESPONSE"
  exit 1
fi

echo "✅ 上传成功，upload_id: $UPLOAD_ID"

echo ""
echo "✂️  步骤 2: 切割音频文件..."
SPLIT_RESPONSE=$(curl -s -X POST "$API_BASE/api/split" \
  -H "Content-Type: application/json" \
  -d "{\"upload_id\": \"$UPLOAD_ID\"}")

CHUNK_COUNT=$(echo $SPLIT_RESPONSE | jq '.chunks | length')
if [ "$CHUNK_COUNT" == "0" ]; then
  echo "❌ 切割失败: $SPLIT_RESPONSE"
  exit 1
fi

echo "✅ 切割成功，生成 $CHUNK_COUNT 个 chunks"

# 提取所有 chunk upload_ids
CHUNK_IDS=$(echo $SPLIT_RESPONSE | jq -r '.chunks[].upload_id')
echo "Chunk IDs:"
echo "$CHUNK_IDS" | while read id; do
  echo "  - $id"
done

echo ""
echo "📝 步骤 3: 转录所有 chunks..."

# 构建 curl 命令
CURL_CMD="curl -s -X POST \"$API_BASE/api/transcribe\""
for id in $CHUNK_IDS; do
  CURL_CMD="$CURL_CMD -F \"upload_ids=$id\""
done

TRANSCRIBE_RESPONSE=$(eval $CURL_CMD)
TRANSCRIBED_TEXT=$(echo $TRANSCRIBE_RESPONSE | jq -r '.text')
FAILED_IDS=$(echo $TRANSCRIBE_RESPONSE | jq -r '.failed_chunk_ids // []')

if [ -n "$FAILED_IDS" ] && [ "$FAILED_IDS" != "[]" ]; then
  echo "⚠️  部分转录失败，失败的 chunk_ids:"
  echo "$FAILED_IDS" | jq -r '.[]' | while read id; do
    echo "  - $id"
  done
else
  echo "✅ 转录成功！"
fi

echo ""
echo "📄 转录文本（前 500 个字符）："
echo "$TRANSCRIBED_TEXT" | head -c 500
echo "..."
```

**使用方法：**
```bash
chmod +x test_flow.sh
./test_flow.sh
```

---

## 简化版本（不使用 jq）

如果你没有安装 `jq`，可以使用 Python 脚本：

```python
#!/usr/bin/env python3
import requests
import json
import sys

API_BASE = "http://127.0.0.1:8000"
AUDIO_FILE = "/path/to/your/audio.m4a"

# 步骤 1: 上传
print("🎵 步骤 1: 上传音频文件...")
with open(AUDIO_FILE, "rb") as f:
    response = requests.post(f"{API_BASE}/api/upload", files={"audio": f})
upload_data = response.json()
upload_id = upload_data["upload_id"]
print(f"✅ 上传成功，upload_id: {upload_id}")

# 步骤 2: 切割
print("\n✂️  步骤 2: 切割音频文件...")
response = requests.post(
    f"{API_BASE}/api/split",
    json={"upload_id": upload_id}
)
split_data = response.json()
chunks = split_data["chunks"]
print(f"✅ 切割成功，生成 {len(chunks)} 个 chunks")

# 步骤 3: 转录
print("\n📝 步骤 3: 转录所有 chunks...")
chunk_ids = [chunk["upload_id"] for chunk in chunks]
files = {f"upload_ids": chunk_ids}
response = requests.post(f"{API_BASE}/api/transcribe", files=files)
transcribe_data = response.json()

if transcribe_data.get("failed_chunk_ids"):
    print(f"⚠️  部分转录失败，失败的 chunk_ids: {transcribe_data['failed_chunk_ids']}")
else:
    print("✅ 转录成功！")

print(f"\n📄 转录文本（前 500 个字符）：")
print(transcribe_data["text"][:500] + "...")
```

---

## 常见问题

### 1. 如何查看详细的响应？

添加 `-v` 参数：
```bash
curl -v -X POST "http://127.0.0.1:8000/api/upload" -F "audio=@audio.m4a"
```

### 2. 如何格式化 JSON 响应？

使用 `jq`：
```bash
curl -s -X POST "..." | jq .
```

或使用 Python：
```bash
curl -s -X POST "..." | python -m json.tool
```

### 3. 如何测试单个小文件（跳过切割）？

直接使用 `transcribe` 端点：
```bash
curl -s -X POST "http://127.0.0.1:8000/api/transcribe" \
  -F "audio=@small_audio.m4a"
```

---

## 检查遗留文件

测试完成后，检查是否有遗留文件：

```bash
cd backend
python scan_orphaned_files.py
```

如果需要清理：

```bash
python scan_orphaned_files.py --clean
```
