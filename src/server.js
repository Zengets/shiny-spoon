import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INPUT_DIR, OUTPUT_DIR, checkDependencies } from './config.js';
import { convertPptToImages } from './converter.js';
import { startWatcher, ignoreWatcherFiles } from './watcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 静态文件托管
app.use(express.static(path.resolve(__dirname, '../public')));
// 允许前端直接访问已转换的输出图片
app.use('/output', express.static(OUTPUT_DIR));

// 配置 multer 上传，修复中文文件名可能出现的乱码问题
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, INPUT_DIR);
  },
  filename: (req, file, cb) => {
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, originalName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.ppt' || ext === '.pptx') {
      cb(null, true);
    } else {
      cb(new Error('仅支持上传 .ppt 或 .pptx 格式幻灯片文档'));
    }
  }
});

// API 1: 检查系统依赖环境
app.get('/api/status', (req, res) => {
  const status = checkDependencies();
  res.json(status);
});

// API 2: 获取输入目录下的 PPT 文件列表及其转换状态
app.get('/api/files', (req, res) => {
  try {
    if (!fs.existsSync(INPUT_DIR)) {
      return res.json([]);
    }

    const files = fs.readdirSync(INPUT_DIR);
    const pptFiles = files.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return (ext === '.ppt' || ext === '.pptx') && !f.startsWith('~$');
    });

    const fileList = pptFiles.map(filename => {
      const ext = path.extname(filename);
      const baseName = path.basename(filename, ext);
      const fullPath = path.resolve(INPUT_DIR, filename);
      const stat = fs.statSync(fullPath);

      const targetDir = path.resolve(OUTPUT_DIR, baseName);
      let converted = false;
      let images = [];

      if (fs.existsSync(targetDir)) {
        const outFiles = fs.readdirSync(targetDir);
        images = outFiles
          .filter(f => f.startsWith('slide-') && f.endsWith('.png'))
          .sort((a, b) => {
            const matchA = a.match(/slide-(\d+)\.png/);
            const matchB = b.match(/slide-(\d+)\.png/);
            if (!matchA || !matchB) return 0;
            return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
          });
        if (images.length > 0) {
          converted = true;
        }
      }

      return {
        name: filename,
        baseName,
        size: stat.size,
        mtime: stat.mtime,
        converted,
        imagesCount: images.length,
        images
      };
    });

    // 默认按修改时间最新排在前
    fileList.sort((a, b) => b.mtime - a.mtime);
    res.json(fileList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 3: 上传 PPT/PPTX 文件并自动触发转换
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未接收到有效文件。' });
  }
  const filePath = req.file.path;
  const fileName = req.file.filename;

  // 临时加入忽略列表，阻止 Watcher 重复执行转换
  ignoreWatcherFiles.add(fileName);

  try {
    console.log(`[Server] 接收到上传文件: ${fileName}，开始执行转换流程...`);
    const convertResult = await convertPptToImages(filePath);
    res.json({
      success: true,
      message: '文件上传并成功转换为图片！',
      file: fileName,
      ...convertResult
    });
  } catch (err) {
    console.error(`[Server] 文件 ${fileName} 上传后转换失败: ${err.message}`);
    res.status(500).json({ 
      success: false,
      error: `文件已成功保存，但图片转换失败。原因: ${err.message}` 
    });
  } finally {
    // 延迟 3 秒从忽略列表中移除，确保 Watcher 已跳过 add 周期
    setTimeout(() => {
      ignoreWatcherFiles.delete(fileName);
    }, 3000);
  }
});

// API 4: 手动重新触发某个已有文件的转换
app.post('/api/convert/:filename', async (req, res) => {
  const fileName = req.params.filename;
  const filePath = path.resolve(INPUT_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `在输入目录中找不到源文件: ${fileName}` });
  }

  // 临时加入忽略列表，阻止 Watcher 响应 change/add 周期
  ignoreWatcherFiles.add(fileName);

  try {
    console.log(`[Server] 手动触发转换: ${fileName}...`);
    const convertResult = await convertPptToImages(filePath);
    res.json({
      success: true,
      message: '重新转换成功！',
      file: fileName,
      ...convertResult
    });
  } catch (err) {
    console.error(`[Server] 手动触发 ${fileName} 转换失败: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: `转换失败。原因: ${err.message}` 
    });
  } finally {
    setTimeout(() => {
      ignoreWatcherFiles.delete(fileName);
    }, 3000);
  }
});

// API 5: 删除输入源文件和对应的输出结果
app.delete('/api/delete/:filename', (req, res) => {
  const fileName = req.params.filename;
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);

  const filePath = path.resolve(INPUT_DIR, fileName);
  const outDir = path.resolve(OUTPUT_DIR, baseName);

  let deletedSource = false;
  let deletedOutput = false;

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      deletedSource = true;
      console.log(`[Server] 已删除源文件: ${filePath}`);
    } catch (e) {
      console.error(`[Server] 删除源文件失败: ${filePath}`, e);
    }
  }

  if (fs.existsSync(outDir)) {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      deletedOutput = true;
      console.log(`[Server] 已删除输出目录: ${outDir}`);
    } catch (e) {
      console.error(`[Server] 删除输出文件夹失败: ${outDir}`, e);
    }
  }

  if (deletedSource || deletedOutput) {
    res.json({ 
      success: true, 
      message: '删除成功！', 
      deletedSource, 
      deletedOutput 
    });
  } else {
    res.status(404).json({ 
      success: false, 
      error: '找不到该文件，无法删除。' 
    });
  }
});

// 异常捕获中间件
app.use((err, req, res, next) => {
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  🚀 PPT 转图片服务端启动成功!`);
  console.log(`  🌐 服务地址: http://localhost:${PORT}`);
  console.log(`  📂 监控输入目录: ${INPUT_DIR}`);
  console.log(`  📂 输出图片目录: ${OUTPUT_DIR}`);
  console.log(`=======================================================`);

  // 启动文件夹监听
  startWatcher();
});
