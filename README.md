# PPT/PPTX 转图片 Node.js 服务 (PPT to Image Converter)

这是一个面向生产环境、高稳定性且极度还原 PowerPoint 原生渲染效果的 Node.js 服务端项目。
核心采用 **LibreOffice Headless + Poppler (pdftoppm)** 方案。相较于各种纯 Javascript 实现，该方案渲染效果更优（直接调用 PowerPoint 内核渲染机制的开源替代）、支持大型 PPTX 文件、且能够很好地支持复杂的图形和版式。

项目配备了一个**毛玻璃幻灯片管理后台**，支持在线拖拽上传、手动/自动监控渲染、PDF及图片预览、自动播放、全屏演示等交互。

---

## 🚀 架构方案与核心原理

```text
         [上传 PPT / 放入 input 目录]
                      │
                      ▼
     [chokidar 监控监听] 或 [API 接收]
                      │
                      ▼
    [互斥队列 (ConversionQueue)] (规避并发冲突)
                      │
                      ▼
    [LibreOffice Headless] (PPT -> PDF)
                      │
                      ▼
    [Poppler pdftoppm] (PDF -> 高清 PNG 图片列表)
                      │
                      ▼
       [输出至 output 目录, 前端流式预览]
```

---

## 🛠️ 环境依赖安装

此服务在运行时依赖系统自带的二进制程序，请根据您的操作系统进行安装：

### 1. macOS (开发/测试环境)

通过 Homebrew 快速安装：
```bash
# 安装 LibreOffice (文档转换核心)
brew install --cask libreoffice

# 安装 Poppler-utils (PDF转图片工具，包含 pdftoppm)
brew install poppler
```
*注意：本服务会自动探测默认路径 `/Applications/LibreOffice.app/Contents/MacOS/soffice` 和 `/opt/homebrew/bin/pdftoppm`。*

### 2. Ubuntu / Debian (生产环境)

```bash
sudo apt-get update

# 安装 LibreOffice 无头模式与 Poppler 工具
sudo apt-get install -y libreoffice poppler-utils

# (关键) 解决 Linux 环境缺少中文字体导致的排版混乱/乱码问题
sudo apt-get install -y fonts-wqy-zenhei fonts-wqy-microhei
```

### 3. Docker 部署 (生产环境推荐)

为了免除系统环境配置的烦恼，我们提供了一个开箱即用的 `Dockerfile` 配置范本：

```dockerfile
FROM node:20-slim

# 安装 LibreOffice、Poppler 及中文字体库
RUN apt-get update && apt-get install -y \
    libreoffice \
    poppler-utils \
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# 暴露接口端口
EXPOSE 3000

CMD ["npm", "start"]
```

---

## ⚙️ 配置文件说明 (`.env`)

如果您的二进制文件路径不是默认路径，可以在项目根目录创建 `.env` 文件进行自定义配置：

```env
PORT=3000
# 自定义 LibreOffice 绝对路径
SOFFICE_PATH=/path/to/your/soffice
# 自定义 pdftoppm 绝对路径
PDFTOPPM_PATH=/path/to/your/pdftoppm
```

---

## 🏃 启动与运行

### 1. 安装项目依赖
```bash
npm install
```

### 2. 启动服务 (内置自动监听)
```bash
# 开发环境 (带文件热重载)
npm run dev

# 生产环境
npm start
```
服务启动后：
* 网页管理端：[http://localhost:3000](http://localhost:3000)
* 监控的输入目录：项目根目录的 `input/`
* 输出的图片目录：项目根目录的 `output/`

### 3. 两种使用模式
* **模式 A：文件夹监控（无代码侵入）**
  直接把 `.ppt` 或 `.pptx` 文件拷贝到项目的 `input/` 文件夹。底层的 Chokidar 监听模块检测到文件写入稳定后，会**自动**在 `output/[文件名]/` 下生成同名的 PDF 文件以及每一页的高清图片。
* **模式 B：Web 端交互（可视化控制）**
  访问 [http://localhost:3000](http://localhost:3000)，直接拖拽文件上传。网页中会呈现实时上传与转换进度。转换成功后，点击列表中的文件即可利用键盘左右方向键进行高清翻页和全屏演示。

---

## 📦 API 接口设计

如果您想将此转换逻辑嵌入到已有业务中，可以直接调用服务提供的 HTTP 接口：

* **GET `/api/status`**
  检查系统二进制依赖环境（LibreOffice / pdftoppm）是否可用以及当前版本。
* **GET `/api/files`**
  返回 `input/` 中所有 PPT 文档列表，及其转换结果（若已渲染，会返回所生成的全部 PNG 图像文件名列表）。
* **POST `/api/upload`**
  使用 `multipart/form-data` 上传 PPT/PPTX 文件，接口将同步等待转换完成后返回图片列表。
* **POST `/api/convert/:filename`**
  手动重新触发 `input/` 目录下指定文件的图片渲染转换。
* **DELETE `/api/delete/:filename`**
  彻底清理输入目录的源文件以及输出目录下的相关转换产物。
