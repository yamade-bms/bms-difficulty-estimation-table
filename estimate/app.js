// app.js
import { 
    calculateMD5, 
    calculateSHA256, 
    getSongHeaders, 
    processBMSData, 
    prepareInferenceData, 
    BMSDifficultyMapper 
} from './bms-processor.js';
import { BMSPyAnalyzer } from './pyodide-analyzer.js';

// --- DOM要素の取得 ---
const bmsInput = document.getElementById('bms-input');
const statusLog = document.getElementById('status-log');
const resultTableBody = document.querySelector('#result-table tbody');
const clearBtn = document.getElementById('clear-btn');

// --- インスタンスの初期化 ---
const analyzer = new BMSPyAnalyzer();
const mapper = new BMSDifficultyMapper();
let oofDict = {}; 
let sessions = [];

/**
 * 外れ値を除外した平均計算 (IQR Mean)
 */
function calculateIqrMean(preds, minIqr = 0.02) {
    const n = preds.length;
    if (n === 0) return 0;
    if (n <= 2) return preds.reduce((a, b) => a + b, 0) / n;

    const sorted = [...preds].sort((a, b) => a - b);

    const getPercentile = (data, p) => {
        const pos = (data.length - 1) * p;
        const base = Math.floor(pos);
        const rest = pos - base;
        return data[base + 1] !== undefined 
            ? data[base] + rest * (data[base + 1] - data[base]) 
            : data[base];
    };

    const q1 = getPercentile(sorted, 0.25);
    const q3 = getPercentile(sorted, 0.75);
    let iqr = Math.max(q3 - q1, minIqr);

    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    const inliers = preds.filter(p => p >= lowerBound && p <= upperBound);
    return inliers.length > 0 
        ? inliers.reduce((a, b) => a + b, 0) / inliers.length 
        : sorted[Math.floor(n / 2)];
}

/**
 * セッションの解放
 */
async function disposeAllSessions() {
    for (const session of sessions) {
        try {
            if (session && session.dispose) await session.dispose();
        } catch (e) {
            console.warn("Dispose error:", e);
        }
    }
    sessions = [];
}

/**
 * 初期化セットアップ
 */
async function initApp() {
    try {
        await disposeAllSessions();

        statusLog.textContent = "1/3 データを読み込み中...";
        const response = await fetch('./oof_dict_ensemble.json');
        oofDict = await response.json();

        statusLog.textContent = "2/3 Pythonエンジンを起動中...";
        await analyzer.init(); 

        await new Promise(r => setTimeout(r, 1500));

        statusLog.textContent = "3/3 モデルをロード中 (0/25)...";
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = false; 

        const runCount = 5;
        const foldCount = 5;

        for (let r = 1; r <= runCount; r++) {
            for (let f = 1; f <= foldCount; f++) {
                const session = await ort.InferenceSession.create(`./run${r}_fold${f}_single.onnx`, {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all'
                });
                sessions.push(session);
                statusLog.textContent = `3/3 モデルをロード中 (${sessions.length}/25)...`;
                await new Promise(r => setTimeout(r, 50));
            }
        }

        statusLog.textContent = "準備完了。ファイルを読み込んでください。";
        bmsInput.disabled = false;
    } catch (e) {
        statusLog.textContent = "初期化エラー: " + e.message;
        disposeAllSessions();
    }
}

/**
 * テーブルへの行追加
 */
function addTableRow(info, diff, isCached) {
    const row = resultTableBody.insertRow();
    const levelColor = diff.table.startsWith('st') ? 'text-danger' : 'text-primary';
    const cacheBadge = isCached ? '<span class="badge bg-secondary text-light">参考値</span>' : '';

    const lr2irUrl = `http://www.dream-pro.info/~lavalse/LR2IR/search.cgi?mode=ranking&bmsmd5=${info.md5}`;
    const mochaUrl = `https://mocha-repository.info/song.php?sha256=${info.sha256}`;
    
    row.innerHTML = `
        <td class="text-center">
            <strong class="${levelColor}">${diff.sub_label}</strong> 
            <small class="text-muted">(${diff.display})</small>
        </td>
        <td class="text-truncate" style="max-width: 0;">
            ${info.title} <small class="text-secondary">${info.subtitle || ""}</small> ${cacheBadge}
        </td>
        <td class="text-truncate" style="max-width: 0;">${info.artist} ${info.subartist}</td>
        <td class="text-center">
            <a href="${lr2irUrl}" target="_blank"><i class="bi bi-box-arrow-up-right"></i></a>
        </td>
        <td class="text-center">
            <a href="${mochaUrl}" target="_blank"><i class="bi bi-box-arrow-up-right"></i></a>
        </td>
    `;
}

function addErrorRow(filename, errorMsg) {
    const row = resultTableBody.insertRow();
    row.className = "table-danger";
    row.innerHTML = `<td colspan="5">エラー (${filename}): ${errorMsg}</td>`;
}

// --- イベントリスナー ---

bmsInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    
    bmsInput.disabled = true;

    for (const file of files) {
        try {
            const buffer = await file.arrayBuffer();
            const uint8array = new Uint8Array(buffer);

            const md5 = calculateMD5(uint8array);
            const sha256 = await calculateSHA256(uint8array);

            let rawScore;
            let isCached = false;
            let finalSongInfo = null;

            if (oofDict[md5] && oofDict[md5].label !== 0.0) {
                rawScore = oofDict[md5].pred;
                isCached = true;
                finalSongInfo = await getSongHeaders(uint8array);
            } else {
                statusLog.textContent = `解析中: ${file.name}...`;
                const { timeline_master, song_info } = await processBMSData(uint8array);
                
                finalSongInfo = song_info;
                finalSongInfo.md5 = md5;

                analyzer.loadBMS(timeline_master, finalSongInfo);
                const inputX = await prepareInferenceData(analyzer, finalSongInfo);
                const tnsValue = finalSongInfo.total / finalSongInfo.total_notes;

                const feeds = {
                    x: new ort.Tensor('float32', inputX, [1, 600, 46]),
                    tns: new ort.Tensor('float32', new Float32Array([tnsValue]), [1, 1])
                };

                const allPreds = [];
                for (const session of sessions) {
                    const result = await session.run(feeds);
                    allPreds.push(result[session.outputNames[0]].data[0]);
                }
                rawScore = calculateIqrMean(allPreds);
            }

            finalSongInfo.md5 = md5;
            finalSongInfo.sha256 = sha256;

            const diff = mapper.denormalize(rawScore);
            addTableRow(finalSongInfo, diff, isCached);

        } catch (e) {
            console.error(e);
            addErrorRow(file.name, e.message);
        }
    }
    statusLog.textContent = "処理完了";
    bmsInput.disabled = false;
    bmsInput.value = '';
});

clearBtn.addEventListener('click', () => {
    resultTableBody.innerHTML = '';
});

window.addEventListener('beforeunload', disposeAllSessions);

// 起動
initApp();
