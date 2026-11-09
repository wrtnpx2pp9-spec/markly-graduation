'use strict';
function avatarHTML(user, extra='') {
  const image = typeof user.avatar==='string' && /^(?:data:image\/(?:jpeg|png|webp|gif)|https?:\/\/)/.test(user.avatar);
  return `<span class="avatar ${extra}">${image ? `<img src="${esc(user.avatar)}" alt="${esc(user.displayName || '用户')}的头像" draggable="false">` : esc(Array.from(user.displayName || 'M')[0])}</span>`;
}

function editAvatar() {
  let selected = me.avatar || '';
  let draftBitmap = null;
  let hasDraft = false;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  const activePointers = new Map();
  let pinchBaseDistance = 0;
  let pinchBaseScale = 1;
  let dragging = false;
  let dragPoint = null;

  const CANVAS_SIZE = 160;
  const MIN_SCALE = 1;
  const MAX_SCALE = 3;
  const isMobile = (/Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(window.navigator.userAgent || ''))
    || window.matchMedia('(pointer: coarse), (hover: none)').matches;

  function getBaseScale(bitmap) {
    return Math.max(CANVAS_SIZE / bitmap.width, CANVAS_SIZE / bitmap.height);
  }

  function clampPan(bitmap) {
    const base = getBaseScale(bitmap);
    const scaledW = bitmap.width * base * scale;
    const scaledH = bitmap.height * base * scale;

    if (scaledW <= CANVAS_SIZE) {
      panX = 0;
    } else {
      const minX = CANVAS_SIZE - scaledW;
      if (panX < minX) panX = minX;
      if (panX > 0) panX = 0;
    }

    if (scaledH <= CANVAS_SIZE) {
      panY = 0;
    } else {
      const minY = CANVAS_SIZE - scaledH;
      if (panY < minY) panY = minY;
      if (panY > 0) panY = 0;
    }
  }

  function drawCanvas(bitmap) {
    const canvas = $('#avatar-crop-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const base = getBaseScale(bitmap);
    const scaledW = bitmap.width * base * scale;
    const scaledH = bitmap.height * base * scale;
    const x = (CANVAS_SIZE - scaledW) / 2 + panX;
    const y = (CANVAS_SIZE - scaledH) / 2 + panY;

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = '#f3f5f8';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(bitmap, x, y, scaledW, scaledH);
  }

  function renderPreview() {
    const error = $('#avatar-error');
    const filePreview = $('#avatar-preview');
    const cropCanvas = $('#avatar-crop-canvas');
    const zoom = $('#avatar-zoom');

    if (!draftBitmap) {
      if (cropCanvas) cropCanvas.hidden = true;
      if (filePreview) {
        filePreview.innerHTML = avatarHTML({ ...me, avatar: selected }, 'large');
        filePreview.hidden = false;
      }
      if (zoom) zoom.value = String(MIN_SCALE);
      if (error) error.textContent = '已选当前头像，可点击选择图片后再调整。';
      setSaveEnabled();
      return;
    }

    if (filePreview) filePreview.hidden = true;
    if (cropCanvas) {
      cropCanvas.hidden = false;
      drawCanvas(draftBitmap);
    }

    if (zoom) zoom.value = String(scale);
    if (error) error.textContent = isMobile ? '可拖拽移动，双指缩放；确认后再保存。' : '可拖拽移动，滑条/滚轮调节缩放；确认后再保存。';
    setSaveEnabled();
  }

  function setSaveEnabled() {
    const save = $('#modal-ok');
    if (!save) return;
    const hasChange = hasDraft || selected !== me.avatar;
    save.disabled = !hasChange;
    save.textContent = hasChange ? '保存头像' : '暂未调整';
  }

  function toDataUrl() {
    if (!draftBitmap) return selected;

    const out = document.createElement('canvas');
    out.width = out.height = CANVAS_SIZE;
    const ctx = out.getContext('2d');
    const base = getBaseScale(draftBitmap);
    const scaledW = draftBitmap.width * base * scale;
    const scaledH = draftBitmap.height * base * scale;
    const x = (CANVAS_SIZE - scaledW) / 2 + panX;
    const y = (CANVAS_SIZE - scaledH) / 2 + panY;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(draftBitmap, x, y, scaledW, scaledH);
    return out.toDataURL('image/jpeg', 0.82);
  }

  function releaseDraft() {
    if (draftBitmap) {
      draftBitmap.close && draftBitmap.close();
      draftBitmap = null;
    }
    activePointers.clear();
    pinchBaseDistance = 0;
    pinchBaseScale = 1;
    scale = 1;
    panX = 0;
    panY = 0;
    dragging = false;
    dragPoint = null;
  }

  async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(file);
    }

    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = url;
      });
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  openModal(
    '换一个新头像',
    `<div class="avatar-editor">
      <div class="avatar-crop-wrap"><div id="avatar-preview">${avatarHTML(me, 'large')}</div><canvas id="avatar-crop-canvas" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" class="avatar-crop-canvas" hidden></canvas></div>
      <p>先选图再调好后，再点击“保存头像”。${isMobile ? '移动端支持一指拖动、两指缩放。' : '支持拖动，缩放可用滑条/滚轮调整。'}</p>
      <label class="avatar-upload">${isMobile ? '从相册选取' : '选择照片'}<input id="avatar-file" type="file" accept="image/*"></label>
      ${isMobile ? '' : '<div class="avatar-crop-controls"><label class="avatar-crop-zoom">缩放 <input id="avatar-zoom" type="range" min="1" max="3" step="0.05" value="1"></label></div>'}
      <button class="btn soft" id="avatar-remove" type="button">恢复默认头像</button>
      <p id="avatar-error" role="status"></p>
    </div>`,
    async () => {
      const nextAvatar = hasDraft ? toDataUrl() : selected;
      await api('PUT', '/api/profile/avatar', { avatar: nextAvatar });
      me.avatar = nextAvatar;
      releaseDraft();
      closeModal();
      renderApp();
      toast('头像已更新');
    }
  );

  $('#modal-ok').textContent = '保存头像';

  const fileInput = $('#avatar-file');
  const remove = $('#avatar-remove');
  const canvas = $('#avatar-crop-canvas');
  const pointerDistance = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
  const zoom = isMobile ? null : $('#avatar-zoom');

  fileInput.onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    const error = $('#avatar-error');
    const save = $('#modal-ok');

    if (!file) return;

    if (!file.type || !/^image\//i.test(file.type)) {
      if (error) error.textContent = '请上传图片文件';
      fileInput.value = '';
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      if (error) error.textContent = '请选择 10 MB 以内的图片';
      fileInput.value = '';
      return;
    }

    if (save) save.disabled = true;
    try {
      releaseDraft();
      draftBitmap = await loadBitmap(file);
      hasDraft = true;
      clampPan(draftBitmap);
      renderPreview();
    } catch (err) {
      if (error) error.textContent = err.message || '图片无法读取，请换一张';
      fileInput.value = '';
      releaseDraft();
      hasDraft = false;
      renderPreview();
    } finally {
      if (save) save.disabled = false;
      setSaveEnabled();
    }
  };

  remove.onclick = () => {
    selected = '';
    hasDraft = false;
    releaseDraft();
    renderPreview();
    const error = $('#avatar-error');
    if (error) error.textContent = '已恢复默认头像，点击保存后生效';
    setSaveEnabled();
  };

  if (canvas) {
    canvas.addEventListener('pointerdown', (evt) => {
      if (!draftBitmap || !canvas.isConnected) return;
      activePointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      canvas.setPointerCapture && canvas.setPointerCapture(evt.pointerId);
      if (activePointers.size === 2) {
        const points = [...activePointers.values()];
        pinchBaseDistance = pointerDistance(points[0], points[1]);
        pinchBaseScale = scale;
        dragging = false;
        dragPoint = null;
      } else if (activePointers.size === 1) {
        dragging = true;
        dragPoint = { x: evt.clientX, y: evt.clientY };
      }
      evt.preventDefault();
    });

    canvas.addEventListener('pointermove', (evt) => {
      if (!draftBitmap || !activePointers.has(evt.pointerId)) return;
      activePointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

      if (activePointers.size === 2) {
        const points = [...activePointers.values()];
        const distance = pointerDistance(points[0], points[1]);
        if (distance > 0 && pinchBaseDistance > 0) {
          scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchBaseScale * (distance / pinchBaseDistance)));
          clampPan(draftBitmap);
          renderPreview();
        }
        return;
      }

      if (!dragging || !dragPoint) return;
      panX += evt.clientX - dragPoint.x;
      panY += evt.clientY - dragPoint.y;
      dragPoint = { x: evt.clientX, y: evt.clientY };
      clampPan(draftBitmap);
      renderPreview();
    });

    canvas.addEventListener('pointerup', (evt) => {
      activePointers.delete(evt.pointerId);
      canvas.releasePointerCapture && canvas.releasePointerCapture(evt.pointerId);
      if (activePointers.size === 1) {
        const remain = [...activePointers.values()][0];
        dragging = true;
        dragPoint = { x: remain.x, y: remain.y };
      } else {
        dragging = false;
        dragPoint = null;
      }
    });

    canvas.addEventListener('pointercancel', (evt) => {
      activePointers.delete(evt.pointerId);
      dragging = false;
      dragPoint = null;
      if (canvas) {
        canvas.releasePointerCapture && canvas.releasePointerCapture(evt.pointerId);
      }
    });

    canvas.addEventListener('pointerleave', (evt) => {
      activePointers.delete(evt.pointerId);
      dragging = false;
      dragPoint = null;
      if (canvas) {
        canvas.releasePointerCapture && canvas.releasePointerCapture(evt.pointerId);
      }
    });

    canvas.addEventListener('wheel', (evt) => {
      if (isMobile || !draftBitmap) return;
      const delta = evt.deltaY;
      const step = -delta / 400;
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + step));
      clampPan(draftBitmap);
      renderPreview();
      evt.preventDefault();
    }, { passive: false });
  }

  if (zoom) {
    zoom.addEventListener('input', () => {
      if (!draftBitmap) return;
      const value = Number(zoom.value);
      if (!Number.isFinite(value)) return;
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
      clampPan(draftBitmap);
      renderPreview();
    });
  }

  renderPreview();
  setSaveEnabled();
}
