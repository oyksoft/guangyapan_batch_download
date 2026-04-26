// ==UserScript==
// @name         光鸭云盘 - 获取直链
// @namespace    http://tampermonkey.net/
// @author       快乐无极
// @version      1.3
// @description  获取所选文件的直链地址
// @match        https://www.guangyapan.com/*
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/575452/%E5%85%89%E9%B8%AD%E4%BA%91%E7%9B%98%20-%20%E8%8E%B7%E5%8F%96%E7%9B%B4%E9%93%BE.user.js
// @updateURL https://update.greasyfork.org/scripts/575452/%E5%85%89%E9%B8%AD%E4%BA%91%E7%9B%98%20-%20%E8%8E%B7%E5%8F%96%E7%9B%B4%E9%93%BE.meta.js
// ==/UserScript==

(function() {
    'use strict';

    const API_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/get_res_download_url';
    const CONCURRENCY = 3;
    const BATCH_DELAY = 500;
    const FETCH_TIMEOUT = 10000;
    const MAX_RETRIES = 3;
    const RETRY_BASE_DELAY = 500;

    let modalCreated = false;
    let buttonAdded = false;
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
                        isDir: isDir
                    });
                }
            });
            console.log('GYP: dataSource has', marker.filesMap.size, 'items');
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

                if (checkbox.checked) {
                    selectedFilesMap.set(fileId, { name: fileName.trim(), addedAt: Date.now() });
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
                                selectedFilesMap.set(fileId, { name: name.trim(), addedAt: Date.now() });
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
            name: data.name
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

    function findCloudAddButton() {
        // 尝试多种选择器提高稳定性
        const selectors = [
            'button[class*="addcloud"]',
            'button:has(.swangpan-icon-addcloud)',
            'button'
        ];

        for (const selector of selectors) {
            if (selector === 'button') {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('云添加') && btn.querySelector('.swangpan-icon-addcloud')) {
                        return btn;
                    }
                }
            } else {
                const btn = document.querySelector(selector);
                if (btn) return btn;
            }
        }
        return null;
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

    function createModal() {
        if (modalCreated) return;

        const modal = document.createElement('div');
        modal.id = 'gyp-modal-overlay';
        modal.innerHTML = '<div class="gyp-modal gyp-modal-v2">' +
            '<div class="gyp-modal-header">' +
            '<span class="gyp-modal-title">获取直链</span>' +
            '<button class="gyp-modal-close" id="gyp-modal-close">&times;</button>' +
            '</div>' +
            '<div class="gyp-modal-body">' +
            '<div class="gyp-progress-info"><span id="gyp-progress-text">准备就绪</span></div>' +
            '<div class="gyp-progress-bar"><div class="gyp-progress-fill" id="gyp-progress-fill"></div></div>' +
            '<div class="gyp-result-table" id="gyp-result-table">' +
            '<table class="gyp-table-head"><thead><tr><td class="gyp-col-select"><input type="checkbox" id="gyp-select-all" class="gyp-select-all"></td><td class="gyp-col-name">文件名</td><td class="gyp-col-url">直链地址</td><td class="gyp-col-action">操作</td></tr></thead></table>' +
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
            '<button class="gyp-btn" id="gyp-copy-all">一键复制全部链接</button>' +
            '<button class="gyp-btn" id="gyp-modal-close-btn">关闭</button>' +
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
        countSpan.textContent = '已选择 ' + count + ' 项';
        if (count > 0) {
            copyNameBtn.classList.remove('gyp-hidden');
            copyUrlBtn.classList.remove('gyp-hidden');
        } else {
            copyNameBtn.classList.add('gyp-hidden');
            copyUrlBtn.classList.add('gyp-hidden');
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
        document.getElementById('gyp-progress-fill').style.width = percent + '%';
    }

    function addResultRow(fileName, url, error) {
        const tbody = document.getElementById('gyp-result-tbody');
        const tr = document.createElement('tr');
        if (error) tr.className = 'gyp-row-error';

        const selectTd = document.createElement('td');
        selectTd.className = 'gyp-col-select';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'gyp-row-checkbox';
        checkbox.setAttribute('data-url', url || '');
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
            copyUrlBtn.textContent = '复制直链URL';
            copyUrlBtn.style.marginLeft = '6px';
            copyUrlBtn.onclick = function() {
                copyToClipboard(url);
            };
            actionTd.appendChild(copyUrlBtn);
        }

        tr.appendChild(selectTd);
        tr.appendChild(nameTd);
        tr.appendChild(urlTd);
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

    async function getDownloadUrl(fileId, signal) {
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
                    return data.data.signedURL;
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

                // 优先从 filesMap 获取文件名和类型（React 的 dataSource）
                if (marker.filesMap && marker.filesMap.has(idStr)) {
                    const fileData = marker.filesMap.get(idStr);
                    name = fileData.fileName;
                    isDir = fileData.isDir;
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

                files.push({ id: idStr, name });
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
        const results = [];
        let completed = 0;
        const errors = [];
        let aborted = false;

        abortController = new AbortController();
        const signal = abortController.signal;

        async function processFile(file) {
            if (signal.aborted) {
                return { file: file, url: null, error: '已取消' };
            }
            try {
                const url = await getDownloadUrl(file.id, signal);
                return { file: file, url: url, error: null };
            } catch (err) {
                if (err.name === 'AbortError' || err.message === '请求已取消') {
                    return { file: file, url: null, error: '已取消' };
                }
                return { file: file, url: null, error: err.message };
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
                    addResultRow(result.file.name, result.url, result.error);
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

    async function scrollToRenderAllSelected() {
        // 虚拟滚动情况下，需要滚动让所有选中的文件都渲染出来
        const checkedBefore = document.querySelectorAll('.ant-checkbox-checked').length;
        if (checkedBefore === 0) return;

        console.log('GYP: Starting scroll to render all selected files, initial count:', checkedBefore);

        // 优先尝试 ant-table-tbody（用户反馈这是滚动容器）
        let scrollContainer = document.querySelector('.ant-table-tbody');
        if (!scrollContainer) {
            scrollContainer = document.querySelector('.ant-table-body');
        }
        if (!scrollContainer) {
            scrollContainer = document.querySelector('[class*="virtual-list"], [class*="scroll-content"]');
        }

        if (!scrollContainer) {
            console.log('GYP: No scroll container found, using window');
            let lastCount = 0;
            for (let i = 0; i < 20; i++) {
                window.scrollBy(0, 500);
                await sleep(200);
                const currentCount = document.querySelectorAll('.ant-checkbox-checked').length;
                if (currentCount === lastCount) break;
                lastCount = currentCount;
            }
            window.scrollTo(0, 0);
        } else {
            console.log('GYP: Found scroll container:', scrollContainer.className || scrollContainer.tagName);
            const scrollHeight = scrollContainer.scrollHeight || scrollContainer.scrollHeight;
            let lastCount = 0;
            for (let i = 0; i < 20; i++) {
                // 逐步滚动，每次增加一定距离
                const step = Math.max(100, scrollHeight / 10);
                scrollContainer.scrollTop = scrollContainer.scrollTop + step;
                await sleep(300);
                const currentCount = document.querySelectorAll('.ant-checkbox-checked').length;
                console.log('GYP: Scroll', i, 'scrollTop:', scrollContainer.scrollTop, 'checked:', currentCount);
                if (currentCount === lastCount && i > 2) break;
                lastCount = currentCount;
            }
            scrollContainer.scrollTop = 0;
        }

        const checkedAfter = document.querySelectorAll('.ant-checkbox-checked').length;
        console.log('GYP: After scroll - checked count:', checkedAfter, '(was:', checkedBefore, ')');
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
        buttonAdded = true;
        console.log('GYP: Button added successfully');
    }

    function addStyles() {
        if (document.getElementById('gyp-styles')) return;

        const style = document.createElement('style');
        style.id = 'gyp-styles';
        style.textContent = [
            '#gyp-modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); z-index: 999999; justify-content: center; align-items: center; }',
            '.gyp-modal-v2 { background: #fff; border-radius: 8px; width: 900px; max-width: 95%; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2); overflow: hidden; }',
            '.gyp-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e8e8e8; flex-shrink: 0; }',
            '.gyp-modal-title { font-size: 16px; font-weight: 500; color: #333; }',
            '.gyp-modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: #999; padding: 0; line-height: 1; }',
            '.gyp-modal-close:hover { color: #666; }',
            '.gyp-modal-body { padding: 20px; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }',
            '.gyp-progress-info { margin-bottom: 8px; font-size: 14px; color: #666; flex-shrink: 0; }',
            '.gyp-progress-bar { height: 8px; background-color: #f0f0f0; border-radius: 4px; overflow: hidden; margin-bottom: 16px; flex-shrink: 0; }',
            '.gyp-progress-fill { height: 100%; background: linear-gradient(90deg, #1890ff 0%, #40a9ff 100%); transition: width 0.3s ease; width: 0%; }',
            '.gyp-result-table { border: 1px solid #e8e8e8; border-radius: 4px; display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }',
            '.gyp-table-head { width: 100%; border-collapse: separate; border-spacing: 0; flex-shrink: 0; table-layout: fixed; }',
            '.gyp-table-head td { background: linear-gradient(180deg, #e0e7ff 0%, #c7d2fe 100%); padding: 8px 12px; text-align: center; font-weight: 600; font-size: 13px; color: #4338ca; border-bottom: none; box-shadow: inset 0 2px 4px rgba(255,255,255,0.6), inset 0 -1px 2px rgba(99, 102, 241, 0.05), 0 2px 6px rgba(99, 102, 241, 0.15); text-shadow: 0 1px 2px rgba(255,255,255,0.8); letter-spacing: 1px; }',
            '.gyp-col-select { width: 50px; text-align: center; }',
            '.gyp-col-name { width: 35%; text-align: center; max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.gyp-col-url { width: 35%; text-align: center; max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.gyp-col-action { width: 30%; text-align: center; }',
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
            '.gyp-row-checkbox { width: 18px; height: 18px; cursor: pointer; accent-color: #1890ff; }',
            '.gyp-select-all { width: 18px; height: 18px; cursor: pointer; accent-color: #1890ff; }',
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
            // 一键复制全部链接 - 阳光黄渐变，更大更突出
            '.gyp-selected-bar #gyp-copy-all { background: linear-gradient(135deg, #f5af19 0%, #f12711 100%); border: none; color: #fff; font-size: 15px; font-weight: bold; padding: 10px 24px; box-shadow: 0 4px 12px rgba(245, 39, 17, 0.4); transition: all 0.3s ease; }',
            '.gyp-selected-bar #gyp-copy-all:hover { background: linear-gradient(135deg, #f7c41f 0%, #f23921 100%); box-shadow: 0 6px 16px rgba(245, 39, 17, 0.5); transform: translateY(-2px); }',
            // 关闭按钮 - 沉稳灰蓝渐变，更大更突出
            '.gyp-selected-bar #gyp-modal-close-btn { background: linear-gradient(135deg, #4b6cb7 0%, #182848 100%); border: none; color: #fff; font-size: 15px; font-weight: bold; padding: 10px 24px; box-shadow: 0 4px 12px rgba(24, 40, 72, 0.4); transition: all 0.3s ease; }',
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
            '.gyp-toast.gyp-toast-error { background: rgba(255, 77, 79, 0.95); }'
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
