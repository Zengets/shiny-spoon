import chokidar from 'chokidar';
import path from 'path';
import { INPUT_DIR } from './config.js';
import { convertPptToImages } from './converter.js';

// 用于存放被 API 接管的文件名，避免 Watcher 与 API 同时触发转换造成文件抢占
export const ignoreWatcherFiles = new Set();

export function startWatcher() {
  console.log(`[Watcher] 正在启动输入目录监听: ${INPUT_DIR}`);

  const watcher = chokidar.watch(INPUT_DIR, {
    ignored: [
      /(^|[\/\\])\../,     // 忽略隐藏文件 (.开头)
      /~\$/               // 忽略 Microsoft Office 的临时占位文件
    ],
    persistent: true,
    ignoreInitial: true,  // 启动时忽略已有文件，避免重复触发转换（已有文件可通过 Web 界面手动触发）
    awaitWriteFinish: {
      stabilityThreshold: 1500, // 确保文件写入完成 1.5 秒且大小不再改变后才触发
      pollInterval: 100
    }
  });

  watcher.on('add', async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);

    if (ignoreWatcherFiles.has(fileName)) {
      console.log(`[Watcher] 忽略由 API 处理的文件: ${fileName}`);
      return;
    }

    if (ext === '.pptx' || ext === '.ppt' || ext === '.pdf') {
      console.log(`[Watcher] [自动触发] 检测到新文件: ${fileName}`);
      try {
        await convertPptToImages(filePath);
        console.log(`[Watcher] [自动触发] 转换成功: ${fileName}`);
      } catch (err) {
        console.error(`[Watcher] [自动触发] 转换失败: ${fileName}。原因: ${err.message}`);
      }
    }
  });

  watcher.on('change', async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);

    if (ignoreWatcherFiles.has(fileName)) {
      console.log(`[Watcher] 忽略由 API 修改的文件: ${fileName}`);
      return;
    }

    if (ext === '.pptx' || ext === '.ppt' || ext === '.pdf') {
      console.log(`[Watcher] [自动触发] 检测到文件修改: ${fileName}`);
      try {
        await convertPptToImages(filePath);
        console.log(`[Watcher] [自动触发] 重新转换成功: ${fileName}`);
      } catch (err) {
        console.error(`[Watcher] [自动触发] 重新转换失败: ${fileName}。原因: ${err.message}`);
      }
    }
  });

  watcher.on('error', (error) => {
    console.error(`[Watcher] 监听器报错: ${error.message}`);
  });

  return watcher;
}
