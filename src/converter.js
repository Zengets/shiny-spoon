import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { getLibreOfficePath, getPdftoppmPath, OUTPUT_DIR, generateFontConfig } from './config.js';

const execAsync = util.promisify(exec);

// 互斥转换队列，避免多个 LibreOffice 实例并发冲突导致挂起
class ConversionQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  push(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.next();
    });
  }

  async next() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const { task, resolve, reject } = this.queue.shift();
    try {
      const result = await task();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.processing = false;
      this.next();
    }
  }
}

const libreofficeQueue = new ConversionQueue();

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
      }
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
    await execAsync(cmd);
    
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
export async function convertPptToImages(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`输入文件不存在: ${inputPath}`);
  }

  const ext = path.extname(inputPath);
  const baseName = path.basename(inputPath, ext);
  
  // 在 outputDir 下为该文件创建一个专属文件夹，存放最终的 PDF 与 PNG 图片
  const fileOutputDir = path.resolve(OUTPUT_DIR, baseName);
  if (!fs.existsSync(fileOutputDir)) {
    fs.mkdirSync(fileOutputDir, { recursive: true });
  }
  
  // 1. PPT -> PDF (进入排队，保证单实例稳定性)
  console.log(`[Converter] [排队] PPTX 到 PDF 转换开始: ${baseName}`);
  const pdfPath = await libreofficeQueue.push(() => convertToPdf(inputPath, fileOutputDir));
  console.log(`[Converter] [成功] PDF 转换完成: ${pdfPath}`);
  
  // 2. PDF -> PNG
  console.log(`[Converter] PDF 到 PNG 渲染开始...`);
  const imagePaths = await convertPdfToPng(pdfPath, fileOutputDir);
  console.log(`[Converter] [成功] PNG 渲染完成，共 ${imagePaths.length} 张图片`);
  
  return {
    pdfPath,
    images: imagePaths.map(p => path.basename(p)), // 仅返回文件名，路径可通过 api 拼接
    baseName
  };
}
