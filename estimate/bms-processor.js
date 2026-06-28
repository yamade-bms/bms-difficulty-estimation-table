// bms-processor.js
import { parseBMS } from './bms-parser.js';

/**
 * バイナリデータからMD5ハッシュ文字列を計算します。
 * @param {Uint8Array} uint8array - 入力データ
 * @returns {string} MD5ハッシュ文字列
 */
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

/**
 * バイナリデータからSHA256ハッシュ文字列を計算します。
 * @param {Uint8Array} uint8array - 入力データ
 * @returns {Promise<string>} SHA256ハッシュ文字列のPromise
 */
export async function calculateSHA256(uint8array) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
        try {
            const hashBuffer = await crypto.subtle.digest('SHA-256', uint8array);
            return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            // fall back to pure JS implementation
        }
    }

    // Pure JS SHA-256 fallback for non-secure contexts
    const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);

    const hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
        if (!isComposite[candidate]) {
            for (let i = 0; i < 313; i += candidate) {
                isComposite[i] = 1;
            }
            hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
            k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
        }
    }

    const asciiLength = uint8array.length * 8;
    // Align length to 64 bytes block boundary (with 8 bytes for length and 1 byte for padding)
    const paddedLength = ((uint8array.length + 9 + 63) >>> 6) << 6;
    const asciiBuffer = new Uint8Array(paddedLength);
    asciiBuffer.set(uint8array);
    asciiBuffer[uint8array.length] = 0x80;

    const view = new DataView(asciiBuffer.buffer);
    view.setUint32(paddedLength - 4, asciiLength >>> 0);
    if (asciiLength > 0xffffffff) {
        view.setUint32(paddedLength - 8, Math.floor(asciiLength / maxWord));
    }

    for (let i = 0; i < paddedLength; i += 64) {
        const w = new Uint32Array(64);
        for (let j = 0; j < 16; j++) {
            w[j] = view.getUint32(i + j * 4);
        }
        for (let j = 16; j < 64; j++) {
            const s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
            const s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
            w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
        }

        let a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], g = hash[6], h = hash[7];
        for (let j = 0; j < 64; j++) {
            const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + k[j] + w[j]) | 0;
            const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }

        hash[0] = (hash[0] + a) | 0;
        hash[1] = (hash[1] + b) | 0;
        hash[2] = (hash[2] + c) | 0;
        hash[3] = (hash[3] + d) | 0;
        hash[4] = (hash[4] + e) | 0;
        hash[5] = (hash[5] + f) | 0;
        hash[6] = (hash[6] + g) | 0;
        hash[7] = (hash[7] + h) | 0;
    }

    let result = '';
    for (let i = 0; i < 8; i++) {
        result += (hash[i] >>> 0).toString(16).padStart(8, '0');
    }
    return result;
}

/**
 * 文字コードを自動判別してデコードする (強化版)
 * 1. UTF-8 BOMチェック
 * 2. UTF-8 (厳密)
 * 3. EUC-JP (厳密)
 * 4. CP932 / Shift-JIS (最終フォールバック)
 * @param {Uint8Array} uint8array - BMSファイルのバイナリデータ
 * @returns {string} デコードされた文字列
 */
export function smartDecode(uint8array) {
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
 * @param {Uint8Array} uint8array - BMSファイルのバイナリデータ
 * @returns {Promise<import("./bms-parser.js").SongInfo>} ヘッダー情報のオブジェクト
 */
export async function getSongHeaders(uint8array) {
    // JSON(bmson)かどうかの判定
    let isJson = false;
    for (let i = 0; i < Math.min(uint8array.length, 100); i++) {
        if (uint8array[i] === 0x7b) { isJson = true; break; }
        if (uint8array[i] > 0x20) break;
    }

    const text = smartDecode(uint8array)
    if (isJson) {
        const data = JSON.parse(text);
        const bInfo = data.info || {};
        return {
            title: bInfo.title || '',
            subtitle: bInfo.subtitle || (bInfo.chart_name ? `[${bInfo.chart_name}]` : ''),
            artist: bInfo.artist || '',
            subartist: Array.isArray(bInfo.subartists) ? bInfo.subartists.join(', ') : (bInfo.subartist || ''),
            total: parseFloat(bInfo.total) || 100
        };
    } else {
        const res = parseBMS(text);
        return {
            title: res.song_info.title,
            subtitle: res.song_info.subtitle,
            artist: res.song_info.artist,
            subartist: res.song_info.subartist,
            total: res.song_info.total
        };
    }
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
        yToMs.set(y, Math.floor(currentMs));
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
        return Math.floor(yToMs.get(baseY) + (extraPulses / resolution) * (60 / activeBpm) * 1000);
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
 * BMSファイルのバイナリデータをパースし、タイムラインと曲情報を返します。
 * @param {Uint8Array} uint8array - BMSファイルのバイナリデータ
 * @returns {Promise<import("./bms-parser.js").BMSParseResult>} タイムライン(timeline_master)と曲情報(song_info)を含むオブジェクト
 */
export async function processBMSData(uint8array) {
    const isJson = (uint8array[0] === 0x7b);

    let res;
    if (isJson) {
        res = parseBmson(uint8array);
    } else {
        let text = smartDecode(uint8array);

        // 1MBを超える巨大テキストの軽量化＆オブジェクト数事前スキャン (ブラウザフリーズ対策)
        if (uint8array.length > 1000000) {
            let objectCount = 0;
            const lines = text.split(/\r?\n/);
            const cleanLines = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('#')) {
                    if (line.includes(':')) {
                        const parts = line.split(':');
                        if (parts.length >= 2 && parts[0].length >= 6) {
                            const ch = parts[0].substring(4, 6);
                            const isRequiredCh = (
                                (ch >= '11' && ch <= '16') || ch === '18' || ch === '19' ||
                                (ch >= '21' && ch <= '26') || ch === '28' || ch === '29' ||
                                (ch >= '51' && ch <= '56') || ch === '58' || ch === '59' ||
                                (ch >= '61' && ch <= '66') || ch === '68' || ch === '69' ||
                                ch === '01' || ch === '02' || ch === '03' || ch === '04' ||
                                ch === '06' || ch === '07' || ch === '08' || ch === '09'
                            );
                            if (isRequiredCh) {
                                cleanLines.push(line);
                                objectCount += parts[1].trim().length / 2;
                            }
                        }
                    } else {
                        const upperLine = line.toUpperCase();
                        const isUnusedHeader = (
                            upperLine.startsWith('#WAV') || 
                            upperLine.startsWith('#BMP') ||
                            upperLine.startsWith('#BGA')
                        );
                        if (!isUnusedHeader) {
                            cleanLines.push(line);
                        }
                    }
                }
            }

            if (objectCount > 100000) {
                throw new Error(`譜面のオブジェクト数が多すぎます (約 ${Math.round(objectCount)} オブジェクト)。10万オブジェクト以内の譜面のみ推定可能です。`);
            }

            text = cleanLines.join('\n');
        }

        res = parseBMS(text);

        if (res.timeline_master.length === 0) {
            throw new Error("ノーツなし");
        }

        let has6thOr7thKey = false;
        for (let row of res.timeline_master) {
            if (row[6] === 1 || row[7] === 1) {
                has6thOr7thKey = true;
                break;
            }
        }
        if (!has6thOr7thKey) {
            throw new Error("7鍵ではありません");
        }
    }

    // オブジェクト数（total_notes）が10万を超える場合のチェック
    if (res.song_info.total_notes > 100000) {
        throw new Error(`譜面のオブジェクト数が多すぎます (約 ${res.song_info.total_notes} オブジェクト)。10万オブジェクト以内の譜面のみ推定可能です。`);
    }

    // 曲の長さチェック
    if (res.song_info.song_last_ms > 3600000) {
        throw new Error(`譜面が長すぎます (${Math.round(res.song_info.song_last_ms / 1000 / 60)}分)。1時間以内の譜面のみ推定可能です。`);
    }

    return res;
}


/**
 * Pythonの BMSDataset.from_raw_list ロジックを再現し、
 * ONNXモデルに入力可能な Float32Array を生成する。
 * @param {Object} analyzer - ウィンドウ特徴量を計算するアナライザークラスのインスタンス
 * @param {import("./bms-parser.js").SongInfo} song_info - 曲情報オブジェクト
 * @returns {Float32Array} 推論用入力テンソル用の平坦化データ
 */
export function prepareInferenceData(analyzer, song_info) {
    const windowSize = 600;
    const stride = 200;
    const maxWindows = 600; // モデルのシーケンス長 (seqLen)
    const metaDim = 58;     // 特徴量の次元数

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

    // 4. [1, 600, 58] の Tensor 用に Flat な Float32Array を作成
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
 * @typedef {Object} DifficultyDetail
 * @property {string} table - テーブル名 ('sl-', 'sl', 'st', 'st+')
 * @property {number} level - 正規化を解除したレベル数値
 * @property {string} display - 表示用文字列 (例: 'sl10.5')
 * @property {string} label - ラベル用文字列 (例: 'sl11')
 * @property {string} sub_label - サブカテゴリ表示用 (例: 'sl11+')
 */

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
     * @private
     * @param {number} rawVal - 生レベル数値
     * @param {string} prefix - テーブル接頭辞 ('sl' or 'st')
     * @returns {string} サブレベル文字列 (例: 'sl11+')
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
     * @param {number} y - ONNXモデルの予測値
     * @returns {DifficultyDetail} 難易度情報オブジェクト
     */
    denormalize(y) {
        // クランプ処理
        y = Math.max(0.0, Math.min(1.0, parseFloat(y)));

        const thresholdSlMinus = 0.5 / this.total_div;
        const thresholdStStart = 13.5 / this.total_div;
        const thresholdStPlus = 26.5 / this.total_div;

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
