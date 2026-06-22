// ==UserScript==
// @name         光鸭云盘 - 获取直链
// @namespace    http://tampermonkey.net/
// @author       快乐无极
// @version      1.8
// @description  获取所选文件的直链地址，支持勾选目录自动递归获取子文件
// @match        https://www.guangyapan.com/*
// @grant        GM.xmlHttpRequest
// @connect      localhost
// @connect      127.0.0.1
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
    let fileListCache = null;
    let fileListCacheTime = 0;
    const FILE_LIST_CACHE_TTL = 2000;
    let lastCleanTime = 0;
    const CLEAN_INTERVAL = 5000;

    // 记录选中的文件
    const selectedFilesMap = new Map(); // fileId -> { name, addedAt }

    // ========== 目录递归相关 ==========
    const LIST_API_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/file/get_file_list';
    const DIR_PAGE_SIZE = 100;
    const DIR_MAX_PAGES = 50; // 每个目录最多翻50页
    const DIR_REQUEST_DELAY = 200;
    let capturedListHeaders = null;
    let dirScanAbortController = null;
    let cachedScanResult = null; // 缓存目录扫描结果，避免重复遍历

    // ========== 文件类型分类 ==========
    const FILE_CATEGORIES = {
        '视频': {
            extensions: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.rmvb', '.rm', '.3gp', '.m2ts', '.vob', '.ogv', '.divx'],
            icon: '🎬',
            color: '#f5576c'
        },
        '图片': {
            extensions: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.heic', '.heif', '.tiff', '.tif', '.raw', '.psd', '.ai'],
            icon: '🖼️',
            color: '#667eea'
        },
        '压缩包': {
            extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.tgz', '.tbz2', '.zst', '.lz4', '.cab', '.arj'],
            icon: '📦',
            color: '#f5af19'
        },
        '文档': {
            extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.md', '.epub', '.mobi', '.azw3', '.chm', '.html', '.htm', '.xml', '.json'],
            icon: '📄',
            color: '#11998e'
        },
        '音频': {
            extensions: ['.mp3', '.flac', '.aac', '.ogg', '.wav', '.wma', '.m4a', '.ape', '.opus', '.ac3', '.dts', '.aiff', '.alac'],
            icon: '🎵',
            color: '#764ba2'
        }
    };

    // 根据文件名判断分类
    function getFileCategory(fileName) {
        const ext = '.' + (fileName || '').split('.').pop().toLowerCase();
        for (const [category, info] of Object.entries(FILE_CATEGORIES)) {
            if (info.extensions.includes(ext)) return category;
        }
        return '其他';
    }

    function parseSizeInput(value, unit) {
        // unit: 'B', 'KB', 'MB', 'GB', 'TB'
        const num = parseFloat(value);
        if (isNaN(num) || num < 0) return 0;
        const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1048576, 'GB': 1073741824, 'TB': 1099511627776 };
        return Math.floor(num * (multipliers[unit] || 1));
    }

    function bytesToUnit(bytes, unit) {
        const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1048576, 'GB': 1073741824, 'TB': 1099511627776 };
        const divider = multipliers[unit] || 1;
        return bytes / divider;
    }

    // ========== React 内部状态获取选中项 ==========

    function looksLikeFileId(key) {
        if (!key || typeof key !== 'string') return false;
        const text = String(key).trim();
        // 光鸭的 fileId 是 19 位数字字符串
        return /^\d{16,22}$/.test(text);
    }

    // 从 React DevTools 可以看到：FileList -> props -> dataSource 和 selectedItems
    function findFileListComponent() {
        const now = Date.now();
        if (fileListCache && (now - fileListCacheTime) < FILE_LIST_CACHE_TTL) {
            return fileListCache;
        }

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
                    return { props, type: 'memoizedProps', componentName: typeName };
                }
            }

            // 检查 pendingProps
            if (fiber.pendingProps) {
                const props = fiber.pendingProps;
                if (props.selectedItems !== undefined || props.dataSource) {
                    return { props, type: 'pendingProps', componentName: typeName };
                }
            }

            // 检查 stateNode 的 props
            if (fiber.stateNode && typeof fiber.stateNode === 'object') {
                const node = fiber.stateNode;
                if (node.props && (node.props.selectedItems !== undefined || node.props.dataSource)) {
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

        for (const { fiber } of roots) {
            const found = findFileList(fiber);
            if (found) {
                fileListCache = found;
                fileListCacheTime = now;
                return found;
            }
        }
        return null;
    }

    function getSelectedItemsFromReact() {
        const result = findFileListComponent();
        if (!result) {
            return { ids: new Set(), names: new Set(), filesMap: new Map() };
        }

        const { props } = result;

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

        return reactMarker;
    }

    // ========== 选中文件监听 ==========

    function setupCheckboxListener() {
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

                let fileSize = 0;
                if (fileListCache && fileListCache.props) {
                    const props = fileListCache.props;
                    const dataSource = props.dataSource || [];
                    if (Array.isArray(dataSource)) {
                        const fileData = dataSource.find(item => item && String(item.fileId) === fileId);
                        if (fileData) fileSize = fileData.fileSize || 0;
                    }
                }

                if (checkbox.checked) {
                    selectedFilesMap.set(fileId, { name: fileName.trim(), size: fileSize, addedAt: Date.now() });
                } else {
                    selectedFilesMap.delete(fileId);
                }
            });
        });

        document.querySelectorAll('.ant-table-header .ant-checkbox-input').forEach(checkbox => {
            checkbox.addEventListener('click', (e) => {
                setTimeout(() => {
                    if (e.target.checked) {
                        selectedFilesMap.clear();
                        const marker = getSelectedFileIdsFromFramework();
                        document.querySelectorAll('.ant-table-row-selected').forEach(row => {
                            const fileId = row.getAttribute('data-row-key');
                            if (fileId) {
                                const nameDiv = row.querySelector('.ant-table-cell:nth-child(2) [title]') ||
                                row.querySelector('.ant-table-cell:nth-child(2)');
                                const name = nameDiv ? (nameDiv.getAttribute('title') || nameDiv.textContent) : ('文件_' + fileId);
                                const fileData = marker.filesMap ? marker.filesMap.get(fileId) : null;
                                const fileSize = fileData ? (fileData.size || 0) : 0;
                                selectedFilesMap.set(fileId, { name: name.trim(), size: fileSize, addedAt: Date.now() });
                            }
                        });
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
    }

    // 动态生成设备ID
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

    // ========== XHR 拦截器：捕获列表API请求头 ==========

    function setupListHeaderCapture() {
        if (window._gyp_list_capture_setup) return;
        window._gyp_list_capture_setup = true;

        const origOpen = XMLHttpRequest.prototype.open;
        const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._gyp_url = url;
            this._gyp_method = method;
            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            if (this._gyp_url && /get_file_list|bizuserres|guangyapan/i.test(this._gyp_url)) {
                if (!this._gyp_headers) this._gyp_headers = {};
                this._gyp_headers[name.toLowerCase()] = value;
            }
            return origSetRequestHeader.apply(this, arguments);
        };

        // 拦截 fetch 请求
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
            if (typeof input === 'string' && /get_file_list|bizuserres|guangyapan/i.test(input)) {
                if (init && init.headers) {
                    const headers = {};
                    if (init.headers instanceof Headers) {
                        init.headers.forEach((value, key) => {
                            headers[key.toLowerCase()] = value;
                        });
                    } else if (Array.isArray(init.headers)) {
                        init.headers.forEach(([key, value]) => {
                            headers[key.toLowerCase()] = value;
                        });
                    } else if (typeof init.headers === 'object') {
                        Object.entries(init.headers).forEach(([key, value]) => {
                            headers[key.toLowerCase()] = value;
                        });
                    }
                    if (headers.authorization) {
                        updateCapturedHeaders(headers);
                    }
                }
            }
            return origFetch.apply(this, arguments);
        };
    }

    function updateCapturedHeaders(headers) {
        if (!capturedListHeaders) {
            capturedListHeaders = {};
        }
        const forwardKeys = ['authorization', 'did', 'dt', 'appid', 'timestamp', 'signature', 'nonce'];
        forwardKeys.forEach(key => {
            if (headers[key] && !capturedListHeaders[key]) {
                capturedListHeaders[key] = headers[key];
            }
        });
    }

    function getListApiHeaders() {
        setupListHeaderCapture();

        const authHeader = getAuthHeader();
        const base = {};

        if (authHeader) {
            base['authorization'] = authHeader;
        }

        // 合并捕获的头信息
        if (capturedListHeaders) {
            Object.assign(base, capturedListHeaders);
        }

        // 尝试从 localStorage 获取 did/dt
        if (!base['did']) {
            const storedDid = localStorage.getItem('did') || localStorage.getItem('device_id') || localStorage.getItem('Device-Id');
            if (storedDid) base['did'] = storedDid;
        }
        if (!base['dt']) {
            const storedDt = localStorage.getItem('dt') || localStorage.getItem('device_type');
            if (storedDt) base['dt'] = storedDt;
        }

        base['accept'] = 'application/json, text/plain, */*';
        base['content-type'] = 'application/json';

        return base;
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

    const loadAria2Config = getAria2Config;

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
                        <div class="form-hint" style="color: #b45309; display: flex; align-items: flex-start; gap: 8px; line-height: 1.6;">
                            <span style="font-size: 28px; line-height: 1; flex-shrink: 0;">💡</span>
                            <span>非 localhost/127.0.0.1 域名发送时会弹窗请求授权，建议选择"总是允许"，之后发送将直接通过，无需重复授权。</span>
                        </div>
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
            return { success: 0, failed: 0, errors: [] };
        }

        const secret = config.secret ? 'token:' + config.secret : '';
        const rpcUrl = config.rpc;

        let success = 0;
        let failed = 0;
        const errors = [];

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
                                resolve(JSON.parse(response.responseText));
                            } catch (e) {
                                reject(e);
                            }
                        },
                        onerror: reject
                    });
                });

                if (result.error) {
                    console.error('Aria2 error:', result.error);
                    let errMsg = result.error.message || '';
                    if (errMsg === 'Unauthorized' || errMsg === 'Forbidden' || result.error.code === -32600) {
                        errMsg = '密钥错误，请检查 RPC 密钥配置是否正确';
                    } else if (errMsg === 'Not Found' || result.error.code === -32600) {
                        errMsg = 'Aria2 方法不存在，可能是版本不兼容';
                    } else if (!errMsg) {
                        errMsg = 'Aria2 返回错误: ' + JSON.stringify(result.error);
                    }
                    errors.push({ name: link.name, error: errMsg });
                    failed++;
                    break;
                } else {
                    success++;
                }
            } catch (err) {
                console.error('Aria2 request failed:', err);
                let errMsg;
                const errStr = (err.error || err.statusText || '').toLowerCase();
                if (errStr.includes('blocked by the user') || errStr.includes('denied') || errStr.includes('refused')) {
                    errMsg = '请求被拒绝，请在弹窗中选择"允许"以继续请求';
                } else if (err.status === 0 || err.status === undefined) {
                    errMsg = '无法连接到 Aria2 服务，请确认服务已启动且 RPC 地址正确';
                } else if (err.status >= 400 && err.status < 500) {
                    errMsg = '请求错误 (HTTP ' + err.status + ')';
                } else if (err.status >= 500) {
                    errMsg = 'Aria2 服务器错误 (HTTP ' + err.status + ')';
                } else {
                    errMsg = err.statusText || ('HTTP ' + err.status);
                }
                errors.push({ name: link.name, error: errMsg });
                failed++;
                break;
            }
        }

        return { success, failed, errors };
    }

    function showAria2ErrorAlert(errors) {
        const errorList = errors.map(e => '<div style="margin-bottom: 8px; border-bottom: 1px solid #fecaca; padding-bottom: 8px;"><div style="font-weight: 600; color: #dc2626; word-break: break-all;">' + e.name + '</div><div style="color: #991b1b; font-size: 13px;">' + e.error + '</div></div>').join('');
        const overlay = document.createElement('div');
        overlay.id = 'gyp-aria2-error-overlay';
        overlay.style.cssText = 'position: fixed; inset: 0; z-index: 10000000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5);';
        overlay.innerHTML =
            '<div style="width: 500px; max-width: 90%; max-height: 80vh; background: #fef2f2; border: 2px solid #ef4444; border-radius: 12px; overflow: hidden; flex-shrink: 0;">' +
            '<div style="padding: 16px 20px; background: #dc2626; color: #fff; display: flex; justify-content: space-between; align-items: center;">' +
            '<div style="font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px;">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' +
            'Aria2 发送失败' +
            '</div>' +
            '<button id="gyp-error-close-btn" style="background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; padding: 0; line-height: 1;">×</button>' +
            '</div>' +
            '<div style="padding: 16px; overflow-y: auto; max-height: calc(80vh - 120px);">' +
            '<div style="margin-bottom: 12px; color: #991b1b; font-weight: 600;">遇到错误，发送已中断，以下文件未能发送：</div>' +
            errorList +
            '</div>' +
            '<div style="padding: 12px 16px; border-top: 1px solid #fecaca; display: flex; justify-content: center;">' +
            '<button id="gyp-error-close-btn-bottom" style="padding: 8px 24px; background: #dc2626; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">我知道了</button>' +
            '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        document.getElementById('gyp-error-close-btn').addEventListener('click', function() {
            overlay.remove();
        });
        document.getElementById('gyp-error-close-btn-bottom').addEventListener('click', function() {
            overlay.remove();
        });
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                overlay.remove();
            }
        });
    }

    function showAria2SuccessAlert(count) {
        const overlay = document.createElement('div');
        overlay.id = 'gyp-aria2-success-overlay';
        overlay.style.cssText = 'position: fixed; inset: 0; z-index: 10000000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5);';
        overlay.innerHTML =
            '<div style="width: 340px; max-width: 90%; background: #fff; border: 2px solid #22c55e; border-radius: 12px; overflow: hidden; flex-shrink: 0;">' +
            '<div style="padding: 24px; display: flex; align-items: center; gap: 16px;">' +
            '<svg class="gyp-success-checkmark" width="60" height="60" viewBox="0 0 60 60" style="flex-shrink: 0;">' +
            '<circle cx="30" cy="30" r="26" fill="none" stroke="#22c55e" stroke-width="3"/>' +
            '<path class="gyp-check-path" d="M18 30 L26 38 L42 22" fill="none" stroke="#22c55e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>' +
            '<div style="flex: 1;">' +
            '<div style="font-size: 18px; font-weight: 600; color: #15803d;">发送成功</div>' +
            '<div style="font-size: 15px; font-weight: 600; color: #166534; margin-top: 4px;">' + count + ' 个任务已发送到 Aria2</div>' +
            '<div style="font-size: 13px; color: #166534; margin-top: 2px;"><span id="gyp-success-seconds">3</span> 秒后自动关闭</div>' +
            '</div>' +
            '</div>' +
            '<div style="padding: 12px 16px; border-top: 1px solid #bbf7d0; display: flex; justify-content: center;">' +
            '<button id="gyp-success-close-btn" style="padding: 6px 20px; background: #22c55e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">我知道了</button>' +
            '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        // 动画样式
        const style = document.createElement('style');
        style.textContent =
            '@keyframes gyp-check-draw { 0% { stroke-dashoffset: 50; } 100% { stroke-dashoffset: 0; } }' +
            '@keyframes gyp-circle-draw { 0% { stroke-dashoffset: 170; } 100% { stroke-dashoffset: 0; } }';
        document.head.appendChild(style);

        const checkPath = overlay.querySelector('.gyp-check-path');
        checkPath.style.strokeDasharray = '50';
        checkPath.style.strokeDashoffset = '50';
        checkPath.style.animation = 'gyp-check-draw 0.4s ease-out 0.3s forwards';

        const circle = overlay.querySelector('circle');
        circle.style.strokeDasharray = '170';
        circle.style.strokeDashoffset = '170';
        circle.style.animation = 'gyp-circle-draw 0.5s ease-out forwards';

        const closeAlert = function() {
            overlay.remove();
            style.remove();
        };
        document.getElementById('gyp-success-close-btn').addEventListener('click', closeAlert);

        // 3秒后自动关闭
        let remaining = 3;
        const secondsSpan = document.getElementById('gyp-success-seconds');
        const updateCountdown = function() {
            remaining--;
            if (remaining > 0 && secondsSpan) {
                secondsSpan.textContent = remaining;
                setTimeout(updateCountdown, 1000);
            } else {
                closeAlert();
            }
        };
        setTimeout(updateCountdown, 1000);
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
            hideToast();
            if (result.failed === 0) {
                showAria2SuccessAlert(result.success);
            } else {
                showToast('发送完成：成功 ' + result.success + ' 个，失败 ' + result.failed + ' 个', 3000, 'warning');
                if (result.errors.length > 0) {
                    showAria2ErrorAlert(result.errors);
                }
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
            hideToast();
            if (result.failed === 0) {
                showAria2SuccessAlert(result.success);
            } else {
                showToast('发送完成：成功 ' + result.success + ' 个，失败 ' + result.failed + ' 个', 3000, 'warning');
                if (result.errors.length > 0) {
                    showAria2ErrorAlert(result.errors);
                }
            }
        });
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
            '<button class="gyp-btn gyp-btn-sm gyp-hidden" id="gyp-refilter-btn" title="使用缓存数据重新筛选，无需重新扫描目录">🔍 重新筛选</button>' +
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
        modal.querySelector('#gyp-refilter-btn').onclick = reopenFilterFromCache;

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
        cachedScanResult = null; // 关闭弹窗时清空缓存
        const modal = document.getElementById('gyp-modal-overlay');
        if (modal) {
            modal.style.display = 'none';
        }
        // 隐藏重新筛选按钮
        const refilterBtn = document.getElementById('gyp-refilter-btn');
        if (refilterBtn) { refilterBtn.classList.add('gyp-hidden'); }
    }

    function cancelFetch() {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
        if (dirScanAbortController) {
            dirScanAbortController.abort();
            dirScanAbortController = null;
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
        if (toast._timeoutId) {
            clearTimeout(toast._timeoutId);
            toast._timeoutId = null;
        }
        toast.querySelector('.gyp-toast-msg').textContent = message;
        toast.className = 'gyp-toast gyp-toast-show gyp-toast-' + type;
        toast._timeoutId = setTimeout(function() {
            toast.className = 'gyp-toast';
            toast._timeoutId = null;
        }, duration);
    }

    function hideToast() {
        const toast = document.getElementById('gyp-toast');
        if (toast) {
            if (toast._timeoutId) {
                clearTimeout(toast._timeoutId);
                toast._timeoutId = null;
            }
            toast.className = 'gyp-toast';
        }
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
        const selectAll = document.getElementById('gyp-select-all');
        selectAll.checked = false;
        selectAll.indeterminate = false;
        const errorInfo = document.getElementById('gyp-error-info');
        errorInfo.innerHTML = '';
        errorInfo.style.display = 'none';
        // 重置复制按钮为隐藏状态
        document.getElementById('gyp-copy-selected-name').classList.add('gyp-hidden');
        document.getElementById('gyp-copy-selected').classList.add('gyp-hidden');
        document.getElementById('gyp-aria2-send-selected').classList.add('gyp-hidden');
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

    function gmFetchWithTimeout(url, options, timeout, signal) {
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
        if (!authHeader) {
            throw new Error('未登录或Token不存在');
        }

        if (signal && signal.aborted) {
            throw new Error('请求已取消');
        }

        let lastError;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (signal && signal.aborted) {
                throw new Error('请求已取消');
            }
            try {
                const response = await gmFetchWithTimeout(API_URL, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
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

    // ========== 目录列表 API ==========

    async function fetchFileListPage(parentId, pageIndex, pageSize, signal) {
        if (signal && signal.aborted) {
            throw new Error('请求已取消');
        }

        const headers = getListApiHeaders();

        const requestBody = {
            parentId: String(parentId || '').trim(),
            pageSize: pageSize || DIR_PAGE_SIZE,
            orderBy: 0,
            sortType: 0
        };
        if (pageIndex > 0) {
            requestBody.page = pageIndex + 1;
        }

        let lastError;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (signal && signal.aborted) {
                throw new Error('请求已取消');
            }
            try {
                const response = await gmFetchWithTimeout(LIST_API_URL, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(requestBody)
                }, FETCH_TIMEOUT, signal);

                if (!response.ok) {
                    throw new Error('请求失败: ' + response.status);
                }

                const data = await response.json();
                if (data.msg === 'success' && data.data) {
                    // data.data 可能直接是数组或者是 { list: [], ... } 结构
                    const items = Array.isArray(data.data) ? data.data : (data.data.list || data.data.items || []);
                    return {
                        items: items,
                        hasMore: items.length >= (pageSize || DIR_PAGE_SIZE)
                    };
                } else {
                    throw new Error(data.msg || '获取文件列表失败');
                }
            } catch (err) {
                lastError = err;
                if (err.message === '请求已取消') {
                    throw err;
                }
                if (attempt < MAX_RETRIES - 1) {
                    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
                    await sleep(delay);
                }
            }
        }

        throw lastError || new Error('获取文件列表失败');
    }

    async function fetchAllFilesInDir(parentId, dirName, options) {
        options = options || {};
        const signal = options.signal;
        const pageSize = DIR_PAGE_SIZE;
        const maxPages = options.maxPages || DIR_MAX_PAGES;
        const onProgress = options.onProgress;

        const allFiles = [];
        const allDirs = [];
        const seenIds = new Set();

        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
            if (signal && signal.aborted) {
                return { files: allFiles, dirs: allDirs, aborted: true };
            }

            const result = await fetchFileListPage(parentId, pageIndex, pageSize, signal);
            const items = result.items;

            if (!items.length) break;

            let newCount = 0;
            for (const item of items) {
                const fileId = String(item.fileId || '');
                if (!fileId || seenIds.has(fileId)) continue;
                seenIds.add(fileId);

                const resType = item.resType;
                const isDir = resType === 2;

                if (isDir) {
                    allDirs.push({
                        fileId: fileId,
                        fileName: item.fileName || item.name || '',
                        dirId: item.dirId || fileId
                    });
                } else {
                    allFiles.push({
                        id: fileId,
                        name: item.fileName || item.name || '',
                        size: item.fileSize || item.size || 0
                    });
                }
                newCount++;
            }

            if (onProgress) {
                onProgress({ dirName: dirName, filesFound: allFiles.length, dirsFound: allDirs.length, page: pageIndex + 1 });
            }

            if (!result.hasMore || items.length < pageSize) break;

            if (DIR_REQUEST_DELAY > 0) {
                await sleep(DIR_REQUEST_DELAY);
            }
        }

        return { files: allFiles, dirs: allDirs, aborted: false };
    }

    async function collectAllFilesRecursive(dirIds, dirNames, options) {
        options = options || {};
        const signal = options.signal;
        const onProgress = options.onProgress;
        const maxDepth = options.maxDepth || 20;

        const allFiles = [];
        const processedDirs = new Set();
        const errors = [];
        let aborted = false;

        // BFS 队列: { dirId, dirName, depth, path }
        const queue = dirIds.map((dirId, i) => ({
            dirId: String(dirId || ''),
            dirName: dirNames[i] || '文件夹_' + dirId,
            depth: 0,
            path: dirNames[i] || '文件夹_' + dirId
        }));

        while (queue.length > 0) {
            if (signal && signal.aborted) {
                aborted = true;
                break;
            }

            const current = queue.shift();
            const dirKey = current.dirId;

            if (processedDirs.has(dirKey)) continue;
            processedDirs.add(dirKey);

            try {
                const result = await fetchAllFilesInDir(current.dirId, current.dirName, {
                    signal: signal,
                    maxPages: DIR_MAX_PAGES,
                    onProgress: (info) => {
                        if (onProgress) {
                            onProgress({
                                dirName: current.dirName,
                                path: current.path,
                                depth: current.depth,
                                filesFound: allFiles.length,
                                dirsFound: queue.length,
                                page: info.page
                            });
                        }
                    }
                });

                if (result.aborted) {
                    aborted = true;
                    break;
                }

                // 添加找到的文件
                allFiles.push(...result.files);

                // 将子目录加入队列
                if (current.depth < maxDepth) {
                    for (const subDir of result.dirs) {
                        queue.push({
                            dirId: subDir.fileId,
                            dirName: subDir.fileName,
                            depth: current.depth + 1,
                            path: current.path + '/' + subDir.fileName
                        });
                    }
                }

                if (onProgress) {
                    onProgress({
                        dirName: current.dirName,
                        path: current.path,
                        depth: current.depth,
                        filesFound: allFiles.length,
                        dirsFound: queue.length,
                        processedDirs: processedDirs.size,
                        done: false
                    });
                }
            } catch (err) {
                console.error('GYP: Error scanning directory', current.dirName, ':', err.message);
                errors.push({ dirName: current.dirName, path: current.path, error: err.message });
            }
        }

        return {
            files: allFiles,
            errors: errors,
            aborted: aborted,
            processedDirs: processedDirs.size
        };
    }

    // ========== 文件筛选弹窗 ==========

    function showFileFilterModal(allFiles, onConfirm, onSkip) {
        // 计算统计信息
        const maxSize = allFiles.reduce((max, f) => Math.max(max, f.size || 0), 0);
        const totalCount = allFiles.length;
        const totalSize = allFiles.reduce((sum, f) => sum + (f.size || 0), 0);

        // 分类统计
        const categoryStats = {};
        allFiles.forEach(f => {
            const cat = getFileCategory(f.name);
            if (!categoryStats[cat]) categoryStats[cat] = { count: 0, size: 0 };
            categoryStats[cat].count++;
            categoryStats[cat].size += (f.size || 0);
        });

        // 移除现有弹窗
        const existing = document.getElementById('gyp-filter-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'gyp-filter-overlay';
        overlay.style.cssText = 'position: fixed; inset: 0; z-index: 10000001; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5);';

        // 默认单位 MB
        let filterState = {
            minSize: 0,
            maxSize: maxSize,
            minInput: '0',
            minUnit: 'MB',
            maxInput: bytesToUnit(maxSize, 'MB').toFixed(2),
            maxUnit: 'MB',
            enabledCategories: {},
            allFiles: allFiles
        };
        // 默认所有分类勾选
        Object.keys(FILE_CATEGORIES).forEach(cat => { filterState.enabledCategories[cat] = true; });

        function applyFilters() {
            const minBytes = filterState.minSize;
            const maxBytes = filterState.maxSize;
            const enabledCats = Object.entries(filterState.enabledCategories)
                .filter(([, v]) => v)
                .map(([k]) => k);

            const result = allFiles.filter(f => {
                const size = f.size || 0;
                if (size < minBytes || size > maxBytes) return false;
                const cat = getFileCategory(f.name);
                return enabledCats.includes(cat);
            });

            return result;
        }

        function updateStats() {
            const filtered = applyFilters();
            document.getElementById('gyp-filter-count').textContent = filtered.length + ' / ' + totalCount;
            document.getElementById('gyp-filter-size').textContent = formatSize(filtered.reduce((sum, f) => sum + (f.size || 0), 0));
            document.getElementById('gyp-filter-total-size').textContent = formatSize(totalSize);
        }

        function updateSliderLabels() {
            document.getElementById('gyp-filter-min-label').textContent = formatSize(filterState.minSize);
            document.getElementById('gyp-filter-max-label').textContent = filterState.maxSize >= maxSize ? formatSize(maxSize) + ' (全部)' : formatSize(filterState.maxSize);
        }

        function sliderFromBytes(bytes) {
            if (maxSize <= 0) return 0;
            // 对数刻度让滑块更易用
            return Math.log(1 + bytes) / Math.log(1 + maxSize) * 100;
        }

        function bytesFromSlider(percent) {
            if (maxSize <= 0) return 0;
            return Math.round(Math.pow(1 + maxSize, percent / 100) - 1);
        }

        // 构建弹窗 HTML
        const categoryToggles = Object.entries(FILE_CATEGORIES).map(([cat, info]) => {
            const stats = categoryStats[cat] || { count: 0, size: 0 };
            return (
                '<label class="gyp-filter-cat-item" style="--cat-color:' + info.color + '">' +
                '<input type="checkbox" class="gyp-filter-cat-check" data-cat="' + cat + '" checked>' +
                '<span class="gyp-filter-cat-icon">' + info.icon + '</span>' +
                '<span class="gyp-filter-cat-name">' + cat + '</span>' +
                '<span class="gyp-filter-cat-count">' + stats.count + '个</span>' +
                '</label>'
            );
        }).join('');

        overlay.innerHTML =
            '<div class="gyp-filter-modal">' +
            // 头部
            '<div class="gyp-filter-header">' +
            '<span>📋 文件筛选</span>' +
            '<button class="gyp-filter-close-btn" id="gyp-filter-close">×</button>' +
            '</div>' +
            // 主体
            '<div class="gyp-filter-body">' +
            // 统计概览
            '<div class="gyp-filter-summary">' +
            '<div class="gyp-filter-summary-item"><span class="gyp-summary-num">' + totalCount + '</span><span>个文件</span></div>' +
            '<div class="gyp-filter-summary-item"><span class="gyp-summary-num" id="gyp-filter-total-size">' + formatSize(totalSize) + '</span><span>总计</span></div>' +
            '<div class="gyp-filter-summary-item gyp-summary-active"><span class="gyp-summary-num" id="gyp-filter-count">' + totalCount + ' / ' + totalCount + '</span><span>筛选后</span></div>' +
            '<div class="gyp-filter-summary-item gyp-summary-active"><span class="gyp-summary-num" id="gyp-filter-size">' + formatSize(totalSize) + '</span><span>筛选后大小</span></div>' +
            '</div>' +
            // 文件类型
            '<div class="gyp-filter-section">' +
            '<div class="gyp-filter-section-title">📂 文件类型</div>' +
            '<div class="gyp-filter-cat-grid">' + categoryToggles +
            '<label class="gyp-filter-cat-item" style="--cat-color:#999">' +
            '<input type="checkbox" class="gyp-filter-cat-check" data-cat="其他" checked>' +
            '<span class="gyp-filter-cat-icon">📁</span>' +
            '<span class="gyp-filter-cat-name">其他</span>' +
            '<span class="gyp-filter-cat-count">' + (categoryStats['其他'] ? categoryStats['其他'].count : 0) + '个</span>' +
            '</label>' +
            '</div>' +
            '</div>' +
            // 大小范围
            '<div class="gyp-filter-section">' +
            '<div class="gyp-filter-section-title">📏 文件大小范围</div>' +
            '<div class="gyp-filter-range-inputs">' +
            '<div class="gyp-filter-range-group">' +
            '<span>最小</span>' +
            '<input type="number" class="gyp-filter-size-input" id="gyp-filter-min-input" value="0" min="0" step="0.01">' +
            '<select class="gyp-filter-unit-select" id="gyp-filter-min-unit">' +
            '<option value="B">B</option><option value="KB">KB</option><option value="MB" selected>MB</option><option value="GB">GB</option><option value="TB">TB</option>' +
            '</select>' +
            '</div>' +
            '<span class="gyp-filter-range-sep">~</span>' +
            '<div class="gyp-filter-range-group">' +
            '<span>最大</span>' +
            '<input type="number" class="gyp-filter-size-input" id="gyp-filter-max-input" value="' + bytesToUnit(maxSize, 'MB').toFixed(2) + '" min="0" step="0.01">' +
            '<select class="gyp-filter-unit-select" id="gyp-filter-max-unit">' +
            '<option value="B">B</option><option value="KB">KB</option><option value="MB" selected>MB</option><option value="GB">GB</option><option value="TB">TB</option>' +
            '</select>' +
            '</div>' +
            '</div>' +
            // 滑块
            '<div class="gyp-filter-slider-wrapper">' +
            '<div class="gyp-filter-slider-labels">' +
            '<span id="gyp-filter-min-label">0 B</span>' +
            '<span id="gyp-filter-max-label">' + formatSize(maxSize) + '</span>' +
            '</div>' +
            '<div class="gyp-filter-dual-slider">' +
            '<input type="range" class="gyp-filter-range" id="gyp-filter-range-min" min="0" max="100" value="0">' +
            '<input type="range" class="gyp-filter-range" id="gyp-filter-range-max" min="0" max="100" value="100">' +
            '<div class="gyp-filter-range-track" id="gyp-filter-range-track"></div>' +
            '</div>' +
            '<div class="gyp-filter-quick-sizes">' +
            '<button class="gyp-filter-quick-btn" data-min="0" data-max="0">全部</button>' +
            '<button class="gyp-filter-quick-btn" data-min="0" data-max="1048576">≤1MB</button>' +
            '<button class="gyp-filter-quick-btn" data-min="1048576" data-max="10485760">1-10MB</button>' +
            '<button class="gyp-filter-quick-btn" data-min="10485760" data-max="104857600">10-100MB</button>' +
            '<button class="gyp-filter-quick-btn" data-min="104857600" data-max="1073741824">100MB-1GB</button>' +
            '<button class="gyp-filter-quick-btn" data-min="1073741824" data-max="0">≥1GB</button>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</div>' +
            // 底部按钮
            '<div class="gyp-filter-footer">' +
            '<button class="gyp-filter-btn-skip" id="gyp-filter-skip">跳过筛选，获取全部</button>' +
            '<button class="gyp-filter-btn-reset" id="gyp-filter-reset">重置</button>' +
            '<button class="gyp-filter-btn-cancel" id="gyp-filter-cancel">取消</button>' +
            '<button class="gyp-filter-btn-confirm" id="gyp-filter-confirm">确认获取直链</button>' +
            '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        // 绑定事件
        const closeModal = () => { overlay.remove(); };
        document.getElementById('gyp-filter-close').onclick = closeModal;
        document.getElementById('gyp-filter-cancel').onclick = closeModal;
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) closeModal();
        });

        // 确认按钮
        document.getElementById('gyp-filter-confirm').onclick = function() {
            const filtered = applyFilters();
            if (filtered.length === 0) {
                showToast('筛选结果为空，请调整筛选条件', 2000, 'warning');
                return;
            }
            overlay.remove();
            onConfirm(filtered);
        };

        // 跳过按钮 — 直接获取全部，不筛选
        document.getElementById('gyp-filter-skip').onclick = function() {
            overlay.remove();
            if (onSkip) {
                onSkip(allFiles);
            } else {
                onConfirm(allFiles);
            }
        };

        // 重置按钮
        document.getElementById('gyp-filter-reset').onclick = function() {
            filterState.minSize = 0;
            filterState.maxSize = maxSize;
            filterState.minInput = '0';
            filterState.minUnit = 'MB';
            filterState.maxInput = bytesToUnit(maxSize, 'MB').toFixed(2);
            filterState.maxUnit = 'MB';
            Object.keys(FILE_CATEGORIES).forEach(cat => { filterState.enabledCategories[cat] = true; });
            filterState.enabledCategories['其他'] = true;

            // 更新 UI
            document.getElementById('gyp-filter-range-min').value = 0;
            document.getElementById('gyp-filter-range-max').value = 100;
            document.getElementById('gyp-filter-min-input').value = '0';
            document.getElementById('gyp-filter-max-input').value = bytesToUnit(maxSize, 'MB').toFixed(2);
            document.getElementById('gyp-filter-min-unit').value = 'MB';
            document.getElementById('gyp-filter-max-unit').value = 'MB';
            document.querySelectorAll('.gyp-filter-cat-check').forEach(cb => { cb.checked = true; });
            updateSliderLabels();
            updateStats();
            updateRangeTrack();
        };

        // 分类勾选
        document.querySelectorAll('.gyp-filter-cat-check').forEach(cb => {
            cb.addEventListener('change', function() {
                const cat = this.getAttribute('data-cat');
                if (cat) {
                    filterState.enabledCategories[cat] = this.checked;
                    updateStats();
                }
            });
        });

        // 大小滑块
        const rangeMin = document.getElementById('gyp-filter-range-min');
        const rangeMax = document.getElementById('gyp-filter-range-max');

        function updateRangeTrack() {
            const minVal = parseInt(rangeMin.value);
            const maxVal = parseInt(rangeMax.value);
            if (minVal > maxVal) return;
            const track = document.getElementById('gyp-filter-range-track');
            track.style.left = minVal + '%';
            track.style.width = (maxVal - minVal) + '%';
        }

        function syncSlidersToState() {
            rangeMin.value = Math.round(sliderFromBytes(filterState.minSize));
            rangeMax.value = Math.round(sliderFromBytes(filterState.maxSize));
            updateRangeTrack();
            updateSliderLabels();
            updateStats();
        }

        function syncInputsToState() {
            document.getElementById('gyp-filter-min-input').value = filterState.minInput;
            document.getElementById('gyp-filter-min-unit').value = filterState.minUnit;
            document.getElementById('gyp-filter-max-input').value = filterState.maxInput;
            document.getElementById('gyp-filter-max-unit').value = filterState.maxUnit;
        }

        rangeMin.addEventListener('input', function() {
            let val = parseInt(this.value);
            if (val >= parseInt(rangeMax.value)) {
                val = parseInt(rangeMax.value) - 1;
                this.value = Math.max(0, val);
            }
            filterState.minSize = bytesFromSlider(parseInt(this.value));
            filterState.minInput = bytesToUnit(filterState.minSize, filterState.minUnit).toFixed(2);
            updateRangeTrack();
            updateSliderLabels();
            updateStats();
            syncInputsToState();
        });

        rangeMax.addEventListener('input', function() {
            let val = parseInt(this.value);
            if (val <= parseInt(rangeMin.value)) {
                val = parseInt(rangeMin.value) + 1;
                this.value = Math.min(100, val);
            }
            filterState.maxSize = bytesFromSlider(parseInt(this.value));
            filterState.maxInput = bytesToUnit(filterState.maxSize, filterState.maxUnit).toFixed(2);
            updateRangeTrack();
            updateSliderLabels();
            updateStats();
            syncInputsToState();
        });

        // 手动输入大小
        document.getElementById('gyp-filter-min-input').addEventListener('input', function() {
            const unit = document.getElementById('gyp-filter-min-unit').value;
            const bytes = parseSizeInput(this.value, unit);
            filterState.minSize = bytes;
            filterState.minInput = this.value;
            filterState.minUnit = unit;
            syncSlidersToState();
        });

        document.getElementById('gyp-filter-min-unit').addEventListener('change', function() {
            const val = parseFloat(document.getElementById('gyp-filter-min-input').value);
            if (!isNaN(val) && val >= 0) {
                const bytes = parseSizeInput(val, this.value);
                filterState.minSize = bytes;
                filterState.minUnit = this.value;
            }
            syncSlidersToState();
        });

        document.getElementById('gyp-filter-max-input').addEventListener('input', function() {
            const unit = document.getElementById('gyp-filter-max-unit').value;
            const bytes = parseSizeInput(this.value, unit);
            filterState.maxSize = bytes || maxSize;
            filterState.maxInput = this.value;
            filterState.maxUnit = unit;
            syncSlidersToState();
        });

        document.getElementById('gyp-filter-max-unit').addEventListener('change', function() {
            const val = parseFloat(document.getElementById('gyp-filter-max-input').value);
            if (!isNaN(val) && val >= 0) {
                const bytes = parseSizeInput(val, this.value);
                filterState.maxSize = bytes || maxSize;
                filterState.maxUnit = this.value;
            }
            syncSlidersToState();
        });

        // 快捷大小按钮
        document.querySelectorAll('.gyp-filter-quick-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const minBytes = parseInt(this.getAttribute('data-min'));
                const maxBytesRaw = parseInt(this.getAttribute('data-max'));
                const maxBytes = maxBytesRaw === 0 ? maxSize : maxBytesRaw;

                filterState.minSize = minBytes;
                filterState.maxSize = maxBytes;
                filterState.minInput = bytesToUnit(minBytes, 'MB').toFixed(2);
                filterState.minUnit = 'MB';
                filterState.maxInput = bytesToUnit(maxBytes, 'MB').toFixed(2);
                filterState.maxUnit = 'MB';

                syncSlidersToState();
                syncInputsToState();
            });
        });

        // 初始化滑块轨道
        updateRangeTrack();
    }

    function getSelectedFiles() {
        const result = getSelectedItemsWithFolders();
        return result.files;
    }

    function getSelectedItemsWithFolders() {
        const files = [];
        const folders = [];

        // 优先使用 map 中记录的选中文件（用户点击过的）
        if (selectedFilesMap.size > 0) {
            const mapFiles = getSelectedFilesFromMap();
            // selectedFilesMap 不区分文件和文件夹，需要通过 filesMap 来区分
            const marker = getSelectedFileIdsFromFramework();
            mapFiles.forEach(f => {
                const fileData = marker.filesMap ? marker.filesMap.get(f.id) : null;
                if (fileData && fileData.isDir) {
                    folders.push({ id: f.id, name: f.name });
                } else {
                    files.push(f);
                }
            });
            return { files, folders };
        }

        // 尝试从 React 状态获取选中项
        const marker = getSelectedFileIdsFromFramework();

        if (marker.ids.size > 0) {
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

                if (isDir) {
                    folders.push({ id: idStr, name });
                } else {
                    files.push({ id: idStr, name, size });
                }
            });
            return { files, folders };
        }

        // Fallback: 从当前 DOM 获取
        const rows = document.querySelectorAll('.ant-table-row-selected');

        rows.forEach(row => {
            const fileId = row.getAttribute('data-row-key');
            if (!fileId) return;

            const nameDiv = row.querySelector('.ant-table-cell:nth-child(2) [title]') ||
                row.querySelector('.ant-table-cell:nth-child(2)');
            const name = nameDiv ? (nameDiv.getAttribute('title') || nameDiv.textContent) : ('文件_' + fileId);

            // 检查是否是文件夹（通过图标判断）
            const folderIcon = row.querySelector('.swangpan-icon-typefolder, [class*="folder"]');
            if (folderIcon) {
                folders.push({ id: fileId, name: name.trim() });
            } else {
                files.push({ id: fileId, name: name.trim() });
            }
        });

        return { files, folders };
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

    // 使用缓存数据重新打开筛选器（无需重新扫描目录）
    function reopenFilterFromCache() {
        if (!cachedScanResult || cachedScanResult.length === 0) {
            showToast('暂无缓存的扫描数据，请重新选择文件夹获取', 2000, 'warning');
            return;
        }

        // 清空现有结果表格
        const tbody = document.getElementById('gyp-result-tbody');
        if (tbody) { tbody.innerHTML = ''; }
        const errorDiv = document.getElementById('gyp-error-info');
        if (errorDiv) { errorDiv.innerHTML = ''; errorDiv.style.display = 'none'; }
        const selectAll = document.getElementById('gyp-select-all');
        if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
        updateSelectedBar();
        updateSelectAllState();

        // 隐藏重新筛选按钮（筛选后会根据结果重新显示）
        const refilterBtn = document.getElementById('gyp-refilter-btn');
        if (refilterBtn) { refilterBtn.classList.add('gyp-hidden'); }

        // 更新进度为筛选状态
        document.getElementById('gyp-progress-text').textContent =
            '已缓存 ' + cachedScanResult.length + ' 个文件 (总大小 ' + formatSize(cachedScanResult.reduce((s, f) => s + (f.size || 0), 0)) + ')，打开筛选器...';
        document.getElementById('gyp-progress-fill').style.width = '100%';

        // 打开筛选器
        showFileFilterModal(cachedScanResult, function(filteredFiles) {
            // 筛选后重新获取
            cachedScanResult = filteredFiles; // 更新缓存为筛选结果
            updateProgress(0, filteredFiles.length, '筛选完成：' + filteredFiles.length + ' 个文件，开始获取: 0/' + filteredFiles.length);
            executeFetchWithFilteredFiles([...filteredFiles]);
        }, function(allFiles) {
            // 跳过筛选，获取全部缓存文件
            updateProgress(0, allFiles.length, '开始获取全部: 0/' + allFiles.length);
            executeFetchWithFilteredFiles([...allFiles]);
        });
    }

    async function startFetch() {
        // 从 map 或 DOM 获取选中的文件和文件夹
        const selectedItems = getSelectedItemsWithFolders();
        let files = selectedItems.files;
        const folders = selectedItems.folders;

        // 检查是否有选中的文件夹，提示用户
        if (folders.length > 0) {
            if (files.length === 0) {
                // 只选了文件夹
                const confirmed = confirm(
                    '已选择了 ' + folders.length + ' 个文件夹：\n' +
                    folders.map(f => '  - ' + f.name).join('\n') +
                    '\n\n是否递归获取这些文件夹中的所有文件直链？\n\n（将自动遍历所有子目录）'
                );
                if (!confirmed) return;
            } else {
                // 同时选了文件和文件夹
                const confirmed = confirm(
                    '已选择了 ' + files.length + ' 个文件 和 ' + folders.length + ' 个文件夹：\n' +
                    folders.map(f => '  - [文件夹] ' + f.name).slice(0, 5).join('\n') +
                    (folders.length > 5 ? '\n  ... 等共 ' + folders.length + ' 个文件夹' : '') +
                    '\n\n是否递归获取所有文件夹中的文件直链？\n\n（文件夹内的文件将和已选文件一起处理）'
                );
                if (!confirmed) {
                    // 用户取消，仅处理已选文件
                    files = selectedItems.files;
                    folders.length = 0;
                }
            }
        }

        if (folders.length > 0) {
            // 显示弹窗，先扫描目录
            showModal();
            updateProgress(0, 1, '正在扫描目录...');

            dirScanAbortController = new AbortController();
            const signal = dirScanAbortController.signal;

            const dirNames = folders.map(f => f.name);
            const dirIds = folders.map(f => f.id);

            const scanResult = await collectAllFilesRecursive(dirIds, dirNames, {
                signal: signal,
                maxDepth: 20,
                onProgress: (info) => {
                    if (info.done) return;
                    const statusText = info.path
                        ? '扫描: ' + info.path + ' (已找到 ' + info.filesFound + ' 个文件, ' + info.processedDirs + ' 个目录已处理)'
                        : '扫描目录中 (已找到 ' + info.filesFound + ' 个文件)...';
                    updateProgress(0, 1, statusText);
                }
            });

            dirScanAbortController = null;

            if (scanResult.aborted) {
                document.getElementById('gyp-progress-text').textContent = '目录扫描已取消';
                document.getElementById('gyp-progress-fill').style.width = '100%';
                showToast('目录扫描已取消', 3000, 'warning');
                return;
            }

            // 合并文件夹中找到的文件和直接选中的文件（去重）
            const existingIds = new Set(files.map(f => f.id));
            let addedFromDirs = 0;
            scanResult.files.forEach(f => {
                if (!existingIds.has(f.id)) {
                    files.push(f);
                    existingIds.add(f.id);
                    addedFromDirs++;
                }
            });

            // 缓存扫描结果，方便后续重新筛选无需重新遍历
            cachedScanResult = files.map(f => ({ ...f }));
            const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

            // 更新进度显示
            document.getElementById('gyp-progress-text').textContent =
                '目录扫描完成：共找到 ' + files.length + ' 个文件' +
                ' (总大小 ' + formatSize(totalSize) + ')' +
                (scanResult.errors.length > 0 ? ', ' + scanResult.errors.length + ' 个目录失败' : '') +
                '，打开文件筛选器...';
            document.getElementById('gyp-progress-fill').style.width = '100%';

            if (scanResult.errors.length > 0) {
                const errorDiv = document.getElementById('gyp-error-info');
                errorDiv.innerHTML = '<strong>目录扫描警告 (' + scanResult.errors.length + '个):</strong><br>' +
                    scanResult.errors.map(function(e) { return e.path + ': ' + e.error; }).join('<br>');
                errorDiv.style.display = 'block';
            }

            if (files.length === 0) {
                showToast('未找到任何可获取直链的文件', 3000, 'warning');
                return;
            }

            // 弹出文件筛选器，支持"跳过筛选"直接获取全部
            showFileFilterModal(files, function(filteredFiles) {
                // 筛选确认：更新缓存并获取直链
                cachedScanResult = filteredFiles; // 更新缓存为筛选后的结果
                updateProgress(0, filteredFiles.length, '筛选完成：' + filteredFiles.length + ' 个文件，开始获取: 0/' + filteredFiles.length);
                executeFetchWithFilteredFiles([...filteredFiles]);
            }, function(allFiles) {
                // 跳过筛选：保留原始缓存，直接获取全部
                updateProgress(0, allFiles.length, '开始获取全部: 0/' + allFiles.length);
                executeFetchWithFilteredFiles([...allFiles]);
            });
            return;
        }

        // 无文件夹时的纯文件模式
        if (files.length === 0) {
            showToast('请先选择要获取直链的文件或文件夹', 2000, 'warning');
            return;
        }

        // 文件数量较多时也弹出筛选器方便用户过滤
        if (files.length >= 20) {
            showModal();
            // 缓存文件列表
            cachedScanResult = files.map(f => ({ ...f }));
            const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
            document.getElementById('gyp-progress-text').textContent =
                '已选择 ' + files.length + ' 个文件 (总大小 ' + formatSize(totalSize) + ')，打开文件筛选器...';
            document.getElementById('gyp-progress-fill').style.width = '100%';

            showFileFilterModal(files, function(filteredFiles) {
                cachedScanResult = filteredFiles;
                updateProgress(0, filteredFiles.length, '筛选完成：' + filteredFiles.length + ' 个文件，开始获取: 0/' + filteredFiles.length);
                executeFetchWithFilteredFiles([...filteredFiles]);
            }, function(allFiles) {
                updateProgress(0, allFiles.length, '开始获取全部: 0/' + allFiles.length);
                executeFetchWithFilteredFiles([...allFiles]);
            });
            return;
        }

        // 少量文件直接获取（无缓存）
        showModal();
        updateProgress(0, files.length, '开始获取: 0/' + files.length);
        executeFetchWithFilteredFiles(files);
    }

    async function executeFetchWithFilteredFiles(files) {
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
            const existingContent = errorDiv.innerHTML || '';
            const newContent = '<strong>失败文件 (' + result.errors.length + '个):</strong><br>' +
                result.errors.map(function(e) { return e.name + ': ' + e.error; }).join('<br>');
            errorDiv.innerHTML = (existingContent ? existingContent + '<br>' : '') + newContent;
            errorDiv.style.display = 'block';
        }

        if (failCount === 0) {
            showToast('全部获取成功！');
        } else {
            showToast('获取完成，' + failCount + ' 个失败', 3000, 'warning');
        }

        // 如果有缓存数据，显示"重新筛选"按钮方便用户调整筛选条件后重新获取
        if (cachedScanResult && cachedScanResult.length > 0) {
            const refilterBtn = document.getElementById('gyp-refilter-btn');
            if (refilterBtn) {
                refilterBtn.classList.remove('gyp-hidden');
                refilterBtn.title = '已缓存 ' + cachedScanResult.length + ' 个文件，点击可重新筛选无需扫描目录';
            }
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
    }

    function addStyles() {
        if (document.getElementById('gyp-styles')) return;

        const style = document.createElement('style');
        style.id = 'gyp-styles';
        style.textContent = [
            '#gyp-modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); z-index: 999999; justify-content: center; align-items: center; overflow: auto; }',
            '.gyp-modal-v2 { background: #fff; border-radius: 8px; width: 900px !important; min-width: 900px !important; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2); overflow: hidden; user-select: text; -webkit-user-select: text; flex-shrink: 0; }',
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
            // 重新筛选按钮 - 缓存复用
            '.gyp-selected-bar #gyp-refilter-btn { background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); border: none; color: #fff; font-size: 13px; font-weight: 600; padding: 7px 16px; box-shadow: 0 2px 8px rgba(49, 151, 149, 0.3); transition: all 0.3s ease; }',
            '.gyp-selected-bar #gyp-refilter-btn:hover { background: linear-gradient(135deg, #4fd1c5 0%, #38b2ac 100%); box-shadow: 0 4px 12px rgba(49, 151, 149, 0.4); transform: translateY(-1px); }',
            '.gyp-btn { display: inline-flex; align-items: center; padding: 8px 20px; font-size: 14px; border-radius: 4px; cursor: pointer; border: 1px solid #d9d9d9; background: #fff; color: #333; transition: all 0.2s ease; }',
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
            '.gyp-toast.gyp-toast-success { background: rgba(34, 197, 94, 0.95); }',
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
            '.gyp-aria2-modal-actions .gyp-btn { flex: 1; padding: 12px 16px; font-size: 14px; }',
            // 文件筛选弹窗样式
            '.gyp-filter-modal { background: #fff; border-radius: 12px; width: 720px; max-width: 95vw; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 8px 40px rgba(0,0,0,0.25); overflow: hidden; user-select: none; }',
            '.gyp-filter-header { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; flex-shrink: 0; }',
            '.gyp-filter-header span { font-size: 17px; font-weight: 600; }',
            '.gyp-filter-close-btn { background: none; border: none; font-size: 26px; cursor: pointer; color: rgba(255,255,255,0.8); padding: 0; line-height: 1; }',
            '.gyp-filter-close-btn:hover { color: #fff; }',
            '.gyp-filter-body { padding: 20px 24px; overflow-y: auto; flex: 1; min-height: 0; }',
            '.gyp-filter-summary { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }',
            '.gyp-filter-summary-item { flex: 1; min-width: 100px; text-align: center; padding: 14px 10px; background: #f8f9fa; border-radius: 10px; border: 2px solid #e9ecef; }',
            '.gyp-filter-summary-item span { display: block; font-size: 12px; color: #868e96; margin-top: 2px; }',
            '.gyp-summary-num { font-size: 20px !important; font-weight: 700 !important; color: #495057 !important; }',
            '.gyp-summary-active { border-color: #667eea; background: linear-gradient(135deg, #f0f4ff 0%, #e8edff 100%); }',
            '.gyp-summary-active .gyp-summary-num { color: #667eea !important; }',
            '.gyp-filter-section { margin-bottom: 20px; }',
            '.gyp-filter-section-title { font-size: 15px; font-weight: 600; color: #333; margin-bottom: 12px; padding-left: 4px; }',
            '.gyp-filter-cat-grid { display: flex; flex-wrap: wrap; gap: 8px; }',
            '.gyp-filter-cat-item { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border: 2px solid #e9ecef; border-radius: 8px; cursor: pointer; transition: all 0.2s; background: #fff; user-select: none; }',
            '.gyp-filter-cat-item:hover { border-color: var(--cat-color, #999); }',
            '.gyp-filter-cat-item:has(input:checked) { border-color: var(--cat-color, #667eea); background: color-mix(in srgb, var(--cat-color, #667eea) 8%, #fff); }',
            '.gyp-filter-cat-check { width: 16px; height: 16px; cursor: pointer; accent-color: var(--cat-color, #667eea); }',
            '.gyp-filter-cat-icon { font-size: 18px; }',
            '.gyp-filter-cat-name { font-size: 13px; font-weight: 500; color: #495057; }',
            '.gyp-filter-cat-count { font-size: 11px; color: #adb5bd; }',
            '.gyp-filter-range-inputs { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }',
            '.gyp-filter-range-group { display: flex; align-items: center; gap: 6px; flex: 1; }',
            '.gyp-filter-range-group > span { font-size: 13px; color: #868e96; white-space: nowrap; }',
            '.gyp-filter-size-input { width: 80px; padding: 6px 8px; border: 2px solid #e9ecef; border-radius: 6px; font-size: 13px; outline: none; text-align: right; background: #fff; color: #333; }',
            '.gyp-filter-size-input:focus { border-color: #667eea; }',
            '.gyp-filter-unit-select { padding: 6px 4px; border: 2px solid #e9ecef; border-radius: 6px; font-size: 13px; outline: none; background: #fff; cursor: pointer; }',
            '.gyp-filter-unit-select:focus { border-color: #667eea; }',
            '.gyp-filter-range-sep { font-size: 16px; color: #adb5bd; font-weight: 600; }',
            '.gyp-filter-slider-wrapper { margin-bottom: 12px; }',
            '.gyp-filter-slider-labels { display: flex; justify-content: space-between; font-size: 12px; color: #868e96; margin-bottom: 8px; }',
            '.gyp-filter-dual-slider { position: relative; height: 24px; }',
            '.gyp-filter-range { position: absolute; top: 0; left: 0; width: 100%; height: 24px; -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none; z-index: 2; }',
            '.gyp-filter-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #667eea; border: 3px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.2); cursor: pointer; pointer-events: all; margin-top: -7px; }',
            '.gyp-filter-range::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: #667eea; border: 3px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.2); cursor: pointer; pointer-events: all; }',
            '.gyp-filter-range-track { position: absolute; top: 8px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, #667eea, #764ba2); z-index: 1; }',
            '.gyp-filter-dual-slider::before { content: ""; position: absolute; top: 8px; left: 0; width: 100%; height: 6px; border-radius: 3px; background: #e9ecef; }',
            '.gyp-filter-quick-sizes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }',
            '.gyp-filter-quick-btn { padding: 5px 12px; border: 1px solid #dee2e6; border-radius: 14px; background: #fff; font-size: 12px; color: #495057; cursor: pointer; transition: all 0.2s; }',
            '.gyp-filter-quick-btn:hover { border-color: #667eea; color: #667eea; background: #f0f4ff; }',
            '.gyp-filter-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 16px 24px; border-top: 1px solid #e9ecef; flex-shrink: 0; }',
            '.gyp-filter-btn-reset { padding: 10px 20px; border: 1px solid #dee2e6; border-radius: 8px; background: #fff; font-size: 14px; color: #495057; cursor: pointer; transition: all 0.2s; }',
            '.gyp-filter-btn-reset:hover { border-color: #adb5bd; }',
            '.gyp-filter-btn-cancel { padding: 10px 20px; border: 1px solid #dee2e6; border-radius: 8px; background: #fff; font-size: 14px; color: #868e96; cursor: pointer; transition: all 0.2s; }',
            '.gyp-filter-btn-cancel:hover { border-color: #adb5bd; }',
            '.gyp-filter-btn-skip { padding: 10px 24px; border: 2px solid #667eea; border-radius: 8px; background: #fff; font-size: 14px; font-weight: 600; color: #667eea; cursor: pointer; transition: all 0.2s; }',
            '.gyp-filter-btn-skip:hover { background: #f0f4ff; border-color: #5a67d8; color: #5a67d8; }',
            '.gyp-filter-btn-confirm { padding: 10px 24px; border: none; border-radius: 8px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); font-size: 14px; font-weight: 600; color: #fff; cursor: pointer; box-shadow: 0 4px 12px rgba(102,126,234,0.35); transition: all 0.3s; }',
            '.gyp-filter-btn-confirm:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(102,126,234,0.45); }'
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
            // 定期清理过期的选中记录（带节流）
            const now = Date.now();
            if (now - lastCleanTime > CLEAN_INTERVAL) {
                lastCleanTime = now;
                cleanExpiredSelections();
            }
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
