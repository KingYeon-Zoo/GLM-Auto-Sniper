// ==UserScript==
// @name         GLM自动抢购
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  自动重试 preview + check 双重校验 + 错误弹窗自动恢复
// @author       Assistant
// @match        *://*.bigmodel.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ======================== 应用配置 (Configuration) ========================
    const appConfig = {
        retryDelayMs: 100,
        maxRetryAttempts: 300,
        endpoints: {
            preview: '/api/biz/pay/preview',
            check: '/api/biz/pay/check',
        }
    };

    // ======================== 全局状态 (Global State) ========================
    const appState = {
        currentStatus: 'idle', // 'idle' | 'retrying' | 'success' | 'failed'
        retryCount: 0,
        successfulBizId: null,
        capturedRequest: null,
        cachedResponse: null,
        lastSuccessResponse: null, // 用于错误弹窗后自动恢复
        systemLogs: [],
    };

    // 控制标志
    let isStopRequested = false;
    let isRecoveringFromError = false;
    let autoRecoveryAttempts = 0;
    let activeRetryPromise = null;

    // ======================== 工具函数 (Utilities) ========================
    const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
    const getCurrentTimeFormatted = () => {
        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds()).substring(0, 3)}`;
    };

    function printLog(message) {
        const timeStamp = getCurrentTimeFormatted();
        const logEntry = `[${timeStamp}] ${message}`;
        appState.systemLogs.push(logEntry);
        if (appState.systemLogs.length > 100) {
            appState.systemLogs.shift();
        }
        console.log(`[GLM自动抢购] ${message}`);
        updateLogsUI();
    }

    function parseHeadersToRecord(headersData) {
        const headerRecord = {};
        if (!headersData) return headerRecord;
        if (headersData instanceof Headers) {
            headersData.forEach((value, key) => (headerRecord[key] = value));
        } else if (Array.isArray(headersData)) {
            headersData.forEach(([key, value]) => (headerRecord[key] = value));
        } else {
            Object.entries(headersData).forEach(([key, value]) => (headerRecord[key] = value));
        }
        return headerRecord;
    }

    // ======================== (一) 数据劫持补丁 (JSON.parse Patch) ========================
    const originalJsonParse = JSON.parse;
    JSON.parse = function (text, reviver) {
        let parsedData = originalJsonParse(text, reviver);
        try {
            (function fixProductAvailability(obj) {
                if (!obj || typeof obj !== 'object') return;

                // 修复常见库存或无货标志
                if (obj.isSoldOut === true) obj.isSoldOut = false;
                if (obj.soldOut === true) obj.soldOut = false;
                if (obj.disabled === true && (obj.price !== undefined || obj.productId || obj.title)) {
                    obj.disabled = false;
                }
                if (obj.stock === 0) obj.stock = 999;

                for (let key in obj) {
                    if (obj[key] && typeof obj[key] === 'object') {
                        fixProductAvailability(obj[key]);
                    }
                }
            })(parsedData);
        } catch (error) {
            // 解析劫持异常，静默处理
        }
        return parsedData;
    };

    // ======================== (二) 核心接口重试引擎 (Network Retry Engine) ========================
    const originalFetch = window.fetch;

    async function executeRetryStrategy(targetUrl, requestOptions) {
        if (activeRetryPromise) {
            printLog('⏳ 检测到并发请求，并入当前重试队列...');
            return activeRetryPromise;
        }

        isStopRequested = false;

        activeRetryPromise = (async () => {
            updateAppStatus('retrying');
            appState.retryCount = 0;
            updateStatusUI();

            // 剥离 AbortSignal，避免前端超时逻辑打断重试
            const { signal, ...cleanRequestOptions } = requestOptions || {};

            for (let currentAttempt = 1; currentAttempt <= appConfig.maxRetryAttempts; currentAttempt++) {
                if (isStopRequested) {
                    printLog('⏹ 重试已由用户手动停止');
                    break;
                }

                appState.retryCount = currentAttempt;
                updateStatusUI();

                try {
                    const response = await originalFetch(targetUrl, { ...cleanRequestOptions, credentials: 'include' });
                    const responseText = await response.text();

                    let responseData;
                    try { responseData = originalJsonParse(responseText); } catch { responseData = null; }

                    if (responseData && responseData.code === 200 && responseData.data && responseData.data.bizId) {
                        const obtainedBizId = responseData.data.bizId;
                        printLog(`🔑 成功获取 bizId=[${obtainedBizId}]，开始执行双重校验...`);

                        // 关键步骤：调用 check 接口验证 bizId 的有效性
                        try {
                            const checkEndpointUrl = `${location.origin}${appConfig.endpoints.check}?bizId=${obtainedBizId}`;
                            const checkResponse = await originalFetch(checkEndpointUrl, { credentials: 'include' });
                            const checkText = await checkResponse.text();

                            let checkData;
                            try { checkData = originalJsonParse(checkText); } catch { checkData = null; }

                            if (checkData && checkData.data === 'EXPIRE') {
                                printLog(`⚠️ 尝试 #${currentAttempt} - bizId已过期 (EXPIRE)，继续尝试...`);
                                await wait(appConfig.retryDelayMs);
                                continue;
                            }

                            // 校验通过，确认为真正成功
                            updateAppStatus('success');
                            appState.successfulBizId = obtainedBizId;
                            appState.lastSuccessResponse = { text: responseText, data: responseData };
                            printLog(`✅ 抢购彻底成功! bizId=[${obtainedBizId}] (于第 ${currentAttempt} 次尝试)`);
                            updateStatusUI();

                            autoRecoveryAttempts = 0;
                            setTimeout(initiateAutoRecovery, 600);

                            return { isSuccess: true, text: responseText, data: responseData, status: response.status };
                        } catch (checkError) {
                            printLog(`⚠️ 尝试 #${currentAttempt} - check 校验产生异常: ${checkError.message}，继续尝试...`);
                            await wait(appConfig.retryDelayMs);
                            continue;
                        }
                    }

                    // 记录失败原因
                    const failureReason = !responseData ? '响应格式非JSON'
                        : responseData.code === 555 ? '系统繁忙限制(555)'
                            : (responseData.data && responseData.data.bizId === null) ? '商品已售罄(bizId=null)'
                                : `未知状态码(code=${responseData.code})`;

                    if (currentAttempt <= 5 || currentAttempt % 20 === 0) {
                        printLog(`📊 尝试 #${currentAttempt} 结果: ${failureReason}`);
                    }
                } catch (networkError) {
                    if (currentAttempt <= 3 || currentAttempt % 20 === 0) {
                        printLog(`🌐 尝试 #${currentAttempt} 网络连接错误: ${networkError.message}`);
                    }
                }

                await wait(appConfig.retryDelayMs);
            }

            if (!isStopRequested) {
                updateAppStatus('failed');
                printLog(`❌ 已达到设定的最大重试阈值 (${appConfig.maxRetryAttempts} 次)`);
            } else {
                updateAppStatus('idle');
            }

            updateStatusUI();
            return { isSuccess: false };
        })();

        try {
            return await activeRetryPromise;
        } finally {
            activeRetryPromise = null;
        }
    }

    // ======================== (三) 页面错误弹窗自动恢复 (Auto-Recovery) ========================

    function locateErrorDialog() {
        const dialogSelectors = [
            '.el-dialog', '.el-message-box', '.el-dialog__wrapper',
            '.ant-modal', '.ant-modal-wrap',
            '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]',
            '[role="dialog"]',
        ];

        for (const selector of dialogSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                const computedStyle = window.getComputedStyle(element);
                if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden' || computedStyle.opacity === '0') continue;
                if (!element.offsetParent && computedStyle.position !== 'fixed') continue;

                const dialogText = element.textContent || '';
                if (/购买人数过多|系统繁忙|稍后再试|请重试|繁忙|失败|出错|异常/.test(dialogText)) {
                    return element;
                }
            }
        }
        return null;
    }

    function locateBuyButton() {
        const potentialButtons = document.querySelectorAll('button, a, [role="button"], div[class*="btn"], span[class*="btn"]');
        for (const button of potentialButtons) {
            const buttonText = button.textContent.trim();
            if (/购买|抢购|立即|下单|订阅/.test(buttonText) && buttonText.length < 20 && button.offsetParent !== null) {
                return button;
            }
        }
        return null;
    }

    function closeErrorDialog(dialogElement) {
        const closeIconSelectors = [
            '.el-dialog__headerbtn', '.el-message-box__headerbtn',
            '.el-dialog__close', '.ant-modal-close',
            '[class*="close-btn"]', '[class*="closeBtn"]',
            '[aria-label="Close"]', '[aria-label="close"]',
        ];

        for (const selector of closeIconSelectors) {
            const closeBtn = dialogElement.querySelector(selector) || document.querySelector(selector);
            if (closeBtn && closeBtn.offsetParent !== null) {
                closeBtn.click();
                printLog('🔄 自动操作：点击弹窗关闭按钮');
                return true;
            }
        }

        const actionButtons = dialogElement.querySelectorAll('button, [role="button"]');
        for (const actionBtn of actionButtons) {
            const buttonText = (actionBtn.textContent || '').trim();
            if (/关闭|确定|取消|知道了|OK|Cancel|Close|确认/.test(buttonText) && buttonText.length < 10) {
                actionBtn.click();
                printLog(`🔄 自动操作：点击 [${buttonText}] 按钮`);
                return true;
            }
        }

        // Broadcast Esc Key as fallback
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
        printLog('🔄 自动操作：触发 Escape 键');

        const overlayMasks = document.querySelectorAll('.el-overlay, .v-modal, .el-overlay-dialog, [class*="overlay"], [class*="mask"]');
        for (const mask of overlayMasks) {
            if (mask.offsetParent !== null || window.getComputedStyle(mask).position === 'fixed') {
                mask.click();
                printLog('🔄 自动操作：点击背景遮罩层');
                return true;
            }
        }

        dialogElement.style.display = 'none';
        overlayMasks.forEach(mask => (mask.style.display = 'none'));
        printLog('🔄 自动操作：强制隐藏错误弹窗');
        return true;
    }

    async function initiateAutoRecovery() {
        if (isRecoveringFromError || autoRecoveryAttempts >= 3) return;
        if (!appState.lastSuccessResponse) return;

        const errorDialog = locateErrorDialog();
        if (!errorDialog) return;

        isRecoveringFromError = true;
        autoRecoveryAttempts++;

        try {
            printLog('🔄 侦测到前端错误弹窗，正在启动自动化恢复序列...');
            appState.cachedResponse = appState.lastSuccessResponse;

            closeErrorDialog(errorDialog);
            await wait(500);

            const remainingDialog = locateErrorDialog();
            if (remainingDialog) {
                closeErrorDialog(remainingDialog);
                await wait(300);
            }

            const activeBuyButton = locateBuyButton();
            if (activeBuyButton) {
                activeBuyButton.click();
                printLog('🖱 自动化恢复：已重新触发购买按钮动作');
            } else {
                printLog('⚠️ 自动化恢复：未能定位页面上的购买按钮');
                alert('系统已获取有效商品订单！请立即手动点击页面的购买按钮！');
            }
        } finally {
            isRecoveringFromError = false;
        }
    }

    function initializeDialogWatcher() {
        setInterval(() => {
            if (appState.lastSuccessResponse && !isRecoveringFromError && autoRecoveryAttempts < 3) {
                if (locateErrorDialog()) {
                    initiateAutoRecovery();
                }
            }
        }, 500);
    }

    // ======================== (四) Fetch 请求拦截防线 (Fetch Interceptor) ========================
    window.fetch = async function (requestInput, requestInit) {
        const targetUrl = typeof requestInput === 'string' ? requestInput : requestInput?.url;

        if (targetUrl && targetUrl.includes(appConfig.endpoints.preview)) {
            appState.capturedRequest = {
                url: targetUrl,
                method: requestInit?.method || 'POST',
                body: requestInit?.body,
                headers: parseHeadersToRecord(requestInit?.headers),
            };
            printLog('🎯 防线触发：已捕获 preview 请求 (Fetch API)');
            updateStatusUI();

            if (appState.cachedResponse) {
                printLog('📦 拦截响应：直接注入缓存的成功数据');
                const cachedData = appState.cachedResponse;
                appState.cachedResponse = null;
                autoRecoveryAttempts = 0;
                return new Response(cachedData.text, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            const executionResult = await executeRetryStrategy(targetUrl, {
                method: requestInit?.method || 'POST',
                body: requestInit?.body,
                headers: parseHeadersToRecord(requestInit?.headers),
                signal: requestInit?.signal,
            });

            if (executionResult.isSuccess) {
                return new Response(executionResult.text, {
                    status: executionResult.status,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return originalFetch.apply(this, [requestInput, requestInit]);
        }

        if (targetUrl && targetUrl.includes(appConfig.endpoints.check) && targetUrl.includes('bizId=null')) {
            printLog('🚫 安全拦截：阻断无效的 check 请求 (bizId=null)');
            return new Response(JSON.stringify({ code: -1, msg: '等待有效bizId' }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }

        return originalFetch.apply(this, [requestInput, requestInit]);
    };

    // ======================== (五) XHR 请求拦截防线 (XHR Interceptor) ========================
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    const originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function (headerKey, headerValue) {
        (this._interceptedHeaders || (this._interceptedHeaders = {}))[headerKey] = headerValue;
        return originalXhrSetHeader.call(this, headerKey, headerValue);
    };

    XMLHttpRequest.prototype.open = function (methodType, requestUrl) {
        this._interceptedMethod = methodType;
        this._interceptedUrl = requestUrl;
        return originalXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (requestBody) {
        const targetUrl = this._interceptedUrl;

        if (typeof targetUrl === 'string' && targetUrl.includes(appConfig.endpoints.preview)) {
            const xhrContext = this;
            appState.capturedRequest = {
                url: targetUrl,
                method: this._interceptedMethod,
                body: requestBody,
                headers: this._interceptedHeaders || {}
            };
            printLog('🎯 防线触发：已捕获 preview 请求 (XHR API)');
            updateStatusUI();

            if (appState.cachedResponse) {
                printLog('📦 拦截响应：直接注入缓存的成功数据 (XHR API)');
                const cachedData = appState.cachedResponse;
                appState.cachedResponse = null;
                autoRecoveryAttempts = 0;
                simulateXhrResponse(xhrContext, cachedData.text);
                return;
            }

            executeRetryStrategy(targetUrl, {
                method: this._interceptedMethod,
                body: requestBody,
                headers: this._interceptedHeaders || {}
            }).then(executionResult => {
                simulateXhrResponse(xhrContext, executionResult.isSuccess ? executionResult.text : '{"code":-1,"msg":"重试失败"}');
            });
            return;
        }

        if (typeof targetUrl === 'string' && targetUrl.includes(appConfig.endpoints.check) && targetUrl.includes('bizId=null')) {
            printLog('🚫 安全拦截：阻断无效的 check 请求 (bizId=null) (XHR API)');
            simulateXhrResponse(this, '{"code":-1,"msg":"等待有效bizId"}');
            return;
        }

        return originalXhrSend.call(this, requestBody);
    };

    function simulateXhrResponse(xhrInstance, responseText) {
        setTimeout(() => {
            const defineProp = (key, value) => Object.defineProperty(xhrInstance, key, { value: value, configurable: true });
            defineProp('readyState', 4);
            defineProp('status', 200);
            defineProp('statusText', 'OK');
            defineProp('responseText', responseText);
            defineProp('response', responseText);

            const readyStateChangeEvent = new Event('readystatechange');
            if (typeof xhrInstance.onreadystatechange === 'function') xhrInstance.onreadystatechange(readyStateChangeEvent);
            xhrInstance.dispatchEvent(readyStateChangeEvent);

            const loadEvent = new ProgressEvent('load');
            if (typeof xhrInstance.onload === 'function') xhrInstance.onload(loadEvent);
            xhrInstance.dispatchEvent(loadEvent);
            xhrInstance.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
    }

    // ======================== (六) 核心交互逻辑 (Core Actions) ========================

    function requestStopOperation() {
        isStopRequested = true;
        updateAppStatus('idle');
        appState.retryCount = 0;
        printLog('⏹ 已收到操作中止指令');
        updateStatusUI();
    }

    function updateAppStatus(newStatus) {
        appState.currentStatus = newStatus;
    }

    // ======================== (七) 设计风格突出的图形化 UI (Graphic UI Implementation) ========================
    function initializeControlPanel() {
        const panelContainer = document.createElement('div');
        panelContainer.id = 'glm-tactical-hud';

        panelContainer.innerHTML = `
<style>
#glm-tactical-hud {
    position: fixed;
    top: 20px;
    right: 20px;
    width: 360px;
    background: rgba(9, 9, 11, 0.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(6, 182, 212, 0.3);
    border-radius: 4px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
    z-index: 2147483647;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    color: #e4e4e7;
    user-select: none;
    overflow: hidden;
}

#glm-tactical-hud::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6);
}

#glm-tactical-hud * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

.hud-header {
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.4);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: move;
}

.hud-title {
    font-size: 13px;
    font-weight: 800;
    color: #fff;
    letter-spacing: 1px;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 8px;
}

.hud-title::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    background: #06b6d4;
    border-radius: 50%;
    box-shadow: 0 0 8px #06b6d4;
}

.hud-minimize {
    width: 24px;
    height: 24px;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #fff;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    transition: all 0.2s;
}

.hud-minimize:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: #fff;
}

.hud-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.status-badge {
    padding: 10px;
    border-radius: 2px;
    text-align: center;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    transition: all 0.3s ease;
    border: 1px solid transparent;
}

.status-idle {
    background: rgba(82, 82, 91, 0.2);
    border-color: rgba(82, 82, 91, 0.5);
    color: #a1a1aa;
}

.status-retrying {
    background: rgba(234, 179, 8, 0.1);
    border-color: rgba(234, 179, 8, 0.6);
    color: #fde047;
    box-shadow: 0 0 16px rgba(234, 179, 8, 0.15) inset;
    animation: neon-pulse-yellow 1.5s infinite alternate;
}

.status-success {
    background: rgba(16, 185, 129, 0.15);
    border-color: rgba(16, 185, 129, 0.6);
    color: #6ee7b7;
    box-shadow: 0 0 16px rgba(16, 185, 129, 0.2) inset;
}

.status-failed {
    background: rgba(239, 68, 68, 0.15);
    border-color: rgba(239, 68, 68, 0.6);
    color: #fca5a5;
}

@keyframes neon-pulse-yellow {
    0% { opacity: 0.8; box-shadow: 0 0 10px rgba(234, 179, 8, 0.1) inset; }
    100% { opacity: 1; box-shadow: 0 0 20px rgba(234, 179, 8, 0.4) inset, 0 0 10px rgba(234, 179, 8, 0.2); }
}

.data-row {
    font-size: 11px;
    color: #d4d4d8;
    background: rgba(0, 0, 0, 0.3);
    padding: 8px 10px;
    border-radius: 2px;
    border-left: 2px solid #3b82f6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.controls-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
}

.control-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.control-group label {
    font-size: 10px;
    color: #a1a1aa;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.control-input {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #06b6d4;
    padding: 8px;
    font-family: inherit;
    font-size: 13px;
    border-radius: 2px;
    outline: none;
    transition: all 0.2s;
    font-weight: 700;
}

.control-input:focus {
    border-color: #06b6d4;
    box-shadow: 0 0 0 1px #06b6d4;
}

.action-btn {
    width: 100%;
    padding: 12px;
    border: none;
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.4);
    font-family: inherit;
    font-weight: 800;
    font-size: 12px;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 2px;
    transition: all 0.2s;
    outline: none;
}

.action-btn:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: #ef4444;
    color: #fca5a5;
    box-shadow: 0 0 15px rgba(239, 68, 68, 0.3);
}

.action-btn:active {
    transform: scale(0.98);
}

.log-terminal {
    height: 140px;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    padding: 8px;
    font-size: 10px;
    line-height: 1.6;
    color: #34d399;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
}

.log-terminal::-webkit-scrollbar {
    width: 4px;
}

.log-terminal::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 2px;
}

.log-line {
    word-break: break-all;
    opacity: 0.9;
}
.log-line:last-child {
    opacity: 1;
    text-shadow: 0 0 5px rgba(52, 211, 153, 0.5);
}
</style>
<div class="hud-header" id="hud-drag-handle">
    <div class="hud-title">GLM自动抢购</div>
    <button class="hud-minimize" id="hud-toggle-btn">−</button>
</div>
<div class="hud-body" id="hud-content">
    <div class="status-badge status-idle" id="hud-status">SYSTEM STANDBY / 等待指令</div>
    
    <div class="data-row" id="hud-target-info">
        TARGET // 等待点击页面购买按钮以捕获拦截
    </div>
    
    <div class="controls-grid">
        <div class="control-group">
            <label>重试间隔 (ms)</label>
            <input type="number" class="control-input" id="cfg-delay" value="${appConfig.retryDelayMs}" min="50" max="5000" step="10">
        </div>
        <div class="control-group">
            <label>重试上限 (次)</label>
            <input type="number" class="control-input" id="cfg-max" value="${appConfig.maxRetryAttempts}" min="10" max="9999" step="10">
        </div>
    </div>
    
    <div id="action-wrapper" style="display: none;">
        <button class="action-btn" id="btn-abort">ABORT // 强行中止</button>
    </div>
    
    <div class="log-terminal" id="hud-console"></div>
</div>`;
        document.body.appendChild(panelContainer);

        // Events binding
        const getEl = id => document.getElementById(id);

        getEl('btn-abort').onclick = requestStopOperation;

        getEl('cfg-delay').onchange = function () {
            appConfig.retryDelayMs = Math.max(50, parseInt(this.value) || 100);
            printLog(`⚙️ 配置更新: 重试间隔调整为 ${appConfig.retryDelayMs}ms`);
        };

        getEl('cfg-max').onchange = function () {
            appConfig.maxRetryAttempts = Math.max(10, parseInt(this.value) || 300);
            printLog(`⚙️ 配置更新: 最大重试次数调整为 ${appConfig.maxRetryAttempts}次`);
        };

        getEl('hud-toggle-btn').onclick = function () {
            const contentBody = getEl('hud-content');
            const isHidden = contentBody.style.display === 'none';
            contentBody.style.display = isHidden ? '' : 'none';
            this.textContent = isHidden ? '−' : '+';
        };

        // Window Dragging Logic
        let startX, startY, startLeft, startTop;
        getEl('hud-drag-handle').onmousedown = function (e) {
            if (e.target.id === 'hud-toggle-btn') return;
            startX = e.clientX;
            startY = e.clientY;
            const containerRect = panelContainer.getBoundingClientRect();
            startLeft = containerRect.left;
            startTop = containerRect.top;

            const handleMouseMove = function (ev) {
                panelContainer.style.left = (startLeft + ev.clientX - startX) + 'px';
                panelContainer.style.top = (startTop + ev.clientY - startY) + 'px';
                panelContainer.style.right = 'auto'; // Disable default right offset
            };

            const handleMouseUp = function () {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        };

        printLog('SYSTEM ONLINE // 核心引擎与防线拦截器初始化完毕');
        initializeDialogWatcher();
    }

    function updateStatusUI() {
        const statusElement = document.getElementById('hud-status');
        if (!statusElement) return;

        let uiClass = 'status-badge status-';
        let uiText = '';

        if (appState.currentStatus === 'idle') {
            uiClass += 'idle';
            uiText = 'SYSTEM STANDBY / 等待触发';
        } else if (appState.currentStatus === 'retrying') {
            uiClass += 'retrying';
            uiText = `EXECUTING / 执行抢购 ${appState.retryCount}/${appConfig.maxRetryAttempts}`;
        } else if (appState.currentStatus === 'success') {
            uiClass += 'success';
            uiText = `SUCCESS / 获取成功 [${appState.successfulBizId.substring(0, 8)}...]`;
        } else if (appState.currentStatus === 'failed') {
            uiClass += 'failed';
            uiText = `FAILED / 抢购失败 (尝试 ${appState.retryCount} 次)`;
        }

        statusElement.className = uiClass;
        statusElement.textContent = uiText;

        const targetInfoElement = document.getElementById('hud-target-info');
        if (targetInfoElement) {
            targetInfoElement.textContent = appState.capturedRequest
                ? `TARGET // ${appState.capturedRequest.method} ${appState.capturedRequest.url.split('?')[0].slice(-25)}`
                : 'TARGET // 等待点击页面购买按钮以捕获拦截';
        }

        const actionWrapper = document.getElementById('action-wrapper');
        if (actionWrapper) {
            actionWrapper.style.display = appState.currentStatus === 'retrying' ? 'block' : 'none';
        }
    }

    function updateLogsUI() {
        const consoleElement = document.getElementById('hud-console');
        if (!consoleElement) return;

        const latestLog = appState.systemLogs[appState.systemLogs.length - 1];
        if (latestLog) {
            const line = document.createElement('div');
            line.className = 'log-line';
            line.textContent = latestLog;
            consoleElement.appendChild(line);

            while (consoleElement.children.length > 50) {
                consoleElement.removeChild(consoleElement.firstChild);
            }
            consoleElement.scrollTop = consoleElement.scrollHeight;
        }
    }

    // ======================== (八) 注入引导 (Initialization) ========================
    console.log('[GLM自动抢购] 🚀 核心逻辑加载完成');

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeControlPanel);
    } else {
        initializeControlPanel();
    }
})();
