// ==========================================================================
// 前端应用交互逻辑
// ==========================================================================

const API_BASE = '';
let filesList = [];
let activeFile = null;
let currentSlideIndex = 0;
let playIntervalId = null;

// DOM 元素缓存
const elements = {
  libreStatus: document.getElementById('libreoffice-status'),
  popplerStatus: document.getElementById('poppler-status'),
  depWarning: document.getElementById('dependency-warning'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  progressContainer: document.getElementById('upload-progress-container'),
  progressStatus: document.getElementById('progress-status'),
  progressPercent: document.getElementById('progress-percent'),
  progressFill: document.getElementById('progress-fill'),
  fileListContainer: document.getElementById('file-list-container'),
  btnRefresh: document.getElementById('btn-refresh'),
  
  // 预览状态
  previewPane: document.getElementById('preview-pane'),
  emptyState: document.getElementById('preview-empty-state'),
  unconvertedState: document.getElementById('preview-unconverted-state'),
  viewerState: document.getElementById('preview-viewer-state'),
  unconvertedTitle: document.getElementById('unconverted-title'),
  btnTriggerConvert: document.getElementById('btn-trigger-convert'),
  
  // 播放器组件
  viewerTitle: document.getElementById('viewer-title'),
  btnDownloadPdf: document.getElementById('btn-download-pdf'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  mainSlideImg: document.getElementById('main-slide-img'),
  slideImgLoader: document.getElementById('slide-img-loader'),
  btnPrevSlide: document.getElementById('btn-prev-slide'),
  btnNextSlide: document.getElementById('btn-next-slide'),
  slideCounter: document.getElementById('slide-counter'),
  btnPlaySlides: document.getElementById('btn-play-slides'),
  thumbnailContainer: document.getElementById('thumbnail-container')
};

// ==========================================================================
// 初始化与状态检测
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  checkSystemStatus();
  fetchFiles();
  setupEventListeners();
  // 渲染 Lucide 图标
  lucide.createIcons();
});

// 检测服务端依赖环境
async function checkSystemStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/status`);
    const status = await res.json();
    
    // 更新 LibreOffice 状态
    updateStatusIndicator(elements.libreStatus, status.libreOffice.available, `LibreOffice: ${status.libreOffice.available ? '已就绪' : '未安装'}`);
    
    // 更新 Poppler 状态
    updateStatusIndicator(elements.popplerStatus, status.poppler.available, `Poppler (pdftoppm): ${status.poppler.available ? '已就绪' : '未安装'}`);
    
    // 显示/隐藏安装指南
    if (!status.libreOffice.available || !status.poppler.available) {
      elements.depWarning.classList.remove('hidden');
    } else {
      elements.depWarning.classList.add('hidden');
    }
  } catch (err) {
    console.error('检测系统状态失败:', err);
  }
}

function updateStatusIndicator(element, isAvailable, text) {
  const indicator = element.querySelector('.status-indicator');
  const textEl = element.querySelector('.status-text');
  
  textEl.textContent = text;
  indicator.className = 'status-indicator'; // reset
  
  if (isAvailable) {
    indicator.classList.add('success');
  } else {
    indicator.classList.add('danger');
  }
}

// ==========================================================================
// 文件管理与 API 调用
// ==========================================================================

// 获取输入目录中的文件列表
async function fetchFiles(selectFilename = null) {
  try {
    const res = await fetch(`${API_BASE}/api/files`);
    filesList = await res.json();
    
    renderFileList(filesList);
    
    // 如果有指定选中的文件，或者之前有选中且该文件仍在列表中
    if (selectFilename) {
      const found = filesList.find(f => f.name === selectFilename);
      if (found) selectFile(found);
    } else if (activeFile) {
      const found = filesList.find(f => f.name === activeFile.name);
      if (found) {
        selectFile(found);
      } else {
        showState('empty');
      }
    }
  } catch (err) {
    elements.fileListContainer.innerHTML = `
      <div class="list-placeholder">
        <i data-lucide="alert-circle" style="color: var(--color-danger)"></i>
        <p>无法拉取文件列表，请检查网络连接。</p>
      </div>
    `;
    lucide.createIcons();
  }
}

// 渲染文件列表
function renderFileList(files) {
  if (files.length === 0) {
    elements.fileListContainer.innerHTML = `
      <div class="list-placeholder">
        <i data-lucide="folder-open"></i>
        <p>输入目录暂无 PPT 文件，请上传</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }
  
  elements.fileListContainer.innerHTML = '';
  
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = `file-item ${activeFile && activeFile.name === file.name ? 'active' : ''}`;
    
    const sizeStr = formatBytes(file.size);
    const dateStr = new Date(file.mtime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute:'2-digit' });
    const badgeHtml = file.converted 
      ? `<span class="badge success">已渲染 (${file.imagesCount}P)</span>` 
      : `<span class="badge pending">未渲染</span>`;
      
    item.innerHTML = `
      <div class="file-info">
        <div class="file-icon-box">
          <i data-lucide="presentation" style="width: 18px; height: 18px;"></i>
        </div>
        <div class="file-details">
          <div class="file-name" title="${file.name}">${file.name}</div>
          <div class="file-meta">
            <span>${sizeStr}</span>
            <span>·</span>
            <span>${dateStr}</span>
            ${badgeHtml}
          </div>
        </div>
      </div>
      <div class="file-actions">
        <button class="btn-icon convert" title="重新转换" onclick="event.stopPropagation(); triggerManualConvert('${file.name}')">
          <i data-lucide="play" style="width: 14px; height: 14px;"></i>
        </button>
        <button class="btn-icon delete" title="删除" onclick="event.stopPropagation(); deleteFile('${file.name}')">
          <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
        </button>
      </div>
    `;
    
    item.addEventListener('click', () => selectFile(file));
    elements.fileListContainer.appendChild(item);
  });
  
  lucide.createIcons();
}

// 格式化文件大小
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// ==========================================================================
// 交互行为
// ==========================================================================

// 选择查看某个文件
function selectFile(file) {
  activeFile = file;
  
  // 更新列表项 active 状态
  const items = elements.fileListContainer.querySelectorAll('.file-item');
  items.forEach((item, index) => {
    if (filesList[index] && filesList[index].name === file.name) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
  
  // 停止之前的播放
  stopSlideshow();

  if (!file.converted) {
    showState('unconverted');
    elements.unconvertedTitle.textContent = `"${file.name}" 尚未渲染图片`;
    elements.btnTriggerConvert.onclick = () => triggerManualConvert(file.name);
  } else {
    showState('viewer');
    elements.viewerTitle.textContent = file.name;
    currentSlideIndex = 0;
    renderSlidesPlayer();
  }
}

// 显示不同状态的面板
function showState(state) {
  elements.emptyState.classList.add('hidden');
  elements.unconvertedState.classList.add('hidden');
  elements.viewerState.classList.add('hidden');
  
  if (state === 'empty') {
    elements.emptyState.classList.remove('hidden');
  } else if (state === 'unconverted') {
    elements.unconvertedState.classList.remove('hidden');
  } else if (state === 'viewer') {
    elements.viewerState.classList.remove('hidden');
  }
}

// 触发手动转换
async function triggerManualConvert(filename) {
  showProgress('正在渲染幻灯片，请稍候...', 50);
  try {
    const res = await fetch(`${API_BASE}/api/convert/${encodeURIComponent(filename)}`, {
      method: 'POST'
    });
    const data = await res.json();
    
    if (res.ok && data.success) {
      hideProgress();
      await fetchFiles(filename); // 重新拉取并选中该文件
    } else {
      hideProgress();
      alert(`转换失败: ${data.error || '未知错误'}`);
    }
  } catch (err) {
    hideProgress();
    alert(`网络请求失败: ${err.message}`);
  }
}

// 删除源文件及输出结果
async function deleteFile(filename) {
  if (!confirm(`确认要永久删除文件 "${filename}" 及其所有转换生成的图片吗？`)) {
    return;
  }
  
  try {
    const res = await fetch(`${API_BASE}/api/delete/${encodeURIComponent(filename)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    
    if (res.ok && data.success) {
      if (activeFile && activeFile.name === filename) {
        activeFile = null;
        showState('empty');
      }
      fetchFiles();
    } else {
      alert(`删除失败: ${data.error || '未知错误'}`);
    }
  } catch (err) {
    alert(`删除请求失败: ${err.message}`);
  }
}

// ==========================================================================
// 幻灯片播放与大图渲染
// ==========================================================================

function renderSlidesPlayer() {
  if (!activeFile || activeFile.images.length === 0) return;
  
  // PDF 下载按钮
  elements.btnDownloadPdf.onclick = () => {
    window.open(`${API_BASE}/output/${activeFile.baseName}/${activeFile.baseName}.pdf`, '_blank');
  };
  
  // 渲染大图
  loadSlideImage(currentSlideIndex);
  
  // 渲染缩略图
  renderThumbnails();
}

// 加载指定页码的幻灯片大图 (index 从 0 开始)
function loadSlideImage(index) {
  if (!activeFile || index < 0 || index >= activeFile.images.length) return;
  
  currentSlideIndex = index;
  elements.slideImgLoader.classList.remove('hidden');
  
  const imgName = activeFile.images[index];
  const url = `${API_BASE}/output/${encodeURIComponent(activeFile.baseName)}/${encodeURIComponent(imgName)}`;
  
  // 图片淡出
  elements.mainSlideImg.style.opacity = '0.3';
  
  const tempImg = new Image();
  tempImg.onload = () => {
    elements.mainSlideImg.src = url;
    elements.mainSlideImg.style.opacity = '1';
    elements.slideImgLoader.classList.add('hidden');
    elements.slideCounter.textContent = `${index + 1} / ${activeFile.images.length}`;
    
    // 更新缩略图的高亮
    updateActiveThumbnail(index);
  };
  tempImg.src = url;
}

// 渲染缩略图
function renderThumbnails() {
  elements.thumbnailContainer.innerHTML = '';
  
  activeFile.images.forEach((imgName, index) => {
    const thumb = document.createElement('div');
    thumb.className = `thumb-item ${index === currentSlideIndex ? 'active' : ''}`;
    
    const url = `${API_BASE}/output/${encodeURIComponent(activeFile.baseName)}/${encodeURIComponent(imgName)}`;
    thumb.innerHTML = `<img src="${url}" alt="Page ${index + 1}">`;
    
    thumb.onclick = () => {
      stopSlideshow();
      loadSlideImage(index);
    };
    
    elements.thumbnailContainer.appendChild(thumb);
  });
}

// 滚动定位高亮缩略图到可视区
function updateActiveThumbnail(activeIndex) {
  const thumbs = elements.thumbnailContainer.querySelectorAll('.thumb-item');
  thumbs.forEach((t, i) => {
    if (i === activeIndex) {
      t.classList.add('active');
      // 平滑滚动定位
      t.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } else {
      t.classList.remove('active');
    }
  });
}

// 切换下一页
function nextSlide() {
  if (!activeFile) return;
  let nextIndex = currentSlideIndex + 1;
  if (nextIndex >= activeFile.images.length) {
    nextIndex = 0; // 播放到最后返回第一页
  }
  loadSlideImage(nextIndex);
}

// 切换上一页
function prevSlide() {
  if (!activeFile) return;
  let prevIndex = currentSlideIndex - 1;
  if (prevIndex < 0) {
    prevIndex = activeFile.images.length - 1;
  }
  loadSlideImage(prevIndex);
}

// 启动/停止自动播放
function toggleSlideshow() {
  if (playIntervalId) {
    stopSlideshow();
  } else {
    elements.btnPlaySlides.innerHTML = '<i data-lucide="pause"></i>';
    elements.btnPlaySlides.classList.add('playing');
    lucide.createIcons();
    playIntervalId = setInterval(nextSlide, 3000); // 3秒切换一页
  }
}

function stopSlideshow() {
  if (playIntervalId) {
    clearInterval(playIntervalId);
    playIntervalId = null;
    elements.btnPlaySlides.innerHTML = '<i data-lucide="play"></i>';
    elements.btnPlaySlides.classList.remove('playing');
    lucide.createIcons();
  }
}

// ==========================================================================
// 上传事件处理
// ==========================================================================

function handleUpload(file) {
  if (!file) return;
  
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  if (ext !== '.ppt' && ext !== '.pptx') {
    alert('仅支持上传 PPT / PPTX 格式幻灯片文档');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/api/upload`, true);

  // 监听进度
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percentComplete = Math.round((e.loaded / e.total) * 100);
      // 上传最大只计到 90%，剩余的 10% 留给服务器渲染 PDF/PNG
      const scalePercent = Math.min(Math.round(percentComplete * 0.9), 90);
      showProgress('正在上传文件...', scalePercent);
    }
  };

  xhr.onload = () => {
    if (xhr.status === 200) {
      showProgress('正在渲染幻灯片...', 95);
      const response = JSON.parse(xhr.responseText);
      setTimeout(() => {
        hideProgress();
        fetchFiles(response.file); // 刷新文件列表并选中该文件
      }, 500);
    } else {
      hideProgress();
      const response = JSON.parse(xhr.responseText || '{}');
      alert(`上传失败: ${response.error || '服务器转换出错'}`);
    }
  };

  xhr.onerror = () => {
    hideProgress();
    alert('网络传输失败，请稍后重试。');
  };

  xhr.send(formData);
}

function showProgress(statusText, percent) {
  elements.progressContainer.classList.remove('hidden');
  elements.progressStatus.textContent = statusText;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressFill.style.width = `${percent}%`;
}

function hideProgress() {
  elements.progressContainer.classList.add('hidden');
  elements.progressFill.style.width = '0%';
}

// ==========================================================================
// 事件绑定
// ==========================================================================

function setupEventListeners() {
  // 刷新按钮
  elements.btnRefresh.addEventListener('click', () => {
    checkSystemStatus();
    fetchFiles();
  });

  // 上传区域拖拽事件
  elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
  });

  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('dragover');
  });

  elements.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files[0]);
    }
  });

  // 点击上传区域触发 input file
  elements.dropZone.addEventListener('click', () => {
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleUpload(e.target.files[0]);
      // 清理 value 方便下次选择同名文件触发 change
      elements.fileInput.value = '';
    }
  });

  // 播放器方向控制
  elements.btnPrevSlide.addEventListener('click', () => {
    stopSlideshow();
    prevSlide();
  });
  elements.btnNextSlide.addEventListener('click', () => {
    stopSlideshow();
    nextSlide();
  });
  elements.btnPlaySlides.addEventListener('click', toggleSlideshow);

  // 键盘方向键和空格键交互
  document.addEventListener('keydown', (e) => {
    // 只有当播放器显示且处于可视区时生效
    if (elements.viewerState.classList.contains('hidden')) return;

    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      stopSlideshow();
      nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      stopSlideshow();
      prevSlide();
    } else if (e.key === ' ') { // 空格键播放/暂停
      e.preventDefault();
      toggleSlideshow();
    }
  });

  // HTML5 全屏功能
  elements.btnFullscreen.addEventListener('click', () => {
    const container = document.querySelector('.slide-container');
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(err => {
        alert(`全屏模式启动失败: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });
}
