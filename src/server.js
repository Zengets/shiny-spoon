import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { INPUT_DIR, OUTPUT_DIR, checkDependencies } from './config.js';
import { convertPptToImages } from './converter.js';
import { startWatcher, ignoreWatcherFiles } from './watcher.js';
import * as db from './db.js';

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

// 允许直接访问接口文档页面
app.get('/api.html', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../api.html'));
});

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
    if (ext === '.ppt' || ext === '.pptx' || ext === '.pdf') {
      cb(null, true);
    } else {
      cb(new Error('仅支持上传 .ppt、.pptx 或 .pdf 格式文档'));
    }
  }
});

// API 1: 检查系统依赖环境
app.get('/status', (req, res) => {
  const status = checkDependencies();
  res.json(status);
});

// API 2: 获取输入目录下的文档列表及其转换状态（基于 SQLite 数据库）
app.get('/files', (req, res) => {
  try {
    const records = db.getAllConversions();
    
    const fileList = records.map(record => {
      const targetDir = record.output_dir;
      let converted = record.converted === 1;
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
        } else {
          converted = false;
        }
      } else {
        converted = false;
      }

      // 获取文件物理大小和修改时间
      let size = 0;
      let mtime = new Date(record.created_at);
      if (fs.existsSync(record.file_path)) {
        const stat = fs.statSync(record.file_path);
        size = stat.size;
        mtime = stat.mtime;
      }

      return {
        id: record.id,
        name: record.filename,
        baseName: path.basename(record.filename, path.extname(record.filename)),
        size,
        mtime,
        converted,
        imagesCount: images.length,
        images
      };
    });

    res.json(fileList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 3: 上传 PPT/PPTX/PDF 文件并自动触发转换，支持传递自定义 ID
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未接收到有效文件。' });
  }
  const filePath = req.file.path;
  const fileName = req.file.filename;
  // 获取传递的 ID，若无则自动生成 UUID
  const id = req.body.id || crypto.randomUUID();

  // 临时加入忽略列表，阻止 Watcher 重复执行转换
  ignoreWatcherFiles.add(fileName);

  try {
    console.log(`[Server] 接收到上传文件: ${fileName}，分配 ID: ${id}，开始转换...`);
    const convertResult = await convertPptToImages(filePath, id);
    res.json({
      success: true,
      message: '文件上传并成功转换为图片！',
      id,
      file: fileName,
      ...convertResult
    });
  } catch (err) {
    console.error(`[Server] 文件 ${fileName} (ID: ${id}) 转换失败: ${err.message}`);
    res.status(500).json({ 
      success: false,
      id,
      error: `文件已保存，但图片转换失败。原因: ${err.message}` 
    });
  } finally {
    // 延迟 3 秒从忽略列表中移除，确保 Watcher 已跳过 add 周期
    setTimeout(() => {
      ignoreWatcherFiles.delete(fileName);
    }, 3000);
  }
});

// API 4: 手动重新触发某个已有记录的转换 (ID 或 文件名)
app.post('/convert/:id', async (req, res) => {
  const id = req.params.id;
  
  // 先去数据库查
  const record = db.getConversion(id);
  let filePath = '';
  let filename = id;

  if (record) {
    filePath = record.file_path;
    filename = record.filename;
  } else {
    // 兼容以前只用 filename 的逻辑
    filePath = path.resolve(INPUT_DIR, id);
    filename = id;
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `在输入目录中找不到源文件: ${filename}` });
  }

  // 临时加入忽略列表，阻止 Watcher 响应
  ignoreWatcherFiles.add(filename);

  try {
    console.log(`[Server] 手动触发转换: ${filename} (ID: ${id})...`);
    const convertResult = await convertPptToImages(filePath, id);
    res.json({
      success: true,
      message: '重新转换成功！',
      id,
      file: filename,
      ...convertResult
    });
  } catch (err) {
    console.error(`[Server] 手动触发 ${filename} 转换失败: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: `转换失败。原因: ${err.message}` 
    });
  } finally {
    setTimeout(() => {
      ignoreWatcherFiles.delete(filename);
    }, 3000);
  }
});

// API 5: 删除输入源文件和对应的输出结果及数据库记录 (通过 ID)
app.delete('/delete/:id', (req, res) => {
  const id = req.params.id;
  
  try {
    const record = db.getConversion(id);
    let filePath = '';
    let outDir = '';
    let filename = id;

    if (record) {
      filePath = record.file_path;
      outDir = record.output_dir;
      filename = record.filename;
    } else {
      // 兼容以前只用 filename 的逻辑
      const ext = path.extname(id);
      const baseName = path.basename(id, ext);
      filePath = path.resolve(INPUT_DIR, id);
      outDir = path.resolve(OUTPUT_DIR, baseName);
    }

    let deletedSource = false;
    let deletedOutput = false;

    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        deletedSource = true;
        console.log(`[Server] 已删除源文件: ${filePath}`);
      } catch (e) {
        console.error(`[Server] 删除源文件失败: ${filePath}`, e);
      }
    }

    if (outDir && fs.existsSync(outDir)) {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
        deletedOutput = true;
        console.log(`[Server] 已删除输出目录: ${outDir}`);
      } catch (e) {
        console.error(`[Server] 删除输出文件夹失败: ${outDir}`, e);
      }
    }

    // 从数据库中移除记录
    db.deleteConversion(id);

    if (deletedSource || deletedOutput || record) {
      res.json({ 
        success: true, 
        message: '删除成功！', 
        deletedSource, 
        deletedOutput 
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: '找不到该记录或文件，无法删除。' 
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API 6: 导出指定 ID 文件夹下的所有转换图片 URL 及 PDF 路径
app.get('/export/:id', (req, res) => {
  const id = req.params.id;
  try {
    const record = db.getConversion(id);
    if (!record) {
      return res.status(404).json({ success: false, error: `找不到 ID 为 ${id} 的转换记录。` });
    }

    const outputDir = record.output_dir;
    if (!fs.existsSync(outputDir)) {
      return res.status(404).json({ success: false, error: `该记录的输出物理目录已不存在。` });
    }

    const files = fs.readdirSync(outputDir);
    const images = files
      .filter(f => f.startsWith('slide-') && f.endsWith('.png'))
      .sort((a, b) => {
        const matchA = a.match(/slide-(\d+)\.png/);
        const matchB = b.match(/slide-(\d+)\.png/);
        if (!matchA || !matchB) return 0;
        return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
      });

    const pdfFile = files.find(f => f.endsWith('.pdf'));

    res.json({
      success: true,
      id: record.id,
      filename: record.filename,
      converted: record.converted === 1,
      outputDir: outputDir,
      pdfPath: pdfFile ? path.resolve(outputDir, pdfFile) : null,
      pdfUrl: pdfFile ? `/output/${encodeURIComponent(record.id)}/${encodeURIComponent(pdfFile)}` : null,
      images: images,
      imageUrls: images.map(img => `/output/${encodeURIComponent(record.id)}/${encodeURIComponent(img)}`)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
