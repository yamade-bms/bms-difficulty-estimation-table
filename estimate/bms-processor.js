// bms-processor.js
import * as bms from 'https://esm.sh/bms';

export function calculateMD5(uint8array) {
    const n = uint8array.length;
    const words = new Uint32Array(((n + 11) >> 6) + 1 << 4);
    new Uint8Array(words.buffer).set(uint8array);
    words[n >> 2] |= 0x80 << ((n % 4) << 3);
    words[words.length - 2] = n << 3;

    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    const s = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const k = new Uint32Array(64);
    for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

    const rol = (v, s) => (v << s) | (v >>> (32 - s));

    for (let i = 0; i < words.length; i += 16) {
        let aa = a, bb = b, cc = c, dd = d;
        for (let j = 0; j < 64; j++) {
            let f, g;
            if (j < 16) { f = (b & c) | (~b & d); g = j; }
            else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
            else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * j) % 16; }
            const temp = d;
            d = c; c = b;
            b = (b + rol(a + f + k[j] + words[i + g], s[j])) | 0;
            a = temp;
        }
        a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
    }

    return [a, b, c, d].map(v => 
        (v >>> 0).toString(16).padStart(8, '0').match(/../g).reverse().join('')
    ).join('');
}

export async function calculateSHA256(uint8array) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', uint8array);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 文字コードを自動判別してデコードする (強化版)
 * 1. UTF-8 BOMチェック
 * 2. UTF-8 (厳密)
 * 3. EUC-JP (厳密)
 * 4. CP932 / Shift-JIS (最終フォールバック)
 */
function smartDecode(uint8array) {
    // 1. UTF-8 BOM (EF BB BF) のチェック
    if (uint8array.length >= 3 && uint8array[0] === 0xef && uint8array[1] === 0xbb && uint8array[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(uint8array);
    }

    // 2. UTF-8 で試行
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(uint8array);
    } catch (e) {
        // UTF-8 ではない
    }

    // 3. EUC-JP で試行
    try {
        return new TextDecoder('euc-jp', { fatal: true }).decode(uint8array);
    } catch (e) {
        // EUC-JP でもない
    }

    // 4. 最終フォールバック: CP932 (Shift-JIS)
    // 日本のBMS文化ではこれが最も多いため、最後はこれでデコードします
    // (CP932はShift-JISの拡張なので、shift-jis指定で概ねカバーされます)
    return new TextDecoder('shift-jis').decode(uint8array);
}

/**
 * 譜面のヘッダー情報（タイトル・アーティスト・ハッシュ）だけを高速に取得する
 * タイムライン（timeline_master）の構築は行わない
 */
export async function getSongHeaders(uint8array) {
    // JSON(bmson)かどうかの判定
    let isJson = false;
    for(let i=0; i<Math.min(uint8array.length, 100); i++) {
        if (uint8array[i] === 0x7b) { isJson = true; break; }
        if (uint8array[i] > 0x20) break;
    }

    const text = smartDecode(uint8array)
    let info = {};
    if (isJson) {
        const data = JSON.parse(text);
        const bInfo = data.info || {};
        info = {
            title: bInfo.title || '',
            subtitle: bInfo.subtitle || (bInfo.chart_name ? `[${bInfo.chart_name}]` : ''),
            artist: bInfo.artist || '',
            subartist: Array.isArray(bInfo.subartists) ? bInfo.subartists.join(', ') : (bInfo.subartist || ''),
            total: parseFloat(bInfo.total) || 100
        };
    } else {
        const headers = bms.Compiler.compile(text).chart.headers;
        info = {
            title: headers.get('title') || '',
            subtitle: headers.get('subtitle') || '',
            artist: headers.get('artist') || '',
            subartist: headers.get('subartist') || '',
            total: parseFloat(headers.get('total')) || 200
        };
    }

    return info;
}


/**
 * bmson形式をパースして timeline_master と song_info を作成する
 */
function parseBmson(uint8array) {
    const text = smartDecode(uint8array)
    const data = JSON.parse(text);

    const info = data.info || {};
    const resolution = info.resolution || 240; 
    const initBpm = info.init_bpm;

    if (initBpm === undefined) throw new Error("info.init_bpm が指定されていません。");

    // --- 1. タイミング計算 ---
    const timePoints = new Set([0]);
    if (data.bpm_events) data.bpm_events.forEach(e => timePoints.add(e.y));
    if (data.stop_events) data.stop_events.forEach(e => timePoints.add(e.y));
    const sortedY = Array.from(timePoints).sort((a, b) => a - b);

    const bpmMap = {};
    if (data.bpm_events) {
        data.bpm_events.forEach(e => { bpmMap[e.y] = e.bpm; });
    }
    const stopMap = {};
    if (data.stop_events) {
        data.stop_events.forEach(e => {
            stopMap[e.y] = (stopMap[e.y] || 0) + e.duration;
        });
    }

    const yToMs = new Map();
    let currentMs = 0;
    let currentBpm = initBpm;
    let lastY = 0;

    for (const y of sortedY) {
        const elapsedPulses = y - lastY;
        currentMs += (elapsedPulses / resolution) * (60 / currentBpm) * 1000;
        if (bpmMap[y] !== undefined) currentBpm = bpmMap[y];
        yToMs.set(y, Math.round(currentMs));
        if (stopMap[y] !== undefined) {
            currentMs += (stopMap[y] / resolution) * (60 / currentBpm) * 1000;
        }
        lastY = y;
    }

    function getMs(y) {
        let baseIdx = 0;
        for (let i = sortedY.length - 1; i >= 0; i--) {
            if (y >= sortedY[i]) { baseIdx = i; break; }
        }
        const baseY = sortedY[baseIdx];
        let activeBpm = initBpm;
        for (let i = 0; i <= baseIdx; i++) {
            if (bpmMap[sortedY[i]] !== undefined) activeBpm = bpmMap[sortedY[i]];
        }
        const extraPulses = y - baseY;
        return Math.round(yToMs.get(baseY) + (extraPulses / resolution) * (60 / activeBpm) * 1000);
    }

    // --- 2. ノーツ抽出 ---
    const extractedNotes = [];
    let has6thOr7thKey = false;

    if (data.sound_channels) {
        data.sound_channels.forEach(channel => {
            if (!channel.notes) return;
            channel.notes.forEach(n => {
                const x = n.x;
                // x=1-7が鍵盤、x=8が皿
                if (x >= 1 && x <= 8) {
                    let lane = (x <= 7) ? x - 1 : 7;
                    if (lane === 5 || lane === 6) has6thOr7thKey = true;

                    // 開始地点のみを追加。n.l（長さ）があっても終点は無視する。
                    extractedNotes.push({ time: getMs(n.y), lane: lane });
                }
            });
        });
    }

    if (extractedNotes.length === 0) throw new Error("ノーツが見つかりませんでした(bmson)");
    extractedNotes.sort((a, b) => a.time - b.time);

    // --- 3. timeline_master 構築 ---
    const timeline_master = [];
    let current_time = -1;
    let this_timeline = null;
    for (const note of extractedNotes) {
        if (note.time !== current_time) {
            if (this_timeline !== null) timeline_master.push(this_timeline);
            this_timeline = new Array(9).fill(0);
            current_time = note.time;
            this_timeline[0] = current_time;
        }
        this_timeline[note.lane + 1] = 1;
    }
    if (this_timeline !== null) timeline_master.push(this_timeline);

    const subartist = Array.isArray(info.subartists) ? info.subartists.join(', ') : (info.subartist || '');

    const song_info = {
        title: info.title || '',
        subtitle: info.subtitle || (info.chart_name ? `[${info.chart_name}]` : ''),
        artist: info.artist || '',
        subartist: subartist,
        song_last_ms: extractedNotes.length > 0 ? extractedNotes[extractedNotes.length - 1].time : 0,
        total: parseFloat(info.total) || 100,
        total_notes: extractedNotes.length
    };

    return { timeline_master, song_info };
}


/**
 * 拡張版：processBMSData
 */
export async function processBMSData(uint8array) {
    const isJson = (uint8array[0] === 0x7b); 

    let result;
    if (isJson) {
        result = parseBmson(uint8array);
    } else {
        // 従来のBMSパース
        const text = smartDecode(uint8array)
        const chart = bms.Compiler.compile(text).chart;
        const timing = bms.Timing.fromBMSChart(chart);

        const extractedNotes = [];
        let has6thOr7thKey = false;
        
        // LNの開始・終了を判定するためのステータス
        const lnStates = new Array(8).fill(false); 

        // オブジェクトを時間順に確実にソートして処理
        const bmsObjects = chart.objects.all().filter(obj => {
            const ch = parseInt(obj.channel, 10);
            // 11-19: 通常ノーツ, 16: 皿, 51-59: LN, 56: LN皿
            return (ch >= 11 && ch <= 19) || (ch >= 51 && ch <= 59);
        }).sort((a, b) => {
            const beatA = chart.measureToBeat(a.measure, a.fraction);
            const beatB = chart.measureToBeat(b.measure, b.fraction);
            return beatA - beatB;
        });

        bmsObjects.forEach(obj => {
            const laneIndex = getLaneIndexFor7Keys(obj.channel);
            if (laneIndex !== -1) {
                const ch = parseInt(obj.channel, 10);
                const isLNChannel = (ch >= 51 && ch <= 59);
                
                const calculatedBeat = chart.measureToBeat(obj.measure, obj.fraction);
                const timeMs = Math.round(timing.beatToSeconds(calculatedBeat) * 1000);

                if (isLNChannel) {
                    if (!lnStates[laneIndex]) {
                        // LNの開始点（1つ目のオブジェクト）のみを採用
                        extractedNotes.push({ time: timeMs, lane: laneIndex });
                        lnStates[laneIndex] = true;
                    } else {
                        // LNの終了点（2つ目のオブジェクト）なので状態をリセットし、追加はしない
                        lnStates[laneIndex] = false;
                    }
                } else {
                    // 通常ノーツ
                    extractedNotes.push({ time: timeMs, lane: laneIndex });
                }

                if (laneIndex === 5 || laneIndex === 6) has6thOr7thKey = true;
            }
        });

        if (extractedNotes.length === 0) throw new Error("ノーツなし");
        if (!has6thOr7thKey) throw new Error("7鍵ではありません");

        extractedNotes.sort((a, b) => a.time - b.time);

        const timeline_master = [];
        let current_time = -1;
        let this_timeline = null;
        for (const note of extractedNotes) {
            if (note.time !== current_time) {
                if (this_timeline !== null) timeline_master.push(this_timeline);
                this_timeline = new Array(9).fill(0);
                current_time = note.time;
                this_timeline[0] = current_time;
            }
            this_timeline[note.lane + 1] = 1;
        }
        if (this_timeline !== null) timeline_master.push(this_timeline);

        result = {
            timeline_master,
            song_info: {
                title: chart.headers.get('title') || '',
                subtitle: chart.headers.get('subtitle') || '',
                artist: chart.headers.get('artist') || '',
                subartist: chart.headers.get('subartist') || '',
                song_last_ms: extractedNotes.length > 0 ? extractedNotes[extractedNotes.length - 1].time : 0,
                total: parseFloat(chart.headers.get('total')) || 200,
                total_notes: extractedNotes.length
            }
        };
    }

    return result;
}

function getLaneIndexFor7Keys(ch) {
    const c = parseInt(ch, 10);
    const base = (c >= 50 && c <= 59) ? c - 40 : c;
    const map = { 11: 0, 12: 1, 13: 2, 14: 3, 15: 4, 18: 5, 19: 6, 16: 7 };
    return map[base] ?? -1;
}


/**
 * Pythonの BMSDataset.from_raw_list ロジックを再現し、
 * ONNXモデルに入力可能な Float32Array を生成する
 */
export async function prepareInferenceData(analyzer, song_info) {
    const windowSize = 600;
    const stride = 200;
    const maxWindows = 600; // モデルのシーケンス長 (seqLen)
    const metaDim = 46;     // 特徴量の次元数

    const tempMetas = [];
    const songLastMs = song_info.song_last_ms;

    // 1. すべての窓から特徴量を抽出
    for (let start = 0; start < songLastMs; start += stride) {
        const meta = analyzer.getWindowMeta(start, start + windowSize);
        tempMetas.push(meta); // Float32Array
    }

    if (tempMetas.length === 0) throw new Error("有効なメタデータが抽出できませんでした。");

    // 2. 有効な窓（ノーツが含まれる窓）を判定
    // Python: notes_count = temp_metas_np[:, 0] + temp_metas_np[:, 1]
    const notesCounts = tempMetas.map(m => m[0] + m[1]);
    const validIndices = [];
    notesCounts.forEach((count, i) => { if (count > 0) validIndices.push(i); });

    if (validIndices.length === 0) throw new Error("ノーツが含まれる窓がありません。");

    const lastValidIdx = validIndices[validIndices.length - 1];
    let validLength = lastValidIdx + 1;

    // 3. 切り出し範囲の決定 (Max Density Logic)
    let startIdx = 0;
    if (validLength > maxWindows) {
        startIdx = validLength - maxWindows; // デフォルトは末尾から逆算

        // 範囲内で最も密度の高いインデックスを探す
        let maxDensityIdx = 0;
        let maxVal = -1;
        for (let i = 0; i < validLength; i++) {
            if (notesCounts[i] > maxVal) {
                maxVal = notesCounts[i];
                maxDensityIdx = i;
            }
        }

        // 最大密度地点がカットされる場合は、開始位置を調整
        if (maxDensityIdx < startIdx) {
            const margin = 10;
            startIdx = Math.max(0, maxDensityIdx - margin);
        }
    }

    // 実際に使用する窓を抽出
    const finalMetas = tempMetas.slice(startIdx, Math.min(startIdx + maxWindows, validLength));

    // 4. [1, 600, 46] の Tensor 用に Flat な Float32Array を作成
    const inputBuffer = new Float32Array(maxWindows * metaDim); // 全て0で初期化される

    // 5. データのコピー（右詰め）
    const shift = maxWindows - finalMetas.length;
    for (let i = 0; i < finalMetas.length; i++) {
        const meta = finalMetas[i];
        for (let d = 0; d < metaDim; d++) {
            inputBuffer[(shift + i) * metaDim + d] = meta[d];
        }
    }

    return inputBuffer;
}


/**
 * 推論値 [0, 1] を BMS の難易度表記 (sl/st) にマッピングするクラス
 */
export class BMSDifficultyMapper {
    constructor() {
        this.total_div = 27.0;
        this.sl_offset = 1.0;
        this.st_offset = 14.0;
    }

    /**
     * サブレベル文字列 (X-, X, X+) を判定する内部メソッド
     */
    _getSubLabel(rawVal, prefix) {
        const baseX = Math.floor(rawVal + 0.5);
        const rem = rawVal - baseX;

        let subMod = "";
        if (rem < -0.2) {
            subMod = "-";
        } else if (rem < 0.2) {
            subMod = "";
        } else {
            subMod = "+";
        }

        return `${prefix}${baseX}${subMod}`;
    }

    /**
     * 推論値 y [0, 1] を受け取り、難易度オブジェクトに変換する
     */
    denormalize(y) {
        // クランプ処理
        y = Math.max(0.0, Math.min(1.0, parseFloat(y)));

        const thresholdSlMinus = 0.5 / this.total_div;
        const thresholdStStart = 13.5 / this.total_div;
        const thresholdStPlus  = 26.5 / this.total_div;

        if (y < thresholdSlMinus) {
            return {
                table: "sl-",
                level: 0.0,
                display: "sl-",
                label: "sl-",
                sub_label: "sl-"
            };
        } else if (y < thresholdStStart) {
            const rawVal = y * this.total_div - this.sl_offset;
            let level = rawVal;
            if (Math.round(level * 10) / 10 === 0.0) level = 0.0;

            return {
                table: "sl",
                level: level,
                display: `sl${level.toFixed(1)}`,
                label: `sl${Math.round(level)}`,
                sub_label: this._getSubLabel(rawVal, "sl")
            };
        } else if (y < thresholdStPlus) {
            const rawVal = y * this.total_div - this.st_offset;
            let level = rawVal;
            if (Math.round(level * 10) / 10 === 0.0) level = 0.0;

            return {
                table: "st",
                level: level,
                display: `st${level.toFixed(1)}`,
                label: `st${Math.round(level)}`,
                sub_label: this._getSubLabel(rawVal, "st")
            };
        } else {
            return {
                table: "st+",
                level: 0.0,
                display: "st+",
                label: "st+",
                sub_label: "st+"
            };
        }
    }
}
