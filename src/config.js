import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export const INPUT_DIR = path.resolve(rootDir, 'input');
export const OUTPUT_DIR = path.resolve(rootDir, 'output');

// 自动创建目录
if (!fs.existsSync(INPUT_DIR)) {
  fs.mkdirSync(INPUT_DIR, { recursive: true });
}
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 探测 LibreOffice 路径
export function getLibreOfficePath() {
  if (process.env.SOFFICE_PATH) {
    if (fs.existsSync(process.env.SOFFICE_PATH)) {
      return process.env.SOFFICE_PATH;
    }
    console.warn(`[Config] 环境变量指定的 SOFFICE_PATH 不存在: ${process.env.SOFFICE_PATH}`);
  }

  const platform = os.platform();
  if (platform === 'darwin') {
    const macPath = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    if (fs.existsSync(macPath)) {
      return macPath;
    }
  } else if (platform === 'win32') {
    const winPaths = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 尝试使用 system which/where 命令
  try {
    const checkCmd = platform === 'win32' ? 'where soffice' : 'which soffice';
    const stdout = execSync(checkCmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (stdout) {
      // where 可能会返回多行
      return stdout.split('\n')[0].trim();
    }
  } catch (err) {
    // which/where 未找到会报错，忽略
  }

  return 'soffice'; // 默认 fallback，如果它在全局 PATH 中可用
}

// 探测 Poppler (pdftoppm) 路径
export function getPdftoppmPath() {
  if (process.env.PDFTOPPM_PATH) {
    if (fs.existsSync(process.env.PDFTOPPM_PATH)) {
      return process.env.PDFTOPPM_PATH;
    }
    console.warn(`[Config] 环境变量指定的 PDFTOPPM_PATH 不存在: ${process.env.PDFTOPPM_PATH}`);
  }

  const platform = os.platform();
  if (platform === 'darwin') {
    const macPaths = [
      '/opt/homebrew/bin/pdftoppm',
      '/usr/local/bin/pdftoppm'
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 尝试使用 system which/where 命令
  try {
    const checkCmd = platform === 'win32' ? 'where pdftoppm' : 'which pdftoppm';
    const stdout = execSync(checkCmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (stdout) {
      return stdout.split('\n')[0].trim();
    }
  } catch (err) {
    // 忽略
  }

  return 'pdftoppm'; // 默认 fallback
}

// 检查依赖是否真正可用
export function checkDependencies() {
  const status = {
    libreOffice: {
      path: getLibreOfficePath(),
      available: false,
      version: null,
      error: null
    },
    poppler: {
      path: getPdftoppmPath(),
      available: false,
      version: null,
      error: null
    }
  };

  // 验证 LibreOffice
  try {
    const soffice = status.libreOffice.path;
    // 尝试执行 soffice --version
    const stdout = execSync(`"${soffice}" --version`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    status.libreOffice.available = true;
    status.libreOffice.version = stdout;
  } catch (err) {
    status.libreOffice.error = `无法运行 LibreOffice。请确认是否安装。错误: ${err.message}`;
  }

  // 验证 pdftoppm
  try {
    const pdftoppm = status.poppler.path;
    // pdftoppm -v 的版本输出可能在 stderr 里
    const stdout = execSync(`"${pdftoppm}" -v`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    status.poppler.available = true;
    status.poppler.version = stdout.split('\n')[0]; // 取第一行
  } catch (err) {
    // 有些版本的 pdftoppm -v 返回非0退出码或将输出写到 stderr
    if (err.stderr && err.stderr.toString().includes('pdftoppm version')) {
      status.poppler.available = true;
      status.poppler.version = err.stderr.toString().trim().split('\n')[0];
    } else {
      status.poppler.error = `无法运行 pdftoppm。请确认是否安装 poppler-utils。错误: ${err.message}`;
    }
  }

  return status;
}

// 动态获取系统默认的高质量中文兜底字体
function getSystemDefaultFont() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return 'STHeiti'; // Mac 平台默认使用华文黑体
  }
  return 'WenQuanYi Zen Hei'; // Linux 生产环境默认使用文泉驿正黑（对应 Dockerfile 中安装的字体）
}

// 动态生成 fontconfig 配置文件
export function generateFontConfig() {
  const defaultFont = getSystemDefaultFont();
  const configContent = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <!-- 引入系统默认的 fontconfig 主配置文件，确保加载系统已安装的所有字体 -->
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <include ignore_missing="yes">/opt/homebrew/etc/fonts/fonts.conf</include>
  <include ignore_missing="yes">/usr/local/etc/fonts/fonts.conf</include>
  
  <!-- 兜底包含系统的通用字体目录 -->
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir>/System/Library/Fonts</dir>

  <!-- 1. 强制常见中英文字体映射，避免粗细不均与乱码 -->
  <match target="pattern">
    <test qual="any" name="family">
      <string>Microsoft YaHei</string>
    </test>
    <edit name="family" mode="assign" binding="same">
      <string>${defaultFont}</string>
    </edit>
  </match>
  <match target="pattern">
    <test qual="any" name="family">
      <string>微软雅黑</string>
    </test>
    <edit name="family" mode="assign" binding="same">
      <string>${defaultFont}</string>
    </edit>
  </match>
  <match target="pattern">
    <test qual="any" name="family">
      <string>SimSun</string>
    </test>
    <edit name="family" mode="assign" binding="same">
      <string>${defaultFont}</string>
    </edit>
  </match>
  <match target="pattern">
    <test qual="any" name="family">
      <string>宋体</string>
    </test>
    <edit name="family" mode="assign" binding="same">
      <string>${defaultFont}</string>
    </edit>
  </match>
  <match target="pattern">
    <test qual="any" name="family">
      <string>SimHei</string>
    </test>
    <edit name="family" mode="assign" binding="same">
      <string>${defaultFont}</string>
    </edit>
  </match>
  <match target="pattern">
    <test qual="any" name="family">
      <string>黑体</string>
    </test>
    <edit name="family" mode="assign" binding="same">
      <string>${defaultFont}</string>
    </edit>
  </match>
  <match target="pattern">
    <test qual="any" name="family">
      <string>Arial</string>
    </test>
    <edit name="family" mode="assign" binding="same">
      <string>sans-serif</string>
    </edit>
  </match>

  <!-- 2. 全局无衬线(sans-serif)缺失字体统一优先回退到默认中文 -->
  <alias>
    <family>sans-serif</family>
    <prefer>
      <family>${defaultFont}</family>
      <family>DejaVu Sans</family>
      <family>Liberation Sans</family>
    </prefer>
  </alias>
</fontconfig>`;

  const configPath = path.resolve(OUTPUT_DIR, 'temp_fonts.conf');
  fs.writeFileSync(configPath, configContent, 'utf8');
  return configPath;
}

