// ==UserScript==
// @name         光鸭云盘 - 获取直链
// @namespace    http://tampermonkey.net/
// @author       快乐无极
// @version      1.5
// @description  获取所选文件的直链地址
// @match        https://www.guangyapan.com/*
// @grant        GM.xmlHttpRequest
// @connect      *
// @downloadURL https://update.greasyfork.org/scripts/575452/%E5%85%89%E9%B8%AD%E4%BA%91%E7%9B%98%20-%20%E8%8E%B7%E5%8F%96%E7%9B%B4%E9%93%BE.user.js
// @updateURL https://update.greasyfork.org/scripts/575452/%E5%85%89%E9%B8%AD%E4%BA%91%E7%9B%98%20-%20%E8%8E%B7%E5%8F%96%E7%9B%B4%E9%93%BE.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const API_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/get_res_download_url';
    const CONCURRENCY = 3;
    const BATCH_DELAY = 200;
    const FETCH_TIMEOUT = 10000;
    const MAX_RETRIES = 3;
    const RETRY_BASE_DELAY = 500;

    let modalCreated = false;
    let abortController = null;

    // 记录选中的文件
    const selectedFilesMap = new Map(); // fileId -> { name, addedAt }

    // ========== React 内部状态获取选中项 ==========

    function looksLikeFileId(key) {
        if (!key || typeof key !== 'string') return false;
        const text = String(key).trim();
        // 光鸭的 fileId 是 19 位数字字符串
        return /^\d{16,22}$/.test(text);
    }

    // 从 React DevTools 可以看到：FileList -> props -> dataSource 和 selectedItems
    function findFileListComponent() {
        const roots = [];

        // 查找所有 React 容器
        document.querySelectorAll('*').forEach(el => {
            Object.keys(el).forEach(k => {
                if (k.startsWith('__react') || k.startsWith('_react')) {
                    roots.push({ el, fiber: el[k] });
                }
            });
        });

        // 遍历 fiber 树查找 FileList 组件
        const findFileList = (fiber, depth = 0) => {
            if (depth > 60 || !fiber) return null;

            // 检查组件名称是否包含 FileList
            const typeName = fiber.elementType?.name || fiber.elementType?.toString() || '';
            const isFileList = typeName === 'FileList' || typeName.includes('FileList');

            // 检查 memoizedProps（组件的 props）
            if (fiber.memoizedProps) {
                const props = fiber.memoizedProps;
                if (props.selectedItems !== undefined || props.dataSource) {
                    if (isFileList) {
                        console.log('GYP: Found FileList with dataSource/selectedItems');
                    }
                    return { props, type: 'memoizedProps', componentName: typeName };
                }
            }

            // 检查 pendingProps
            if (fiber.pendingProps) {
                const props = fiber.pendingProps;
                if (props.selectedItems !== undefined || props.dataSource) {
                    if (isFileList) {
                        console.log('GYP: Found FileList with dataSource/selectedItems');
                    }
                    return { props, type: 'pendingProps', componentName: typeName };
                }
            }

            // 检查 stateNode 的 props
            if (fiber.stateNode && typeof fiber.stateNode === 'object') {
                const node = fiber.stateNode;
                if (node.props && (node.props.selectedItems !== undefined || node.props.dataSource)) {
                    if (isFileList) {
                        console.log('GYP: Found FileList in stateNode.props');
                    }
                    return { props: node.props, type: 'stateNode.props', componentName: typeName };
                }
            }

            // 递归查找 child
            if (fiber.child) {
                const found = findFileList(fiber.child, depth + 1);
                if (found) return found;
            }
            // 递归查找 sibling
            if (fiber.sibling) {
                const found = findFileList(fiber.sibling, depth);
                if (found) return found;
            }
            return null;
        };

        console.log('GYP: Searching for FileList component, total roots:', roots.length);
        for (const { fiber } of roots) {
            const found = findFileList(fiber);
            if (found) return found;
        }
        return null;
    }

    function getSelectedItemsFromReact() {
        const result = findFileListComponent();
        if (!result) {
            console.log('GYP: Could not find FileList component');
            return { ids: new Set(), names: new Set(), filesMap: new Map() };
        }

        const { props } = result;
        console.log('GYP: FileList props keys:', Object.keys(props));

        const marker = { ids: new Set(), names: new Set(), filesMap: new Map() };

        // 从 dataSource 获取完整的文件列表（用于根据 ID 查文件名和判断类型）
        // resType: 1 = 文件, 2 = 文件夹
        const dataSource = props.dataSource || props.list || props.fileList || [];
        if (Array.isArray(dataSource)) {
            dataSource.forEach(item => {
                if (item && item.fileId) {
                    const fileId = String(item.fileId);
                    const resType = item.resType;
                    const isDir = resType === 2; // resType 2 是文件夹
                    marker.filesMap.set(fileId, {
                        fileId: fileId,
                        fileName: item.fileName || item.name || item.title || '',
                        isDir: isDir,
                        size: item.fileSize || 0
                    });
                }
            });
            console.log('GYP: dataSource has', marker.filesMap.size, 'items');
            // 调试：打印第一个文件的所有字段
            if (marker.filesMap.size > 0) {
                const firstFile = marker.filesMap.values().next().value;
                console.log('GYP: First file data:', JSON.stringify(firstFile));
                console.log('GYP: First file fileSize:', firstFile.size);
            }
        }

        // 获取 selectedItems（选中的文件 ID）
        let selectedItems = props.selectedItems;

        // 也检查其他可能的字段名
        if (!selectedItems && props.selectedRowKeys) {
            selectedItems = props.selectedRowKeys;
        }
        if (!selectedItems && props.selection) {
            selectedItems = props.selection;
        }
        if (!selectedItems && props.checkedKeys) {
            selectedItems = props.checkedKeys;
        }

        if (!selectedItems) {
            console.log('GYP: No selectedItems found');
            return marker;
        }

        // selectedItems 可能是 Set、Map、数组或普通对象
        if (selectedItems instanceof Set) {
            selectedItems.forEach(id => marker.ids.add(String(id)));
        } else if (selectedItems instanceof Map) {
            selectedItems.forEach((val, id) => {
                marker.ids.add(String(id));
                if (val && typeof val === 'object') {
                    if (val.fileName) marker.names.add(val.fileName);
                    if (val.name) marker.names.add(val.name);
                }
            });
        } else if (Array.isArray(selectedItems)) {
            selectedItems.forEach(item => {
                if (item && typeof item === 'object') {
                    if (item.fileId) marker.ids.add(String(item.fileId));
                    if (item.fileName) marker.names.add(item.fileName);
                    if (item.name) marker.names.add(item.name);
                } else if (typeof item === 'string' || typeof item === 'number') {
                    marker.ids.add(String(item));
                }
            });
        } else if (typeof selectedItems === 'object') {
            // 可能是普通对象 { fileId: true } 或 Set-like 对象
            Object.entries(selectedItems).forEach(([id, val]) => {
                if (looksLikeFileId(id)) {
                    marker.ids.add(id);
                    if (val && typeof val === 'object') {
                        if (val.fileName) marker.names.add(val.fileName);
                        if (val.name) marker.names.add(val.name);
                    }
                }
            });
        }

        console.log('GYP: Selected items from React:', marker.ids.size, 'IDs');
        return marker;
    }

    function collectSelectedItemsFromDOM() {
        const marker = { ids: new Set(), names: new Set() };

        // 从当前 DOM 获取选中的 checkbox
        document.querySelectorAll('.ant-table-row-selected').forEach(row => {
            const fileId = row.getAttribute('data-row-key');
            if (fileId && looksLikeFileId(fileId)) {
                marker.ids.add(fileId);
                // 尝试多种选择器获取文件名，稳定性优先
                const nameDiv = row.querySelector('.ant-table-cell:nth-child(2) [title]') ||
                    row.querySelector('.ant-table-cell:nth-child(2)') ||
                    row.querySelector('[class*="name"]') ||
                    row.querySelector('.ant-typography');
                if (nameDiv) {
                    const name = nameDiv.getAttribute('title') || nameDiv.textContent;
                    if (name) marker.names.add(name.trim());
                }
            }
        });

        return marker;
    }

    function getSelectedFileIdsFromFramework() {
        // 首先尝试从 React 组件获取
        const reactMarker = getSelectedItemsFromReact();
        const domMarker = collectSelectedItemsFromDOM();

        // 合并
        domMarker.ids.forEach(id => reactMarker.ids.add(id));
        domMarker.names.forEach(name => reactMarker.names.add(name));

        console.log('GYP: Total selected IDs:', reactMarker.ids.size, 'Names:', reactMarker.names.size);
        return reactMarker;
    }

    // ========== 选中文件监听 ==========

    function setupCheckboxListener() {
        // 监听表格 tbody 上的点击事件
        document.querySelectorAll('.ant-table-tbody').forEach(tbody => {
            tbody.addEventListener('click', (e) => {
                const checkbox = e.target.closest('.ant-checkbox-input');
                if (!checkbox) return;

                const row = checkbox.closest('tr');
                if (!row) return;

                const fileId = row.getAttribute('data-row-key');
                if (!fileId) return;

                let fileName = null;
                const nameDiv = row.querySelector('.ant-table-cell:nth-child(2) [title]') ||
                    row.querySelector('.ant-table-cell:nth-child(2)');
                if (nameDiv) {
                    fileName = nameDiv.getAttribute('title') || nameDiv.textContent;
                }
                if (!fileName) {
                    fileName = '文件_' + fileId;
                }

                // 从 React 数据获取文件大小
                const reactMarker = getSelectedItemsFromReact();
                const fileData = reactMarker.filesMap.get(fileId) || {};
                const fileSize = fileData.size || 0;

                if (checkbox.checked) {
                    selectedFilesMap.set(fileId, { name: fileName.trim(), size: fileSize, addedAt: Date.now() });
                } else {
                    selectedFilesMap.delete(fileId);
                }
            });
        });

        // 监听全选按钮
        document.querySelectorAll('.ant-table-header .ant-checkbox-input').forEach(checkbox => {
            checkbox.addEventListener('click', (e) => {
                setTimeout(() => {
                    if (e.target.checked) {
                        // 全选时，先清空再用 React 状态获取
                        selectedFilesMap.clear();
                        const marker = getSelectedFileIdsFromFramework();
                        // 从 DOM 补充获取当前可见的
                        document.querySelectorAll('.ant-table-row-selected').forEach(row => {
                            const fileId = row.getAttribute('data-row-key');
                            if (fileId) {
                                const nameDiv = row.querySelector('.ant-table-cell:nth-child(2) [title]') ||
                                row.querySelector('.ant-table-cell:nth-child(2)');
                                const name = nameDiv ? (nameDiv.getAttribute('title') || nameDiv.textContent) : ('文件_' + fileId);
                                const fileData = marker.filesMap.get(fileId) || {};
                                const fileSize = fileData.size || 0;
                                selectedFilesMap.set(fileId, { name: name.trim(), size: fileSize, addedAt: Date.now() });
                            }
                        });
                        console.log('GYP: Select all, map size:', selectedFilesMap.size);
                    } else {
                        selectedFilesMap.clear();
                    }
                }, 100);
            });
        });
    }

    function getSelectedFilesFromMap() {
        const files = Array.from(selectedFilesMap.entries()).map(([id, data]) => ({
            id: id,
            name: data.name,
            size: data.size || 0
        }));
        console.log('GYP: Selected files from map:', files.length);
        return files;
    }

    // 清理过期的选中记录（当文件从列表中消失时）
    function cleanExpiredSelections() {
        const currentRowKeys = new Set();
        document.querySelectorAll('tr[data-row-key]').forEach(tr => {
            currentRowKeys.add(tr.getAttribute('data-row-key'));
        });
        let cleaned = 0;
        selectedFilesMap.forEach((_, key) => {
            if (!currentRowKeys.has(key)) {
                selectedFilesMap.delete(key);
                cleaned++;
            }
        });
        if (cleaned > 0) {
            console.log('GYP: Cleaned expired selections:', cleaned);
        }
    }

    // 动态生成设备ID
    function generateDid() {
        const stored = localStorage.getItem('gyp_generated_did');
        if (stored) return stored;
        const chars = '0123456789abcdef';
        let did = '';
        for (let i = 0; i < 32; i++) {
            did += chars[Math.floor(Math.random() * chars.length)];
        }
        localStorage.setItem('gyp_generated_did', did);
        return did;
    }

    function getAuthToken() {
        try {
            const candidates = [];
            const currentUserId = localStorage.getItem('current_user_id') ||
                localStorage.getItem('userId') ||
                localStorage.getItem('uid');

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('credentials_')) {
                    const tokenData = localStorage.getItem(key);
                    if (!tokenData) continue;
                    try {
                        const json = JSON.parse(tokenData);
                        if (json.access_token) {
                            // 尝试匹配用户ID
                            const matchScore = (json.user_id === currentUserId) ? 2 :
                                (key.includes(currentUserId)) ? 1 : 0;
                            candidates.push({
                                key,
                                token: json.access_token,
                                score: matchScore,
                                expiresAt: json.expires_at || 0
                            });
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

            if (candidates.length === 0) return null;

            // 优先选择匹配当前用户的token，其次选择未过期的，最后选最新的
            candidates.sort((a, b) => {
                if (a.score !== b.score) return b.score - a.score;
                const now = Date.now();
                const aValid = a.expiresAt > now;
                const bValid = b.expiresAt > now;
                if (aValid !== bValid) return aValid ? -1 : 1;
                return b.score - a.score;
            });

            const selected = candidates[0];
            console.log('GYP: Selected token from:', selected.key, 'score:', selected.score);
            return selected.token;
        } catch (e) {
            console.error('GYP: Error getting token:', e);
            return null;
        }
    }

    function getAuthHeader() {
        const token = getAuthToken();
        if (!token) return null;
        if (token.startsWith('Bearer ')) return token;
        return 'Bearer ' + token;
    }

    function findUploadButton() {
        // 查找包含"上传"文字的按钮
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.textContent.includes('上传')) {
                return btn;
            }
        }
        return null;
    }

    // ========== Aria2 发送功能 ==========

    const ARIA2_STORAGE_KEY = 'gyp_aria2_config';

    function loadAria2Config() {
        const saved = localStorage.getItem(ARIA2_STORAGE_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return { rpc: '', secret: '' };
            }
        }
        return { rpc: '', secret: '' };
    }

    function saveAria2Config() {
        const rpc = document.querySelector('#gyp-aria2-config-rpc')?.value?.trim();
        const secret = document.querySelector('#gyp-aria2-config-secret')?.value || '';
        if (!rpc) {
            showToast('请输入 RPC 地址', 2000, 'warning');
            return;
        }
        localStorage.setItem(ARIA2_STORAGE_KEY, JSON.stringify({ rpc, secret }));
        showToast('配置已保存');
        updateAria2ButtonState();
    }

    function getAria2Config() {
        const saved = localStorage.getItem(ARIA2_STORAGE_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                return { rpc: '', secret: '' };
            }
        }
        return { rpc: '', secret: '' };
    }

    function openAria2Modal() {
        // 清理旧弹窗
        const existingModal = document.getElementById('gyp-aria2-modal-overlay');
        if (existingModal) existingModal.remove();

        const config = loadAria2Config();

        // 创建 Ant Design Modal，表单用 Shadow DOM 隔离 React 事件
        const modal = document.createElement('div');
        modal.id = 'gyp-aria2-modal-overlay';
        modal.style.cssText = 'position: fixed; inset: 0; z-index: 1000000;';

        // 遮罩层
        const mask = document.createElement('div');
        mask.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.45);';
        mask.onclick = () => modal.remove();
        modal.appendChild(mask);

        // 弹窗容器
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position: fixed; inset: 0; overflow: auto; outline: 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 100px;';
        modal.appendChild(wrap);

        // Shadow DOM 宿主 - 隔离 React 事件
        const shadowHost = document.createElement('div');
        wrap.appendChild(shadowHost);

        const shadow = shadowHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
                .modal-box { width: 460px; background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); overflow: hidden; }
                .modal-header { padding: 20px 24px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; display: flex; justify-content: space-between; align-items: center; }
                .modal-title { font-size: 17px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
                .modal-title svg { width: 22px; height: 22px; }
                .modal-close { background: rgba(255,255,255,0.2); border: none; font-size: 20px; color: rgba(255,255,255,0.9); cursor: pointer; padding: 4px 10px; border-radius: 6px; line-height: 1; transition: all 0.2s; }
                .modal-close:hover { background: rgba(255,255,255,0.3); color: #fff; }
                .modal-body { padding: 24px; }
                .form-group { margin-bottom: 20px; }
                .form-group:last-child { margin-bottom: 0; }
                .form-label { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 14px; font-weight: 500; color: #333; }
                .form-label svg { width: 16px; height: 16px; color: #667eea; }
                .form-input { width: 100%; padding: 12px 14px; font-size: 14px; border: 2px solid #e8e8e8; border-radius: 8px; outline: none; box-sizing: border-box; color: #333; transition: all 0.25s; background: #fafbfc; }
                .form-input:focus { border-color: #667eea; box-shadow: 0 0 0 3px rgba(102,126,234,0.15); background: #fff; }
                .form-input::placeholder { color: #adb5bd; }
                .form-input.secret-mask { font-family: monospace; letter-spacing: 2px; }
                .form-hint { margin-top: 8px; font-size: 12px; color: #868e96; }
                .modal-footer { padding: 16px 24px 20px; display: flex; justify-content: flex-end; gap: 12px; }
                .btn { padding: 10px 22px; font-size: 14px; font-weight: 500; border-radius: 6px; cursor: pointer; border: none; transition: all 0.2s; }
                .btn-cancel { background: #f1f3f5; color: #495057; }
                .btn-cancel:hover { background: #e9ecef; color: #212529; }
                .btn-save { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; box-shadow: 0 4px 12px rgba(102,126,234,0.35); }
                .btn-save:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(102,126,234,0.4); }
                .btn-save:active { transform: translateY(0); }
                .aria2-icon { display: inline-block; width: 24px; height: 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 6px; position: relative; }
                .aria2-icon::before { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 0; height: 0; border-left: 10px solid #fff; border-top: 6px solid transparent; border-bottom: 6px solid transparent; }
            </style>
            <div class="modal-box">
                <div class="modal-header">
                    <div class="modal-title">
                        <div class="aria2-icon"></div>
                        Aria2 配置
                    </div>
                    <button class="modal-close" id="gyp-shadow-close">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                            RPC 地址
                        </label>
                        <input type="text" class="form-input" id="gyp-shadow-rpc" placeholder="http://localhost:6800/jsonrpc" value="${config.rpc || 'http://localhost:6800/jsonrpc'}">
                        <div class="form-hint">Aria2 RPC 服务地址，通常为本地地址</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                            密钥（可选）
                        </label>
                        <div style="position: relative;">
                            <input type="text" class="form-input" id="gyp-shadow-secret" placeholder="留空则无密钥" value="">
                            <input type="hidden" id="gyp-shadow-secret-real" value="${config.secret || ''}">
                        </div>
                        <div class="form-hint">RPC 连接的密钥，无密码时留空</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-cancel" id="gyp-shadow-cancel">取消</button>
                    <button class="btn btn-save" id="gyp-shadow-save">保存配置</button>
                </div>
            </div>
        `;

        // Shadow DOM 事件 - 原生事件，不受 React 影响
        shadow.getElementById('gyp-shadow-close').onclick = () => modal.remove();
        shadow.getElementById('gyp-shadow-cancel').onclick = () => modal.remove();

        // 密钥显示/隐藏处理
        const secretInput = shadow.getElementById('gyp-shadow-secret');
        const secretReal = shadow.getElementById('gyp-shadow-secret-real');
        const realValue = secretReal.value;
        if (realValue) {
            secretInput.value = '•'.repeat(realValue.length);
            secretInput.classList.add('secret-mask');
        }
        secretInput.addEventListener('input', () => {
            const val = secretInput.value;
            // 如果输入的是圆点，说明用户在修改被隐藏的密码
            if (val.includes('•')) {
                // 清空，用 real 恢复显示
                const stored = secretReal.value;
                if (stored) {
                    secretInput.value = '•'.repeat(stored.length);
                    // 把光标移到末尾
                    setTimeout(() => {
                        secretInput.setSelectionRange(stored.length, stored.length);
                    }, 0);
                }
            } else {
                // 用户输入了明文
                secretReal.value = val;
                secretInput.classList.add('secret-mask');
            }
        });
        secretInput.addEventListener('focus', () => {
            // 聚焦时显示真实值（临时）
            const stored = secretReal.value;
            if (stored) {
                secretInput.value = stored;
                secretInput.classList.remove('secret-mask');
                setTimeout(() => {
                    secretInput.setSelectionRange(stored.length, stored.length);
                }, 0);
            }
        });
        secretInput.addEventListener('blur', () => {
            // 失去焦点时重新隐藏
            const stored = secretReal.value;
            if (stored) {
                secretInput.value = '•'.repeat(stored.length);
                secretInput.classList.add('secret-mask');
            }
        });

        shadow.getElementById('gyp-shadow-save').onclick = () => {
            const rpc = shadow.getElementById('gyp-shadow-rpc').value.trim();
            const secret = secretReal.value;
            if (!rpc) {
                alert('请输入 RPC 地址');
                return;
            }
            localStorage.setItem('gyp_aria2_config', JSON.stringify({ rpc, secret }));
            showToast('配置已保存');
            updateAria2ButtonState();
            modal.remove();
        };

        // 聚焦
        setTimeout(() => shadow.getElementById('gyp-shadow-rpc').focus(), 100);

        document.body.appendChild(modal);
    }

    function updateAria2ButtonState() {
        // 更新配置按钮状态
    }

    function getFileNameFromUrl(url) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const fileName = pathname.split('/').pop();
            return decodeURIComponent(fileName) || '未知文件';
        } catch {
            return url.split('/').pop() || '未知文件';
        }
    }

    function getAllLinks() {
        const modal = document.getElementById('gyp-modal-overlay');
        const rows = modal.querySelector('#gyp-result-tbody').querySelectorAll('tr');
        const links = [];
        rows.forEach(row => {
            const urlLink = row.querySelector('.gyp-col-url a');
            const nameCell = row.querySelector('.gyp-col-name');
            const sizeCell = row.querySelector('.gyp-col-size');
            if (urlLink && urlLink.textContent) {
                const url = urlLink.textContent.trim();
                const name = nameCell ? nameCell.textContent.trim() : getFileNameFromUrl(url);
                const size = sizeCell ? parseInt(sizeCell.getAttribute('title') || '0', 10) : 0;
                links.push({ url, name, size });
            }
        });
        return links;
    }

    function getSelectedLinks() {
        const modal = document.getElementById('gyp-modal-overlay');
        const checkboxes = modal.querySelectorAll('.gyp-row-checkbox:checked');
        const links = [];
        checkboxes.forEach(cb => {
            const tr = cb.closest('tr');
            if (tr) {
                const urlLink = tr.querySelector('.gyp-col-url a');
                const nameCell = tr.querySelector('.gyp-col-name');
                if (urlLink && urlLink.textContent) {
                    const url = urlLink.textContent.trim();
                    const name = nameCell ? nameCell.textContent.trim() : getFileNameFromUrl(url);
                    const size = parseInt(cb.getAttribute('data-size') || '0', 10);
                    links.push({ url, name, size });
                }
            }
        });
        return links;
    }

    async function aria2SendLinks(links) {
        const config = getAria2Config();
        if (!config.rpc) {
            showToast('请先配置 RPC 地址', 2000, 'warning');
            return { success: 0, failed: 0 };
        }

        const secret = config.secret ? 'token:' + config.secret : '';
        const rpcUrl = config.rpc;

        let success = 0;
        let failed = 0;

        for (const link of links) {
            try {
                const result = await new Promise((resolve, reject) => {
                    GM.xmlHttpRequest({
                        method: 'POST',
                        url: rpcUrl,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({
                            jsonrpc: '2.0',
                            id: Date.now(),
                            method: 'aria2.addUri',
                            params: secret ? [secret, [link.url], { out: link.name }] : [[link.url], { out: link.name }]
                        }),
                        onload: function(response) {
                            try {
                                const data = JSON.parse(response.responseText);
                                resolve(data);
                            } catch (e) {
                                reject(e);
                            }
                        },
                        onerror: function(err) {
                            reject(err);
                        }
                    });
                });

                if (result.error) {
                    console.error('Aria2 error:', result.error);
                    failed++;
                } else {
                    success++;
                }
            } catch (err) {
                console.error('Aria2 request failed:', err);
                failed++;
            }
        }

        return { success, failed };
    }

    function formatSize(bytes) {
        if (!bytes || bytes === 0) return '-';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (bytes >= 1024 && i < units.length - 1) {
            bytes /= 1024;
            i++;
        }
        return bytes.toFixed(bytes < 10 ? 2 : 1) + ' ' + units[i];
    }

    // 确认弹窗
    function showConfirmModal(title, message, count, totalSize, onConfirm) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; inset: 0; z-index: 10000000; display: flex; align-items: center; justify-content: center;';
        const sizeText = totalSize > 0 ? '<div style="margin-top: 8px; font-size: 14px; color: #667eea; font-weight: 600;">总计: ' + formatSize(totalSize) + '</div>' : '';
        overlay.innerHTML =
            '<div style="position: fixed; inset: 0; background: rgba(0,0,0,0.45);" onclick="this.parentElement.remove()"></div>' +
            '<div style="position: relative; width: 420px; background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); overflow: hidden;">' +
            '<div style="padding: 20px 24px 16px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: #fff;">' +
            '<div style="font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 10px;">' +
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            title +
            '</div>' +
            '</div>' +
            '<div style="padding: 24px;">' +
            '<div style="font-size: 15px; color: #333; margin-bottom: 8px; line-height: 1.6;">' + message + '</div>' +
            '<div style="display: flex; gap: 12px; margin: 16px 0;">' +
            '<div style="flex: 1; text-align: center; padding: 16px; background: linear-gradient(135deg, #fff5f6 0%, #fff 100%); border-radius: 8px; border: 2px dashed #fecdd3;">' +
            '<div style="font-size: 28px; font-weight: 700; color: #f5576c;">' + count + '</div>' +
            '<div style="font-size: 13px; color: #868e96; margin-top: 4px;">个文件</div>' +
            '</div>' +
            '<div style="flex: 1; text-align: center; padding: 16px; background: linear-gradient(135deg, #f0f4ff 0%, #fff 100%); border-radius: 8px; border: 2px dashed #c7d2fe;">' +
            '<div style="font-size: 28px; font-weight: 700; color: #667eea;">' + (totalSize > 0 ? formatSize(totalSize) : '-') + '</div>' +
            '<div style="font-size: 13px; color: #868e96; margin-top: 4px;">总体积</div>' +
            '</div>' +
            '</div>' +
            '<div style="font-size: 13px; color: #868e96; text-align: center;">点击确认后将开始下载任务</div>' +
            '</div>' +
            '<div style="padding: 16px 24px 20px; display: flex; justify-content: flex-end; gap: 12px;">' +
            '<button id="gyp-confirm-cancel" style="padding: 10px 22px; font-size: 14px; font-weight: 500; border: 1px solid #d9d9d9; border-radius: 6px; background: #fff; color: #495057; cursor: pointer; transition: all 0.2s;">取消</button>' +
            '<button id="gyp-confirm-ok" style="padding: 10px 22px; font-size: 14px; font-weight: 500; border: none; border-radius: 6px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: #fff; cursor: pointer; box-shadow: 0 4px 12px rgba(245, 87, 108, 0.35); transition: all 0.2s;">确认发送</button>' +
            '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        const closeModal = () => overlay.remove();

        overlay.querySelector('#gyp-confirm-cancel').onclick = closeModal;
        overlay.querySelector('#gyp-confirm-ok').onclick = () => {
            closeModal();
            onConfirm();
        };
    }

    async function sendToAria2Selected() {
        const config = getAria2Config();
        if (!config.rpc) {
            showToast('请先配置 RPC 地址', 2000, 'warning');
            return;
        }
        const links = getSelectedLinks();
        if (links.length === 0) {
            showToast('请先选择要发送的链接', 2000, 'warning');
            return;
        }
        const totalSize = links.reduce((sum, link) => sum + (link.size || 0), 0);
        showConfirmModal('确认下载', '即将下载选中的文件到 Aria2', links.length, totalSize, async () => {
            showToast('正在发送到 Aria2...', 3000);
            const result = await aria2SendLinks(links);
            if (result.failed === 0) {
                showToast('成功发送 ' + result.success + ' 个任务到 Aria2');
            } else {
                showToast('发送完成：成功 ' + result.success + ' 个，失败 ' + result.failed + ' 个', 3000, 'warning');
            }
        });
    }

    async function sendToAria2All() {
        const config = getAria2Config();
        if (!config.rpc) {
            showToast('请先配置 RPC 地址', 2000, 'warning');
            return;
        }
        const links = getAllLinks();
        if (links.length === 0) {
            showToast('没有可发送的链接', 2000, 'warning');
            return;
        }
        const totalSize = links.reduce((sum, link) => sum + (link.size || 0), 0);
        showConfirmModal('确认下载全部', '即将下载全部文件到 Aria2', links.length, totalSize, async () => {
            showToast('正在发送到 Aria2...', 3000);
            const result = await aria2SendLinks(links);
            if (result.failed === 0) {
                showToast('成功发送 ' + result.success + ' 个任务到 Aria2');
            } else {
                showToast('发送完成：成功 ' + result.success + ' 个，失败 ' + result.failed + ' 个', 3000, 'warning');
            }
        });
    }

    function updateAria2Buttons() {
        const modal = document.getElementById('gyp-modal-overlay');
        if (!modal) return;
        const sendSelectedBtn = modal.querySelector('#gyp-aria2-send-selected');
        const sendAllBtn = modal.querySelector('#gyp-aria2-send-all');
        const config = getAria2Config();

        if (config.rpc) {
            sendSelectedBtn.disabled = false;
            sendAllBtn.disabled = false;
        } else {
            sendSelectedBtn.disabled = true;
            sendAllBtn.disabled = true;
        }
    }

    function createModal() {
        if (modalCreated) return;

        const modal = document.createElement('div');
        modal.id = 'gyp-modal-overlay';
        modal.innerHTML = '<div class="gyp-modal gyp-modal-v2">' +
            '<div class="gyp-modal-header">' +
            '<span class="gyp-modal-title">获取直链</span>' +
            '<div class="gyp-modal-header-actions">' +
            '<button class="gyp-settings-btn" id="gyp-aria2-config" title="Aria2 配置">⚙ Aria2</button>' +
            '<button class="gyp-modal-close" id="gyp-modal-close">&times;</button>' +
            '</div>' +
            '</div>' +
            '<div class="gyp-modal-body">' +
            '<div class="gyp-progress-wrapper">' +
            '<div class="gyp-progress-info">' +
            '<span id="gyp-progress-text">准备就绪</span>' +
            '<span id="gyp-progress-percent">0%</span>' +
            '</div>' +
            '<div class="gyp-progress-bar">' +
            '<div class="gyp-progress-fill" id="gyp-progress-fill"></div>' +
            '<div class="gyp-progress-glow"></div>' +
            '</div>' +
            '</div>' +
            '<div class="gyp-result-table" id="gyp-result-table">' +
            '<table class="gyp-table-head"><thead><tr><td class="gyp-col-select"><input type="checkbox" id="gyp-select-all" class="gyp-select-all"></td><td class="gyp-col-name">文件名</td><td class="gyp-col-url">直链地址</td><td class="gyp-col-size">大小</td><td class="gyp-col-action">操作</td></tr></thead></table>' +
            '<div class="gyp-table-body"><table class="gyp-table-content"><tbody id="gyp-result-tbody"></tbody></table></div>' +
            '</div>' +
            '<div class="gyp-selected-bar" id="gyp-selected-bar">' +
            '<div class="gyp-selected-left">' +
            '<button class="gyp-btn gyp-btn-sm" id="gyp-deselect-selected">反选</button>' +
            '<span id="gyp-selected-count">已选择 0 项</span>' +
            '<button class="gyp-btn gyp-btn-sm gyp-hidden" id="gyp-copy-selected-name">复制文件名</button>' +
            '<button class="gyp-btn gyp-btn-sm gyp-hidden" id="gyp-copy-selected">复制直链</button>' +
            '</div>' +
            '<div class="gyp-selected-right">' +
            '<button class="gyp-btn gyp-btn-aria2 gyp-hidden" id="gyp-aria2-send-selected"><span style="display:inline-flex;align-items:center;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>下载选中</span></button>' +
            '<button class="gyp-btn gyp-btn-aria2-all" id="gyp-aria2-send-all"><span style="display:inline-flex;align-items:center;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>下载全部</span></button>' +
            '<button class="gyp-btn" id="gyp-copy-all"><span style="display:inline-flex;align-items:center;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>一键复制</span></button>' +
            '<button class="gyp-btn" id="gyp-modal-close-btn"><span style="display:inline-flex;align-items:center;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>关闭</span></button>' +
            '</div>' +
            '</div>' +
            '<div class="gyp-error-info" id="gyp-error-info"></div>' +
            '</div>' +
            '</div>';

        document.body.appendChild(modal);

        modal.querySelector('#gyp-modal-close').onclick = closeModal;
        modal.querySelector('#gyp-modal-close-btn').onclick = closeModal;
        modal.onclick = function(e) {
            if (e.target === modal) closeModal();
        };
        modal.querySelector('#gyp-copy-all').onclick = copyAllUrls;
        modal.querySelector('#gyp-select-all').onclick = function() {
            const checked = this.checked;
            const tbody = modal.querySelector('#gyp-result-tbody');
            const checkboxes = tbody.querySelectorAll('.gyp-row-checkbox');
            checkboxes.forEach(function(cb) { cb.checked = checked; });
            updateSelectedBar();
            // 全选操作后，清除 indeterminate 状态
            this.indeterminate = false;
        };
        modal.querySelector('#gyp-copy-selected').onclick = copySelectedUrls;
        modal.querySelector('#gyp-copy-selected-name').onclick = copySelectedNames;
        modal.querySelector('#gyp-deselect-selected').onclick = deselectAll;

        // Aria2 事件处理
        modal.querySelector('#gyp-aria2-config').onclick = openAria2Modal;
        modal.querySelector('#gyp-aria2-send-selected').onclick = sendToAria2Selected;
        modal.querySelector('#gyp-aria2-send-all').onclick = sendToAria2All;

        modalCreated = true;
    }

    function updateSelectAllState() {
        const modal = document.getElementById('gyp-modal-overlay');
        const tbody = modal.querySelector('#gyp-result-tbody');
        const selectAllCheckbox = modal.querySelector('#gyp-select-all');
        if (!tbody || !selectAllCheckbox) return;

        const checkboxes = tbody.querySelectorAll('.gyp-row-checkbox');
        const total = checkboxes.length;
        const checked = tbody.querySelectorAll('.gyp-row-checkbox:checked').length;

        if (total === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        } else if (checked === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        } else if (checked === total) {
            selectAllCheckbox.checked = true;
            selectAllCheckbox.indeterminate = false;
        } else {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = true;
        }
    }

    function updateSelectedBar() {
        const modal = document.getElementById('gyp-modal-overlay');
        const tbody = modal.querySelector('#gyp-result-tbody');
        const checkboxes = tbody.querySelectorAll('.gyp-row-checkbox:checked');
        const count = checkboxes.length;
        const countSpan = modal.querySelector('#gyp-selected-count');
        const copyNameBtn = modal.querySelector('#gyp-copy-selected-name');
        const copyUrlBtn = modal.querySelector('#gyp-copy-selected');
        const aria2SelectedBtn = modal.querySelector('#gyp-aria2-send-selected');
        countSpan.textContent = '已选择 ' + count + ' 项';
        if (count > 0) {
            copyNameBtn.classList.remove('gyp-hidden');
            copyUrlBtn.classList.remove('gyp-hidden');
            aria2SelectedBtn.classList.remove('gyp-hidden');
        } else {
            copyNameBtn.classList.add('gyp-hidden');
            copyUrlBtn.classList.add('gyp-hidden');
            aria2SelectedBtn.classList.add('gyp-hidden');
        }
        updateSelectAllState();
    }

    function copySelectedUrls() {
        const modal = document.getElementById('gyp-modal-overlay');
        const tbody = modal.querySelector('#gyp-result-tbody');
        const checkboxes = tbody.querySelectorAll('.gyp-row-checkbox:checked');
        const urls = [];
        checkboxes.forEach(function(cb) {
            const url = cb.getAttribute('data-url');
            if (url) urls.push(url);
        });
        if (urls.length > 0) {
            copyToClipboard(urls.join('\n'));
        } else {
            showToast('没有可复制的URL', 2000, 'warning');
        }
    }

    function copySelectedNames() {
        const modal = document.getElementById('gyp-modal-overlay');
        const tbody = modal.querySelector('#gyp-result-tbody');
        const rows = tbody.querySelectorAll('.gyp-row-checkbox:checked');
        const names = [];
        rows.forEach(function(cb) {
            const tr = cb.closest('tr');
            if (tr) {
                const nameCell = tr.querySelector('.gyp-col-name');
                if (nameCell) {
                    const name = nameCell.textContent.trim();
                    if (name) names.push(name);
                }
            }
        });
        if (names.length > 0) {
            copyToClipboard(names.join('\n'));
        } else {
            showToast('没有可复制的文件名', 2000, 'warning');
        }
    }

    function deselectAll() {
        const modal = document.getElementById('gyp-modal-overlay');
        const tbody = modal.querySelector('#gyp-result-tbody');
        const checkboxes = tbody.querySelectorAll('.gyp-row-checkbox');
        checkboxes.forEach(function(cb) { cb.checked = !cb.checked; });
        updateSelectedBar();
    }

    function closeModal() {
        cancelFetch();
        const modal = document.getElementById('gyp-modal-overlay');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    function cancelFetch() {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    }

    function showToast(message, duration, type) {
        duration = duration || 2000;
        type = type || 'success';
        let toast = document.getElementById('gyp-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'gyp-toast';
            toast.innerHTML = '<span class="gyp-toast-msg"></span>';
            document.body.appendChild(toast);
        }
        toast.querySelector('.gyp-toast-msg').textContent = message;
        toast.className = 'gyp-toast gyp-toast-show gyp-toast-' + type;
        setTimeout(function() {
            toast.className = 'gyp-toast';
        }, duration);
    }

    function showModal() {
        createModal();
        const modal = document.getElementById('gyp-modal-overlay');
        modal.style.display = 'flex';
        resetModalState();
    }

    function resetModalState() {
        document.getElementById('gyp-progress-text').textContent = '准备就绪';
        document.getElementById('gyp-progress-percent').textContent = '0%';
        document.getElementById('gyp-progress-fill').style.width = '0%';
        document.getElementById('gyp-result-tbody').innerHTML = '';
        document.getElementById('gyp-select-all').checked = false;
        const errorInfo = document.getElementById('gyp-error-info');
        errorInfo.innerHTML = '';
        errorInfo.style.display = 'none';
        // 重置复制按钮为隐藏状态
        document.getElementById('gyp-copy-selected-name').classList.add('gyp-hidden');
        document.getElementById('gyp-copy-selected').classList.add('gyp-hidden');
        document.getElementById('gyp-selected-count').textContent = '已选择 0 项';
    }

    function updateProgress(current, total, message) {
        const percent = Math.round((current / total) * 100);
        document.getElementById('gyp-progress-text').textContent = message || '正在获取: ' + current + '/' + total;
        document.getElementById('gyp-progress-percent').textContent = percent + '%';
        document.getElementById('gyp-progress-fill').style.width = percent + '%';
    }

    function addResultRow(fileName, url, size, error) {
        const tbody = document.getElementById('gyp-result-tbody');
        const tr = document.createElement('tr');
        if (error) tr.className = 'gyp-row-error';

        const selectTd = document.createElement('td');
        selectTd.className = 'gyp-col-select';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'gyp-row-checkbox';
        checkbox.setAttribute('data-url', url || '');
        checkbox.setAttribute('data-size', size || 0);
        checkbox.onclick = updateSelectedBar;
        selectTd.appendChild(checkbox);

        const nameTd = document.createElement('td');
        nameTd.className = 'gyp-col-name';
        nameTd.textContent = fileName;
        nameTd.title = fileName;

        const urlTd = document.createElement('td');
        urlTd.className = 'gyp-col-url';
        if (error) {
            urlTd.textContent = '获取失败: ' + error;
            urlTd.style.color = '#dc3545';
            urlTd.title = '获取失败: ' + error;
        } else {
            const urlLink = document.createElement('a');
            urlLink.href = url;
            urlLink.target = '_blank';
            urlLink.textContent = url;
            urlTd.appendChild(urlLink);
            urlTd.title = url;
        }

        const sizeTd = document.createElement('td');
        sizeTd.className = 'gyp-col-size';
        sizeTd.textContent = formatSize(size);
        sizeTd.title = size ? size + ' 字节' : '';

        const actionTd = document.createElement('td');
        actionTd.className = 'gyp-col-action';
        if (!error) {
            const copyNameBtn = document.createElement('button');
            copyNameBtn.className = 'gyp-btn gyp-btn-sm';
            copyNameBtn.textContent = '复制文件名';
            copyNameBtn.onclick = function() {
                copyToClipboard(fileName);
            };
            actionTd.appendChild(copyNameBtn);

            const copyUrlBtn = document.createElement('button');
            copyUrlBtn.className = 'gyp-btn gyp-btn-sm';
            copyUrlBtn.textContent = '复制直链';
            copyUrlBtn.style.marginLeft = '6px';
            copyUrlBtn.onclick = function() {
                copyToClipboard(url);
            };
            actionTd.appendChild(copyUrlBtn);
        }

        tr.appendChild(selectTd);
        tr.appendChild(nameTd);
        tr.appendChild(urlTd);
        tr.appendChild(sizeTd);
        tr.appendChild(actionTd);
        tbody.appendChild(tr);
    }

    function copyToClipboard(text) {
        if (!text || text.trim() === '') {
            showToast('没有内容可复制', 2000, 'warning');
            return;
        }
        navigator.clipboard.writeText(text).then(function() {
            showToast('已复制到剪贴板');
        }, function(err) {
            console.error('复制失败:', err);
            showToast('复制失败，请手动复制', 3000, 'error');
        });
    }

    function copyAllUrls() {
        const tbody = document.getElementById('gyp-result-tbody');
        const rows = tbody.querySelectorAll('tr');
        const urls = [];

        for (let i = 0; i < rows.length; i++) {
            const urlCell = rows[i].querySelector('.gyp-col-url a');
            if (urlCell && urlCell.textContent) {
                urls.push(urlCell.textContent);
            }
        }

        if (urls.length > 0) {
            copyToClipboard(urls.join('\n'));
        } else {
            showToast('没有可复制的链接', 2000, 'warning');
        }
    }

    function fetchWithTimeout(url, options, timeout, signal) {
        return new Promise(function(resolve, reject) {
            const timeoutId = setTimeout(function() {
                reject(new Error('请求超时'));
            }, timeout);

            if (signal && signal.aborted) {
                clearTimeout(timeoutId);
                reject(new Error('请求已取消'));
                return;
            }

            const controller = new AbortController();
            const fetchSignal = signal ? signal : controller.signal;

            fetch(url, { ...options, signal: fetchSignal }).then(function(response) {
                clearTimeout(timeoutId);
                resolve(response);
            }, function(error) {
                clearTimeout(timeoutId);
                if (error.name === 'AbortError') {
                    reject(new Error('请求已取消'));
                } else {
                    reject(error);
                }
            });
        });
    }

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function getDownloadUrl(fileId, fileSize, signal) {
        const authHeader = getAuthHeader();
        console.log('GYP: authHeader:', authHeader ? authHeader.substring(0, 80) + '...' : 'null');
        if (!authHeader) {
            throw new Error('未登录或Token不存在');
        }

        if (signal && signal.aborted) {
            throw new Error('请求已取消');
        }

        const traceId = Math.random().toString(16).substr(2, 32);
        const spanId = Date.now().toString(16);
        const traceparent = '00-' + traceId + '-' + spanId + '-01';

        let lastError;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (signal && signal.aborted) {
                throw new Error('请求已取消');
            }
            try {
                const response = await fetchWithTimeout(API_URL, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                        'Authorization': authHeader,
                        'Content-Type': 'application/json',
                        'Origin': 'https://www.guangyapan.com',
                        'Referer': 'https://www.guangyapan.com/',
                        'did': generateDid(),
                        'dt': '4',
                        'Sec-Ch-Ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
                        'Sec-Ch-Ua-Mobile': '?0',
                        'Sec-Ch-Ua-Platform': '"Windows"',
                        'Sec-Fetch-Dest': 'empty',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Site': 'same-site',
                        'Traceparent': traceparent,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
                    },
                    body: JSON.stringify({ fileId: fileId })
                }, FETCH_TIMEOUT, signal);

                if (!response.ok) {
                    throw new Error('请求失败: ' + response.status);
                }

                const data = await response.json();
                if (data.msg === 'success' && data.data && data.data.signedURL) {
                    return { url: data.data.signedURL, size: fileSize || 0 };
                } else {
                    throw new Error(data.msg || '获取直链失败');
                }
            } catch (err) {
                lastError = err;
                if (err.message === '请求已取消') {
                    throw err;
                }
                if (attempt < MAX_RETRIES - 1) {
                    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
                    console.log(`GYP: Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms:`, err.message);
                    await sleep(delay);
                }
            }
        }

        throw lastError || new Error('获取直链失败');
    }

    function getSelectedFiles() {
        // 优先使用 map 中记录的选中文件（用户点击过的）
        if (selectedFilesMap.size > 0) {
            return getSelectedFilesFromMap();
        }

        // 尝试从 React 状态获取选中项
        const marker = getSelectedFileIdsFromFramework();

        if (marker.ids.size > 0) {
            console.log('GYP: Using framework state, found', marker.ids.size, 'selected IDs');
            const files = [];

            marker.ids.forEach(id => {
                const idStr = String(id);
                let name = null;
                let isDir = false;
                let size = 0;

                // 优先从 filesMap 获取文件名、类型和大小（React 的 dataSource）
                if (marker.filesMap && marker.filesMap.has(idStr)) {
                    const fileData = marker.filesMap.get(idStr);
                    name = fileData.fileName;
                    isDir = fileData.isDir;
                    size = fileData.size || 0;
                }

                // 否则从 names 中找
                if (!name) {
                    name = Array.from(marker.names).find(n => n) || null;
                }

                // 最后 fallback
                if (!name) {
                    name = '文件_' + idStr;
                }

                // 跳过文件夹
                if (isDir) {
                    console.log('GYP: Skipping folder:', name);
                    return;
                }

                files.push({ id: idStr, name, size });
            });
            return files;
        }

        // Fallback: 从当前 DOM 获取
        console.log('GYP: Falling back to DOM');
        const rows = document.querySelectorAll('.ant-table-row-selected');
        const files = [];

        rows.forEach(row => {
            const fileId = row.getAttribute('data-row-key');
            if (!fileId) return;

            // 检查是否是文件夹（通过图标判断）
            const folderIcon = row.querySelector('.swangpan-icon-typefolder, [class*="folder"]');
            if (folderIcon) {
                console.log('GYP: Skipping folder from DOM:', fileId);
                return;
            }

            const nameDiv = row.querySelector('.ant-table-cell:nth-child(2) [title]') ||
                row.querySelector('.ant-table-cell:nth-child(2)');
            const name = nameDiv ? (nameDiv.getAttribute('title') || nameDiv.textContent) : ('文件_' + fileId);
            files.push({ id: fileId, name: name.trim() });
        });

        console.log('GYP: DOM found', files.length, 'files');
        return files;
    }

    async function fetchWithConcurrency(files) {
        let completed = 0;
        const errors = [];
        let aborted = false;

        abortController = new AbortController();
        const signal = abortController.signal;

        async function processFile(file) {
            if (signal.aborted) {
                return { file: file, url: null, size: 0, error: '已取消' };
            }
            try {
                const result = await getDownloadUrl(file.id, file.size || 0, signal);
                return { file: file, url: result.url, size: file.size || 0, error: null };
            } catch (err) {
                if (err.name === 'AbortError' || err.message === '请求已取消') {
                    return { file: file, url: null, size: 0, error: '已取消' };
                }
                return { file: file, url: null, size: 0, error: err.message };
            }
        }

        try {
            for (let i = 0; i < files.length; i += CONCURRENCY) {
                if (signal.aborted) {
                    aborted = true;
                    break;
                }

                const batch = files.slice(i, i + CONCURRENCY);
                const batchPromises = batch.map(processFile);
                const batchResults = await Promise.all(batchPromises);

                for (let j = 0; j < batchResults.length; j++) {
                    const result = batchResults[j];
                    completed++;
                    updateProgress(completed, files.length, '正在获取: ' + completed + '/' + files.length);
                    addResultRow(result.file.name, result.url, result.size, result.error);
                    if (result.error) {
                        errors.push({ name: result.file.name, error: result.error });
                    }
                }

                if (i + CONCURRENCY < files.length) {
                    await sleep(BATCH_DELAY);
                }
            }
        } catch (err) {
            console.error('GYP: Fetch error:', err);
        } finally {
            abortController = null;
        }

        return { errors: errors, aborted: aborted };
    }

    async function startFetch() {
        // 从 map 或 DOM 获取选中的文件
        const files = getSelectedFiles();

        if (files.length === 0) {
            showToast('请先选择要获取直链的文件', 2000, 'warning');
            return;
        }

        showModal();
        updateProgress(0, files.length, '开始获取: 0/' + files.length);

        const result = await fetchWithConcurrency(files);

        const total = files.length;
        const successCount = total - result.errors.length;
        const failCount = result.errors.length;

        // 用户取消时单独处理
        if (result.aborted) {
            document.getElementById('gyp-progress-text').textContent = '已取消获取';
            document.getElementById('gyp-progress-fill').style.width = '100%';
            showToast('用户取消获取', 3000, 'warning');
            return;
        }

        document.getElementById('gyp-progress-text').textContent = '获取完成：成功 ' + successCount + ' 个，失败 ' + failCount + ' 个';
        document.getElementById('gyp-progress-fill').style.width = '100%';

        if (result.errors.length > 0) {
            const errorDiv = document.getElementById('gyp-error-info');
            errorDiv.innerHTML = '<strong>失败文件 (' + result.errors.length + '个):</strong><br>' +
                result.errors.map(function(e) { return e.name + ': ' + e.error; }).join('<br>');
            errorDiv.style.display = 'block';
        }

        if (failCount === 0) {
            showToast('全部获取成功！');
        } else {
            showToast('获取完成，' + failCount + ' 个失败', 3000, 'warning');
        }
    }

    function removeButton() {
        const btn = document.querySelector('.gyp-script-btn');
        if (btn) {
            btn.remove();
        }
    }

    function addButton() {
        // 只在 /home/ 开头的路由下添加按钮
        if (!window.location.hash.startsWith('#/home/')) {
            removeButton();
            return;
        }

        // 如果按钮已存在，先移除再重新添加（可能需要重新定位）
        removeButton();

        const uploadBtn = findUploadButton();
        if (!uploadBtn) {
            return;
        }

        const btnContainer = uploadBtn.parentNode;
        if (!btnContainer) return;

        const btn = document.createElement('button');
        btn.className = uploadBtn.className + ' gyp-script-btn';
        btn.textContent = '获取直链';
        btn.style.marginLeft = '10px';
        btn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)';
        btn.style.border = 'none';
        btn.style.borderRadius = '6px';
        btn.style.color = '#fff';
        btn.style.fontWeight = 'bold';
        btn.style.padding = '8px 16px';
        btn.style.boxShadow = '0 4px 15px rgba(102, 126, 234, 0.4), inset 0 1px 0 rgba(255,255,255,0.3)';
        btn.style.textShadow = '0 1px 2px rgba(0,0,0,0.2)';
        btn.style.transition = 'all 0.3s ease';
        btn.style.cursor = 'pointer';
        btn.onclick = startFetch;

        btnContainer.insertBefore(btn, uploadBtn.nextSibling);
        console.log('GYP: Button added successfully');
    }

    function addStyles() {
        if (document.getElementById('gyp-styles')) return;

        const style = document.createElement('style');
        style.id = 'gyp-styles';
        style.textContent = [
            '#gyp-modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); z-index: 999999; justify-content: center; align-items: center; }',
            '.gyp-modal-v2 { background: #fff; border-radius: 8px; width: 900px; max-width: 95%; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2); overflow: hidden; user-select: text; -webkit-user-select: text; }',
            '.gyp-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e8e8e8; flex-shrink: 0; }',
            '.gyp-modal-title { font-size: 16px; font-weight: 500; color: #333; }',
            '.gyp-modal-header-actions { display: flex; align-items: center; gap: 8px; }',
            '.gyp-settings-btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; color: #fff; padding: 6px 14px; transition: all 0.3s ease; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3); }',
            '.gyp-settings-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }',
            '.gyp-modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: #999; padding: 0; line-height: 1; }',
            '.gyp-modal-close:hover { color: #666; }',
            '.gyp-modal-body { padding: 20px; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }',
            '.gyp-progress-wrapper { margin-bottom: 16px; flex-shrink: 0; }',
            '.gyp-progress-info { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 14px; font-weight: 500; }',
            '.gyp-progress-text { color: #333; }',
            '.gyp-progress-percent { color: #667eea; font-weight: 600; font-size: 14px; text-shadow: 0 1px 2px rgba(102, 126, 234, 0.3); }',
            '.gyp-progress-bar { height: 10px; background: linear-gradient(180deg, #e8eaf6 0%, #f5f5f5 100%); border-radius: 10px; overflow: hidden; position: relative; box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1), 0 1px 0 rgba(255, 255, 255, 0.8); }',
            '.gyp-progress-fill { height: 100%; background: linear-gradient(90deg, #667eea 0%, #764ba2 50%, #f093fb 100%); border-radius: 10px; transition: width 0.4s ease; position: relative; box-shadow: 0 0 10px rgba(102, 126, 234, 0.5), 0 2px 4px rgba(0, 0, 0, 0.1); }',
            '.gyp-progress-fill::after { content: ""; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.3) 50%, transparent 100%); animation: gyp-shine 2s infinite; }',
            '.gyp-progress-glow { position: absolute; top: 50%; left: 0; transform: translateY(-50%); height: 20px; width: 60px; background: radial-gradient(ellipse at center, rgba(240, 147, 251, 0.4) 0%, transparent 70%); pointer-events: none; }',
            '@keyframes gyp-shine { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }',
            '.gyp-result-table { border: 1px solid #e8e8e8; border-radius: 4px; display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; min-width: 850px; }',
            '.gyp-table-head { width: 100%; border-collapse: separate; border-spacing: 0; flex-shrink: 0; table-layout: fixed; }',
            '.gyp-table-head td { background: linear-gradient(180deg, #f0f4ff 0%, #e8edff 100%); padding: 8px 12px; text-align: center; font-weight: 600; font-size: 13px; color: #5a67d8; border-bottom: none; box-shadow: inset 0 2px 4px rgba(255,255,255,0.8), inset 0 -1px 2px rgba(99, 102, 241, 0.03), 0 2px 4px rgba(99, 102, 241, 0.08); text-shadow: 0 1px 2px rgba(255,255,255,0.8); letter-spacing: 1px; }',
            '.gyp-col-select { width: 40px; text-align: center; }',
            '.gyp-col-name { width: 30%; text-align: center; max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.gyp-col-url { width: 35%; text-align: center; max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.gyp-col-size { width: 13%; text-align: center; color: #666; font-size: 13px; }',
            '.gyp-col-action { width: 22%; text-align: center; white-space: nowrap; }',
            '.gyp-table-body { overflow-y: auto; flex: 1; min-height: 0; }',
            '.gyp-table-content { width: 100%; border-collapse: collapse; table-layout: fixed; }',
            '.gyp-table-content td { padding: 12px 12px; font-size: 13px; color: #666; border-bottom: 1px solid #e8e8e8; text-align: center; background-color: #fff; }',
            '.gyp-table-content tr:last-child td { border-bottom: none; }',
            '.gyp-table-content tr.gyp-row-error { background-color: #fff2f0; }',
            '.gyp-table-content tr:hover { background-color: #f5f5f5; }',
            '.gyp-cell-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.gyp-cell-select { text-align: center; }',
            '.gyp-cell-url { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.gyp-col-url a { color: #1890ff; text-decoration: none; }',
            '.gyp-col-url a:hover { text-decoration: underline; }',
            '.gyp-cell-action { white-space: nowrap; }',
            '.gyp-row-checkbox { width: 16px; height: 16px; cursor: pointer; accent-color: #1890ff; }',
            '.gyp-select-all { width: 16px; height: 16px; cursor: pointer; accent-color: #1890ff; }',
            '.gyp-error-info { margin-top: 12px; padding: 12px; background-color: #fff2f0; border: 1px solid #ffccc7; border-radius: 4px; font-size: 13px; color: #dc3545; display: none; flex-shrink: 0; max-height: 100px; overflow-y: auto; }',
            '.gyp-selected-bar { display: flex; justify-content: space-between; align-items: center; padding: 16px 16px 20px 16px; background: linear-gradient(180deg, #f8f9ff 0%, #eef1fa 100%); border-top: 1px solid #d4d8f0; flex-shrink: 0; margin-top: 8px; }',
            '.gyp-selected-left { display: flex; align-items: center; gap: 12px; }',
            '.gyp-selected-right { display: flex; align-items: center; gap: 12px; }',
            // 反选按钮 - 极光绿渐变
            '.gyp-selected-bar #gyp-deselect-selected { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); border: none; color: #fff; box-shadow: 0 2px 8px rgba(56, 239, 125, 0.3); transition: all 0.3s ease; }',
            '.gyp-selected-bar #gyp-deselect-selected:hover { background: linear-gradient(135deg, #15b3a6 0%, #4ff88f 100%); box-shadow: 0 4px 12px rgba(56, 239, 125, 0.4); transform: translateY(-1px); }',
            // 复制文件名按钮 - 科技蓝渐变风格
            '.gyp-selected-bar #gyp-copy-selected-name { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; color: #fff; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3); transition: all 0.3s ease; }',
            '.gyp-selected-bar #gyp-copy-selected-name:hover { background: linear-gradient(135deg, #7b8ff0 0%, #8a5cb8 100%); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); transform: translateY(-1px); }',
            // 复制直链按钮 - 活力橙渐变风格
            '.gyp-selected-bar #gyp-copy-selected { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); border: none; color: #fff; box-shadow: 0 2px 8px rgba(245, 87, 108, 0.3); transition: all 0.3s ease; }',
            '.gyp-selected-bar #gyp-copy-selected:hover { background: linear-gradient(135deg, #f2a3fc 0%, #f76d84 100%); box-shadow: 0 4px 12px rgba(245, 87, 108, 0.4); transform: translateY(-1px); }',
            // 一键复制全部链接 - 阳光黄渐变
            '.gyp-selected-bar #gyp-copy-all { background: linear-gradient(135deg, #f5af19 0%, #f12711 100%); border: none; color: #fff; font-size: 13px; font-weight: 600; padding: 7px 16px; box-shadow: 0 4px 12px rgba(245, 39, 17, 0.4); transition: all 0.3s ease; }',
            '.gyp-selected-bar #gyp-copy-all:hover { background: linear-gradient(135deg, #f7c41f 0%, #f23921 100%); box-shadow: 0 6px 16px rgba(245, 39, 17, 0.5); transform: translateY(-2px); }',
            // 关闭按钮 - 沉稳灰蓝渐变
            '.gyp-selected-bar #gyp-modal-close-btn { background: linear-gradient(135deg, #4b6cb7 0%, #182848 100%); border: none; color: #fff; font-size: 13px; font-weight: 600; padding: 7px 16px; box-shadow: 0 4px 12px rgba(24, 40, 72, 0.4); transition: all 0.3s ease; }',
            '.gyp-selected-bar #gyp-modal-close-btn:hover { background: linear-gradient(135deg, #5b7cc7 0%, #283858 100%); box-shadow: 0 6px 16px rgba(24, 40, 72, 0.5); transform: translateY(-2px); }',
            '.gyp-btn { padding: 8px 20px; font-size: 14px; border-radius: 4px; cursor: pointer; border: 1px solid #d9d9d9; background: #fff; color: #333; transition: all 0.2s ease; }',
            '.gyp-hidden { display: none !important; }',
            '.gyp-btn:hover { color: #1890ff; border-color: #1890ff; }',
            '.gyp-btn-primary { background: #1890ff; border-color: #1890ff; color: #fff; }',
            '.gyp-btn-primary:hover { background: #40a9ff; border-color: #40a9ff; color: #fff; }',
            '.gyp-btn-danger { background: #ff4d4f; border-color: #ff4d4f; color: #fff; }',
            '.gyp-btn-danger:hover { background: #ff7875; border-color: #ff7875; color: #fff; }',
            '.gyp-btn-sm { padding: 4px 10px; font-size: 12px; cursor: pointer; }',
            '.gyp-script-btn:hover { background: linear-gradient(135deg, #5a67d8 0%, #6b46c1 50%, #e879f9 100%) !important; box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5), inset 0 1px 0 rgba(255,255,255,0.3) !important; transform: translateY(-1px); }',
            '.gyp-toast { position: fixed; top: 80px; left: 50%; transform: translateX(-50%); z-index: 1000000; background: rgba(0, 0, 0, 0.75); color: #fff; padding: 12px 24px; border-radius: 6px; font-size: 14px; opacity: 0; transition: opacity 0.3s ease; pointer-events: none; }',
            '.gyp-toast.gyp-toast-show { opacity: 1; }',
            '.gyp-toast.gyp-toast-warning { background: rgba(250, 173, 20, 0.95); }',
            '.gyp-toast.gyp-toast-error { background: rgba(255, 77, 79, 0.95); }',
            // Aria2 按钮样式
            '.gyp-btn-aria2 { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%) !important; border: none !important; color: #fff !important; font-size: 13px !important; font-weight: 600 !important; padding: 7px 16px !important; box-shadow: 0 4px 12px rgba(56, 239, 125, 0.4); }',
            '.gyp-btn-aria2:hover { background: linear-gradient(135deg, #15b3a6 0%, #4ff88f 100%) !important; box-shadow: 0 6px 16px rgba(56, 239, 125, 0.5); transform: translateY(-1px); }',
            '.gyp-btn-aria2-all { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%) !important; border: none !important; color: #fff !important; font-size: 13px !important; font-weight: 600 !important; padding: 7px 16px !important; box-shadow: 0 4px 12px rgba(245, 87, 108, 0.4); }',
            '.gyp-btn-aria2-all:hover { background: linear-gradient(135deg, #f2a3fc 0%, #f76d84 100%) !important; box-shadow: 0 6px 16px rgba(245, 87, 108, 0.5); transform: translateY(-1px); }',
            // Aria2 配置弹窗样式
            '#gyp-aria2-modal-overlay { display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); z-index: 1000000; justify-content: center; align-items: center; }',
            '.gyp-aria2-modal { background: #fff; border-radius: 12px; width: 480px; max-width: 95%; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2); overflow: hidden; user-select: text; -webkit-user-select: text; }',
            '.gyp-aria2-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; user-select: none; -webkit-user-select: none; }',
            '.gyp-aria2-modal-header span { font-size: 16px; font-weight: 600; }',
            '.gyp-aria2-modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: rgba(255,255,255,0.8); padding: 0; line-height: 1; }',
            '.gyp-aria2-modal-close:hover { color: #fff; }',
            '.gyp-aria2-modal-body { padding: 24px; user-select: text; -webkit-user-select: text; }',
            '.gyp-aria2-form-group { margin-bottom: 16px; }',
            '.gyp-aria2-form-group label { display: block; font-size: 14px; font-weight: 500; color: #333; margin-bottom: 8px; }',
            '.gyp-aria2-form-group input { width: 100%; padding: 12px 16px; font-size: 14px; border: 2px solid #e8e8e8; border-radius: 8px; outline: none; transition: border-color 0.2s; box-sizing: border-box; background-color: #fff !important; color: #333 !important; -webkit-user-select: text !important; -moz-user-select: text !important; -ms-user-select: text !important; user-select: text !important; -webkit-touch-callout: default !important; -khtml-user-select: text !important; }',
            '.gyp-aria2-form-group input::placeholder { color: #999 !important; user-select: none !important; }',
            '.gyp-aria2-form-group input:focus { border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); background-color: #fff; }',
            '.gyp-aria2-modal-actions { display: flex; gap: 12px; margin-top: 24px; }',
            '.gyp-aria2-modal-actions .gyp-btn { flex: 1; padding: 12px 16px; font-size: 14px; }'
	        ].join('\n');

        document.head.appendChild(style);
    }

    function tryInit() {
        addStyles();
        addButton();
    }

    function init() {
        addStyles();

        // 设置 checkbox 监听器
        setupCheckboxListener();

        const scheduleInit = () => {
            tryInit();
            setTimeout(tryInit, 500);
            setTimeout(tryInit, 1500);
            setTimeout(tryInit, 3000);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scheduleInit);
        } else {
            scheduleInit();
        }

        // 使用 MutationObserver 监听页面变化，检测上传按钮
        const observer = new MutationObserver(() => {
            if (window.location.hash.startsWith('#/home/')) {
                const uploadBtn = findUploadButton();
                if (uploadBtn && !document.querySelector('.gyp-script-btn')) {
                    tryInit();
                }
            }
            // 定期清理过期的选中记录
            cleanExpiredSelections();
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });

        // 监听 URL 变化（SPA 页面切换）
        window.addEventListener('hashchange', () => {
            // 页面切换后直接尝试添加，不重置 flag
            setTimeout(tryInit, 500);
            setTimeout(tryInit, 1500);
        });
    }

    init();
})();
