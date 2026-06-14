# PPT/PPTX/PDF 转高清图片服务 (Shiny Spoon)

这是一个面向生产环境、高稳定性的文件转换与高清渲染 Node.js 服务。项目内置**高还原度渲染方案**（利用 Headless LibreOffice 将 PPT/PPTX 转为 PDF，再利用 Poppler `pdftoppm` 将 PDF 高质量渲染为 PNG），并原生支持直接接收 PDF 文件进行极速转换。

项目配备了一个**暗色玻璃拟态的前端管理后台**，支持上传进度显示、文件类型高亮（红色 PPT、绿色 PDF）、幻灯片大图及缩略图同步渲染、自动播放、全屏演示等功能。

---

## 🚀 核心机制与架构设计

项目针对生产环境中的高并发与资源消耗问题，进行了多项自我防御性重构：

```text
               ┌───────────────────────────────────────────────┐
               │    上传 PPT / PPTX / PDF 文件 (带 ID / 无 ID)  │
               └───────────────────────┬───────────────────────┘
                                       │
                                       ▼
               ┌───────────────────────────────────────────────┐
               │     并发控制队列 globalConversionQueue (2)     │
               │   (硬性限制至多2个转换任务并行, 防 CPU 100% 假死)  │
               └───────────────────────┬───────────────────────┘
                                       │ [队列调度执行]
                                       ▼
                         / 区分上传文件的扩展名 \
                        /                        \
                 ext === '.pdf'?              ext !== '.pdf'?
                      /                            \
                     /                              \
                    ▼                               ▼
       ┌─────────────────────────┐     ┌─────────────────────────┐
       │   PDF 直通拷贝 (跳过LO)  │     │  LibreOffice 无头模式   │
       │                         │     │  (限时120s防卡死 PPT->PDF)│
       └────────────┬────────────┘     └────────────┬────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
                       ┌─────────────────────────┐
                       │    Poppler pdftoppm     │
                       │ (限时120s PDF->高清 PNG) │
                       └────────────┬────────────┘
                                    │
                                    ▼
              ┌───────────────────────────────────────────┐
              │ 转换状态及路径关联存入 node:sqlite 数据库  │
              │ 输出存放于 output/{id}/ 文件夹确保物理隔离  │
              └───────────────────────────────────────────┘
```

---

## 🛠️ 前置环境要求

由于项目使用了 Node.js 原生的 SQLite 引擎，因此部署对 Node 版本有硬性要求：
* **Node.js 版本**：必须 **$\ge$ v22.5.0**（推荐使用 **Node.js 22.x LTS**）。
* **数据库依赖**：无需安装外部 SQLite 二进制或额外的 npm 驱动包，开箱即用。

---

## 🖥️ 裸机 Linux 服务器部署 (4核 8G)

### 1. 安装系统底层依赖
请根据您的 Linux 发行版，运行对应命令安装 LibreOffice、Poppler-utils 工具以及中文字体（防止中文字符无法显示导致乱码）。

#### Ubuntu / Debian 系列
```bash
sudo apt-get update

# 安装 LibreOffice Headless 转换器与 Poppler 工具
sudo apt-get install -y libreoffice poppler-utils fontconfig

# 安装中文字体库（强烈建议，否则 PPT 中文字体渲染会出现乱码）
sudo apt-get install -y fonts-wqy-zenhei fonts-wqy-microhei
```

#### CentOS / RHEL 系列
```bash
sudo yum update -y

# 安装依赖
sudo yum install -y libreoffice poppler-utils fontconfig

# 安装中文字体
sudo yum install -y wqy-zenhei-fonts wqy-microhei-fonts
```

### 2. Linux 性能调优 (防止 8G 内存 OOM)
4核 8G 的服务器虽然能完全胜任本服务，但如果有突发的大文件或多任务上传，物理内存可能会短暂告急。**强烈建议在部署时为服务器配置 Swap 分区（虚拟内存）**。

```bash
# 创建一个 4G 的 Swap 文件
sudo dd if=/dev/zero of=/swapfile bs=1M count=4096

# 设置权限
sudo chmod 600 /swapfile

# 格式化并启用 Swap
sudo mkswap /swapfile
sudo swapon /swapfile

# 设置永久生效：在 /etc/fstab 结尾追加一行：
# /swapfile swap swap defaults 0 0
```

### 3. 获取项目与部署运行
```bash
# 1. 克隆或解压代码至 /app
cd /app

# 2. 安装项目依赖
npm install --production

# 3. 配置环境变量 (可选)
# 在根目录新建 .env 文件进行微调：
# PORT=3000
# SOFFICE_PATH=/usr/bin/soffice
# PDFTOPPM_PATH=/usr/bin/pdftoppm
```

### 4. 使用 PM2 进行生产级进程守护
为防止 Node.js 服务因为崩溃或未知异常终止，并充分挖掘 4 核 CPU 的效能，推荐使用 PM2 启动服务（启动 2 个集群实例以提供热备）：

```bash
# 全局安装 pm2
npm install -g pm2

# 使用 Cluster 模式拉起服务并设置主堆内存上限限制 (512MB/实例)
pm2 start src/server.js -n "ppt-converter-service" -i 2 --node-args="--max-old-space-size=512"

# 保存 PM2 配置并设置开机自启
pm2 save
pm2 startup
```

---

## 🐳 Docker 容器化部署 (生产环境推荐)

使用 Docker 部署是**最省心且环境完全一致**的方案，我们基于 `node:22-slim` 定制了完全预装所有底层依赖及中文字体库的部署方案。

### 1. Dockerfile 配置
项目根目录下已提供配套的 `Dockerfile`：

```dockerfile
FROM node:22-slim

# 安装 LibreOffice Headless 运行环境、Poppler (pdftoppm) 工具、中文字体库和 fontconfig 诊断工具
RUN apt-get update && apt-get install -y \
    libreoffice \
    poppler-utils \
    fontconfig \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 将生产依赖拷贝并单独安装，利用 Docker 层缓存
COPY package*.json ./
RUN npm install --production

# 拷贝项目全部源码
COPY . .

# 暴露运行端口
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# 限制 Node 的最大堆内存为 1GB，防止无节制增长引发容器 OOM 被强杀
CMD ["node", "--max-old-space-size=1024", "src/server.js"]
```

### 2. Docker Compose 一键编排 (docker-compose.yml)
使用 `docker-compose` 可以极其方便地将物理存储盘挂载到宿主机，便于管理和持久化保留转换结果。

在根目录创建 `docker-compose.yml` 文件：

```yaml
version: '3.8'

services:
  ppt-converter:
    build: .
    container_name: ppt-converter-container
    restart: always
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - NODE_ENV=production
    volumes:
      # 将输入和输出目录挂载到宿主机，防止容器销毁时数据丢失
      - ./input:/app/input
      - ./output:/app/output
      # 持久化保存 sqlite 数据库文件
      - ./conversions.db:/app/conversions.db
    deploy:
      resources:
        limits:
          cpus: '3.0'         # 限制容器最多消耗 3 核 CPU，为系统预留 1 核
          memory: 3.5G        # 限制容器最多使用 3.5G 内存，防止撑爆宿主机
```

使用以下指令一键启动服务：
```bash
docker-compose up -d --build
```

---

## 📦 API 接口设计说明

后端服务为其他微服务（如您的主 Node.js 后端）暴露了极简的接口以进行系统级对接。

### 1. 检查底层依赖状态
* **请求**：`GET /api/status`
* **响应**：
  ```json
  {
    "libreOffice": { "path": "/usr/bin/soffice", "available": true, "version": "LibreOffice 24.2.x" },
    "poppler": { "path": "/usr/bin/pdftoppm", "available": true, "version": "pdftoppm version 22.02.x" }
  }
  ```

### 2. 上传文件触发转换 (PPT/PPTX/PDF)
* **请求**：`POST /api/upload`
* **请求体** (Multipart Form)：
  - `file`: 上传的 PPT, PPTX 或 PDF 文件。
  - `id`: (可选) 任务的唯一 ID，转换出的图片将保存在以该 ID 命名的 output 目录中。如未传，系统将自动生成 UUID。
* **响应**：
  ```json
  {
    "success": true,
    "message": "文件上传并成功转换为图片！",
    "id": "my_custom_task_001",
    "file": "test_sample.pdf",
    "pdfPath": "/app/output/my_custom_task_001/test_sample.pdf",
    "images": ["slide-1.png", "slide-2.png"],
    "baseName": "test_sample",
    "outputDir": "/app/output/my_custom_task_001"
  }
  ```

### 3. 获取所有转换任务列表
* **请求**：`GET /api/files`
* **响应** (JSON Array)：
  ```json
  [
    {
      "id": "my_custom_task_001",
      "name": "test_sample.pdf",
      "baseName": "test_sample",
      "size": 13264,
      "mtime": "2026-06-14T10:02:09.733Z",
      "converted": true,
      "imagesCount": 2,
      "images": ["slide-1.png", "slide-2.png"]
    }
  ]
  ```

### 4. 导出指定任务的全部高清图片
* **请求**：`GET /api/export/:id`
* **参数**：`:id` 为上传文件时设定的 ID 标识（如 `my_custom_task_001`）。
* **响应**：
  ```json
  {
    "success": true,
    "id": "my_custom_task_001",
    "filename": "test_sample.pdf",
    "converted": true,
    "outputDir": "/app/output/my_custom_task_001",
    "pdfPath": "/app/output/my_custom_task_001/test_sample.pdf",
    "pdfUrl": "/output/my_custom_task_001/test_sample.pdf",
    "images": ["slide-1.png", "slide-2.png"],
    "imageUrls": [
      "/output/my_custom_task_001/slide-1.png",
      "/output/my_custom_task_001/slide-2.png"
    ]
  }
  ```

### 5. 重新触发转换
* **请求**：`POST /api/convert/:id`
* **说明**：`:id` 可以是当时指定的自定义任务 ID，也可以是原文件名。

### 6. 清理删除转换记录与文件
* **请求**：`DELETE /api/delete/:id`
* **说明**：传入 ID 即可在毫秒级物理清理源文件、转换生成的全部高清 PNG 图片与 PDF 副本，并彻底删除 SQLite 数据库中该记录的信息。
