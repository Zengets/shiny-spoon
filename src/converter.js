import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { getLibreOfficePath, getPdftoppmPath, OUTPUT_DIR, generateFontConfig } from './config.js';
import { saveConversion } from './db.js';

const execAsync = util.promisify(exec);

// 互斥转换队列，避免多个 LibreOffice 实例并发冲突导致挂起
class ConversionQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.activeCount = 0;
    this.queue = [];
  }

  push(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.next();
    });
  }

  async next() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
    this.activeCount++;
    const { task, resolve, reject } = this.queue.shift();
    try {
      const result = await task();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.activeCount--;
      this.next();
    }
  }
}

const globalConversionQueue = new ConversionQueue(2);

/**
 * 将 PPT/PPTX 文件转换为 PDF
 * @param {string} inputPath 绝对路径
 * @param {string} tempOutputDir 临时输出目录
 */
async function convertToPdf(inputPath, tempOutputDir) {
  const soffice = getLibreOfficePath();
  
  // 清理可能遗留的同名 PDF，避免 LibreOffice 提示覆盖或冲突
  const ext = path.extname(inputPath);
  const baseName = path.basename(inputPath, ext);
  const expectedPdfPath = path.resolve(tempOutputDir, `${baseName}.pdf`);
  
  if (fs.existsSync(expectedPdfPath)) {
    try {
      fs.unlinkSync(expectedPdfPath);
    } catch (e) {
      // 忽略
    }
  }

  // 动态生成临时字体配置，规避由于缺失字体导致的粗细不均/乱码问题
  const fontConfigPath = generateFontConfig();

  // 命令行参数加双引号避免路径中空格报错
  const cmd = `"${soffice}" --headless --convert-to pdf --outdir "${tempOutputDir}" "${inputPath}"`;
  
  console.log(`[Converter] 执行 LibreOffice 转换: ${cmd}`);
  
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      env: {
        ...process.env,
        FONTCONFIG_FILE: fontConfigPath
      },
      timeout: 120000 // 限制最长执行 120 秒，防僵尸进程挂起
    });
    
    if (!fs.existsSync(expectedPdfPath)) {
      throw new Error(`转换完成但未找到生成的 PDF 文件。stdout: ${stdout}, stderr: ${stderr}`);
    }
    
    return expectedPdfPath;
  } catch (err) {
    throw new Error(`LibreOffice 转换命令执行失败: ${err.message}`);
  }
}

/**
 * 将 PDF 文件渲染为高质量 PNG 图片列表
 * @param {string} pdfPath PDF文件路径
 * @param {string} outputSubDir 图片输出子目录
 */
async function convertPdfToPng(pdfPath, outputSubDir) {
  const pdftoppm = getPdftoppmPath();
  
  // 清理输出目录下之前的幻灯片图片，避免数量变化时有遗留的旧幻灯片
  if (fs.existsSync(outputSubDir)) {
    const oldFiles = fs.readdirSync(outputSubDir);
    for (const f of oldFiles) {
      if (f.startsWith('slide-') && f.endsWith('.png')) {
        try {
          fs.unlinkSync(path.resolve(outputSubDir, f));
        } catch (e) {}
      }
    }
  } else {
    fs.mkdirSync(outputSubDir, { recursive: true });
  }

  // -png: 生成 png 格式
  // -r 150: 设置 150 DPI，平衡清晰度与文件体积
  const prefix = path.resolve(outputSubDir, 'slide');
  const cmd = `"${pdftoppm}" -png -r 150 "${pdfPath}" "${prefix}"`;
  
  console.log(`[Converter] 执行 pdftoppm 转换: ${cmd}`);
  
  try {
    await execAsync(cmd, {
      timeout: 120000 // 限制最长执行 120 秒，防 pdftoppm 卡死
    });
    
    // 读取生成的文件列表并以数字大小进行正确排序
    const files = fs.readdirSync(outputSubDir);
    const images = files
      .filter(f => f.startsWith('slide-') && f.endsWith('.png'))
      .sort((a, b) => {
        const matchA = a.match(/slide-(\d+)\.png/);
        const matchB = b.match(/slide-(\d+)\.png/);
        if (!matchA || !matchB) return 0;
        return parseInt(matchA[1], 10) - parseInt(matchB[1], 10);
      });
      
    return images.map(img => path.resolve(outputSubDir, img));
  } catch (err) {
    throw new Error(`pdftoppm 转换命令执行失败: ${err.message}`);
  }
}

/**
 * PPT 转换主函数入口
 * @param {string} inputPath PPT 文件路径
 * @returns {Promise<{ pdfPath: string, images: string[], baseName: string }>}
 */
export async function convertPptToImages(inputPath, id = null) {
  return globalConversionQueue.push(() => executeConversion(inputPath, id));
}

async function executeConversion(inputPath, id) {
  const ext = path.extname(inputPath).toLowerCase();
  const baseName = path.basename(inputPath, ext);
  
  // 转换后存放的文件夹以传递的 ID 命名；如果未传 id 则使用 baseName 作为回退
  const folderName = id || baseName;
  const fileOutputDir = path.resolve(OUTPUT_DIR, folderName);
  
  if (!fs.existsSync(fileOutputDir)) {
    fs.mkdirSync(fileOutputDir, { recursive: true });
  }

  const finalId = id || baseName;
  let pdfPath;
  let imagePaths;

  try {
    if (ext === '.pdf') {
      // 如果是 PDF 文件，直接复制到输出文件夹作为备份，或直接作为 PDF 路径
      pdfPath = path.resolve(fileOutputDir, `${baseName}.pdf`);
      fs.copyFileSync(inputPath, pdfPath);
      console.log(`[Converter] 输入为 PDF，直接开始 PDF 到 PNG 渲染: ${baseName}`);
    } else {
      // 1. PPT -> PDF
      console.log(`[Converter] [执行] PPTX 到 PDF 转换开始: ${baseName}`);
      pdfPath = await convertToPdf(inputPath, fileOutputDir);
      console.log(`[Converter] [成功] PDF 转换完成: ${pdfPath}`);
    }
    
    // 2. PDF -> PNG
    console.log(`[Converter] [执行] PDF 到 PNG 渲染开始...`);
    imagePaths = await convertPdfToPng(pdfPath, fileOutputDir);
    console.log(`[Converter] [成功] PNG 渲染完成，共 ${imagePaths.length} 张图片`);
    
    const result = {
      pdfPath,
      images: imagePaths.map(p => path.basename(p)), // 仅返回文件名
      baseName,
      outputDir: fileOutputDir
    };

    // 存库：转换成功
    try {
      saveConversion({
        id: finalId,
        filename: path.basename(inputPath),
        filePath: inputPath,
        outputDir: fileOutputDir,
        converted: 1,
        imagesCount: result.images.length
      });
    } catch (dbErr) {
      console.error(`[Converter] 写入数据库失败: ${dbErr.message}`);
    }

    return result;
  } catch (err) {
    // 存库：转换失败
    try {
      saveConversion({
        id: finalId,
        filename: path.basename(inputPath),
        filePath: inputPath,
        outputDir: fileOutputDir,
        converted: 0,
        imagesCount: 0
      });
    } catch (dbErr) {
      console.error(`[Converter] 写入数据库失败: ${dbErr.message}`);
    }
    throw err;
  }
}
