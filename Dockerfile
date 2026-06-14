FROM node:22-slim

# 更换 Debian 软件源为阿里云镜像站，解决国内网络环境下载超时及断连问题
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources; \
    else \
      sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list; \
    fi

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

# 创建必要的文件目录
RUN mkdir -p input output

# 暴露运行端口
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# 限制 Node 的最大堆内存为 512MB，以在 2GB 限制内为外部 C++ 进程 (LibreOffice 等) 预留 1.5GB 内存
CMD ["node", "--max-old-space-size=512", "src/server.js"]
