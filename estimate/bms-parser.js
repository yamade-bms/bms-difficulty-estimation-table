// bms-parser.js
// beatoraja (jbms-parser) 互換の軽量BMSパーサーおよびタイミング計算ロジック

/**
 * @typedef {Object} SongInfo
 * @property {string} title - 曲のタイトル
 * @property {string} subtitle - 曲のサブタイトル
 * @property {string} artist - アーティスト名
 * @property {string} subartist - サブアーティスト名
 * @property {number} song_last_ms - 曲の終端時刻 (ミリ秒)
 * @property {number} total - TOTAL値
 * @property {number} total_notes - 総ノーツ数
 */

/**
 * @typedef {Object} BMSParseResult
 * @property {number[][]} timeline_master - タイムラインの配列 (各要素は [time_ms, k0, k1, k2, k3, k4, k5, k6, scratch])
 * @property {SongInfo} song_info - 曲のメタ情報
 */

/**
 * BMSファイルのテキストをパースし、beatoraja互換のタイムラインとメタ情報を返します。
 * @param {string} text - デコードされたBMSファイルのテキストデータ
 * @returns {BMSParseResult} パースおよびタイミング計算結果
 */
export function parseBMS(text) {
    function parseInt36(c1, c2) {
        let result = 0;
        if (c1 >= '0' && c1 <= '9') {
            result = (c1.charCodeAt(0) - 48) * 36;
        } else if (c1 >= 'a' && c1 <= 'z') {
            result = (c1.charCodeAt(0) - 97 + 10) * 36;
        } else if (c1 >= 'A' && c1 <= 'Z') {
            result = (c1.charCodeAt(0) - 65 + 10) * 36;
        } else {
            return -1;
        }

        if (c2 >= '0' && c2 <= '9') {
            result += (c2.charCodeAt(0) - 48);
        } else if (c2 >= 'a' && c2 <= 'z') {
            result += (c2.charCodeAt(0) - 97 + 10);
        } else if (c2 >= 'A' && c2 <= 'Z') {
            result += (c2.charCodeAt(0) - 65 + 10);
        } else {
            return -1;
        }
        return result;
    }

    function parseInt62(c1, c2) {
        let result = 0;
        if (c1 >= '0' && c1 <= '9') {
            result = (c1.charCodeAt(0) - 48) * 62;
        } else if (c1 >= 'A' && c1 <= 'Z') {
            result = (c1.charCodeAt(0) - 65 + 10) * 62;
        } else if (c1 >= 'a' && c1 <= 'z') {
            result = (c1.charCodeAt(0) - 97 + 36) * 62;
        } else {
            return -1;
        }

        if (c2 >= '0' && c2 <= '9') {
            result += (c2.charCodeAt(0) - 48);
        } else if (c2 >= 'A' && c2 <= 'Z') {
            result += (c2.charCodeAt(0) - 65 + 10);
        } else if (c2 >= 'a' && c2 <= 'z') {
            result += (c2.charCodeAt(0) - 97 + 36);
        } else {
            return -1;
        }
        return result;
    }

    function toBase62(decimal) {
        let result = [];
        let temp = decimal;
        for (let i = 0; i < 2; i++) {
            let mod = temp % 62;
            if (mod < 10) {
                result.push(String.fromCharCode(mod + 48));
            } else if (mod < 36) {
                result.push(String.fromCharCode(mod - 10 + 65));
            } else if (mod < 62) {
                result.push(String.fromCharCode(mod - 36 + 97));
            } else {
                result.push("0");
            }
            temp = Math.floor(temp / 62);
        }
        return result.reverse().join('');
    }

    const lines = text.split(/\r?\n/);

    let init_bpm = 130.0;
    let bpm_table = {};
    let stop_table = {};
    let lnobj = null;
    let total = 200.0;
    let title = "";
    let subtitle = "";
    let artist = "";
    let subartist = "";
    let base = 36;

    let measureBpmChange = {};
    let measureStop = {};
    let measureScroll = {};
    let measureRates = {};
    let measureChannels = {};
    let maxMeasure = 0;

    let skip = [];
    let crandom = [];

    // パース第1段階：ヘッダーおよびデータ行のバッファリング
    for (let line of lines) {
        line = line.trim();
        if (!line.startsWith('#')) continue;

        // RANDOM等の簡易シミュレーション
        let upperLine = line.toUpperCase();
        if (upperLine.startsWith('#RANDOM')) {
            crandom.push(1); // 常に最初の分岐を選択
            continue;
        } else if (upperLine.startsWith('#IF')) {
            if (crandom.length > 0) {
                let cond = parseInt(line.substring(4).trim(), 10);
                skip.push(crandom[crandom.length - 1] !== cond);
            } else {
                skip.push(false);
            }
            continue;
        } else if (upperLine.startsWith('#ENDIF')) {
            if (skip.length > 0) skip.pop();
            continue;
        } else if (upperLine.startsWith('#ENDRANDOM')) {
            if (crandom.length > 0) crandom.pop();
            continue;
        }

        // RANDOM分岐のスキップ判定
        if (skip.length > 0 && skip[skip.length - 1]) {
            continue;
        }

        if (upperLine.startsWith('#BPM ')) {
            init_bpm = parseFloat(line.substring(5).trim());
            continue;
        }
        if (upperLine.startsWith('#BPM') && !upperLine.startsWith('#BPM ')) {
            let keyStr = line.substring(4, 6);
            let key = base === 62 ? parseInt62(keyStr.charAt(0), keyStr.charAt(1)) : parseInt36(keyStr.charAt(0), keyStr.charAt(1));
            bpm_table[key] = parseFloat(line.substring(7).trim());
            continue;
        }
        if (upperLine.startsWith('#STOP')) {
            let keyStr = line.substring(5, 7);
            let key = base === 62 ? parseInt62(keyStr.charAt(0), keyStr.charAt(1)) : parseInt36(keyStr.charAt(0), keyStr.charAt(1));
            stop_table[key] = parseFloat(line.substring(8).trim()) / 192.0;
            continue;
        }
        if (upperLine.startsWith('#LNOBJ')) {
            let arg = line.substring(7).trim();
            lnobj = base === 62 ? parseInt62(arg.charAt(0), arg.charAt(1)) : parseInt36(arg.charAt(0), arg.charAt(1));
            continue;
        }
        if (upperLine.startsWith('#TOTAL')) {
            let val = parseFloat(line.substring(7).trim());
            if (val > 0) total = val;
            continue;
        }
        if (upperLine.startsWith('#TITLE ')) {
            title = line.substring(7).trim();
            continue;
        }
        if (upperLine.startsWith('#SUBTITLE ')) {
            subtitle = line.substring(10).trim();
            continue;
        }
        if (upperLine.startsWith('#ARTIST ')) {
            artist = line.substring(8).trim();
            continue;
        }
        if (upperLine.startsWith('#SUBARTIST ')) {
            subartist = line.substring(11).trim();
            continue;
        }
        if (upperLine.startsWith('#BASE ')) {
            let arg = parseInt(line.substring(6).trim(), 10);
            if (arg === 62) base = 62;
            continue;
        }

        // データ行のパース
        let match = line.match(/^#(\d{3})(\w{2}):(.*)$/);
        if (match) {
            let measure = parseInt(match[1], 10);
            let channelStr = match[2];
            let dataStr = match[3].trim();
            if (dataStr.length === 0) continue;

            if (measure > maxMeasure) maxMeasure = measure;

            if (!measureBpmChange[measure]) measureBpmChange[measure] = {};
            if (!measureStop[measure]) measureStop[measure] = {};
            if (!measureScroll[measure]) measureScroll[measure] = {};
            if (!measureChannels[measure]) measureChannels[measure] = [];

            let channel = parseInt36(channelStr.charAt(0), channelStr.charAt(1));
            if (channel === -1) continue;

            let split = dataStr.length / 2;

            if (channel === 2) {
                measureRates[measure] = parseFloat(dataStr);
            } else if (channel === 3) {
                for (let i = 0; i < split; i++) {
                    let c1 = dataStr.charAt(i * 2);
                    let c2 = dataStr.charAt(i * 2 + 1);
                    let val = base === 62 ? parseInt62(c1, c2) : parseInt36(c1, c2);
                    if (val > 0) {
                        if (base === 62) {
                            let b62 = toBase62(val);
                            val = parseInt36(b62.charAt(0), b62.charAt(1));
                        }
                        let bpm = Math.floor(val / 36) * 16 + (val % 36);
                        measureBpmChange[measure][i / split] = bpm;
                    }
                }
            } else if (channel === 8) {
                for (let i = 0; i < split; i++) {
                    let c1 = dataStr.charAt(i * 2);
                    let c2 = dataStr.charAt(i * 2 + 1);
                    let val = base === 62 ? parseInt62(c1, c2) : parseInt36(c1, c2);
                    if (val > 0) {
                        let bpm = bpm_table[val];
                        if (bpm !== undefined) {
                            measureBpmChange[measure][i / split] = bpm;
                        }
                    }
                }
            } else if (channel === 9) {
                for (let i = 0; i < split; i++) {
                    let c1 = dataStr.charAt(i * 2);
                    let c2 = dataStr.charAt(i * 2 + 1);
                    let val = base === 62 ? parseInt62(c1, c2) : parseInt36(c1, c2);
                    if (val > 0) {
                        let stopVal = stop_table[val];
                        if (stopVal !== undefined) {
                            measureStop[measure][i / split] = stopVal;
                        }
                    }
                }
            } else {
                measureChannels[measure].push({ channel: channelStr, data: dataStr });
            }
        }
    }

    // パース第2段階：動的なキー数の決定
    let keys = 5;
    for (let s = 0; s <= maxMeasure; s++) {
        let channels = measureChannels[s] ?? [];
        for (let c of channels) {
            let ch = parseInt36(c.channel.charAt(0), c.channel.charAt(1));
            let basech = 0;
            let ch2 = -1;
            let ch_bases = [37, 73, 109, 145, 181, 217, 469, 505];
            for (let base_val of ch_bases) {
                if (ch >= base_val && ch <= base_val + 8) {
                    basech = base_val;
                    ch2 = ch - base_val;
                    break;
                }
            }
            if (ch2 === 7 || ch2 === 8) {
                if (keys === 5) keys = 7;
                else if (keys === 10) keys = 14;
            }
            if (basech === 73 || basech === 145 || basech === 217 || basech === 505) {
                if (keys === 5) keys = 10;
                else if (keys === 7) keys = 14;
            }
        }
    }

    function getLaneIndex(basech, ch2) {
        const assign7 = { 0:0, 1:1, 2:2, 3:3, 4:4, 5:7, 7:5, 8:6 };
        const assign5 = { 0:0, 1:1, 2:2, 3:3, 4:4, 5:7 };
        let assign = (keys === 7 || keys === 14) ? assign7 : assign5;
        return assign[ch2] ?? -1;
    }

    // パース第3段階：タイムラインの構築および経過時間（マイクロ秒）の計算
    let timelines = {};
    let basetl = {
        section: 0.0,
        time: 0.0,
        bpm: init_bpm,
        scroll: 1.0,
        stop: 0,
        notes: new Array(8).fill(null),
        hasEndCandidate: false,
        isSectionLine: false
    };
    timelines[0.0] = basetl;
    let activeSections = [0.0];

    function getTimeLine(section) {
        if (timelines[section]) {
            return timelines[section];
        }
        
        let low = 0;
        let high = activeSections.length - 1;
        let lastKeyIdx = 0;
        
        while (low <= high) {
            let mid = (low + high) >> 1;
            let val = activeSections[mid];
            if (val < section) {
                lastKeyIdx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        let lastKey = activeSections[lastKeyIdx];
        let le = timelines[lastKey];
        let time = le.time + le.stop + (240000.0 * 1000.0 * (section - lastKey)) / le.bpm;
        time = Math.floor(time);

        let tl = {
            section: section,
            time: time,
            bpm: le.bpm,
            scroll: le.scroll,
            stop: 0,
            notes: new Array(8).fill(null),
            hasEndCandidate: false,
            isSectionLine: false
        };
        timelines[section] = tl;
        activeSections.splice(low, 0, section);
        return tl;
    }

    let sectionnum = 0.0;
    let lastNoteTimeLine = new Array(8).fill(null);
    let startln = new Array(8).fill(null);

    for (let s = 0; s <= maxMeasure; s++) {
        let rate = measureRates[s] ?? 1.0;

        let tl_sect = getTimeLine(sectionnum);
        tl_sect.isSectionLine = true;

        let s_stop = measureStop[s] ?? {};
        let s_bpmchange = measureBpmChange[s] ?? {};
        let s_scroll = measureScroll[s] ?? {};

        let stopKeys = Object.keys(s_stop).map(Number).sort((a, b) => a - b);
        let bpmKeys = Object.keys(s_bpmchange).map(Number).sort((a, b) => a - b);
        let scrollKeys = Object.keys(s_scroll).map(Number).sort((a, b) => a - b);

        let stopIdx = 0, bpmIdx = 0, scrollIdx = 0;
        while (stopIdx < stopKeys.length || bpmIdx < bpmKeys.length || scrollIdx < scrollKeys.length) {
            let st = stopIdx < stopKeys.length ? stopKeys[stopIdx] : 2.0;
            let bc = bpmIdx < bpmKeys.length ? bpmKeys[bpmIdx] : 2.0;
            let sc = scrollIdx < scrollKeys.length ? scrollKeys[scrollIdx] : 2.0;

            if (sc <= st && sc <= bc) {
                let tl = getTimeLine(sectionnum + sc * rate);
                tl.scroll = s_scroll[sc];
                scrollIdx++;
            } else if (bc <= st) {
                let tl = getTimeLine(sectionnum + bc * rate);
                tl.bpm = s_bpmchange[bc];
                bpmIdx++;
            } else if (st <= 1.0) {
                let tl = getTimeLine(sectionnum + st * rate);
                let stopVal = s_stop[st];
                let stopUs = Math.floor((1000000.0 * 240.0 * stopVal) / tl.bpm);
                tl.stop = stopUs;
                stopIdx++;
            }
        }

        let channels = measureChannels[s] ?? [];
        for (let c of channels) {
            let ch = parseInt36(c.channel.charAt(0), c.channel.charAt(1));
            let basech = 0;
            let ch2 = -1;
            let ch_bases = [37, 73, 109, 145, 181, 217, 469, 505];
            for (let base_val of ch_bases) {
                if (ch >= base_val && ch <= base_val + 8) {
                    basech = base_val;
                    ch2 = ch - base_val;
                    break;
                }
            }

            let split = c.data.length / 2;
            for (let i = 0; i < split; i++) {
                let c1 = c.data.charAt(i * 2);
                let c2 = c.data.charAt(i * 2 + 1);
                let val = base === 62 ? parseInt62(c1, c2) : parseInt36(c1, c2);
                if (val <= 0) continue;

                let pos = i / split;
                let tl = getTimeLine(sectionnum + rate * pos);

                if (ch === 1 || ch === 4 || ch === 7 || ch === 6) {
                    tl.hasEndCandidate = true;
                } else if (basech === 37) {
                    let lane = getLaneIndex(basech, ch2);
                    if (lane !== -1) {
                        if (lnobj !== null && val === lnobj) {
                            let prevTl = lastNoteTimeLine[lane];
                            if (prevTl && prevTl.section < tl.section) {
                                let note = prevTl.notes[lane];
                                if (note && note.type === 'normal') {
                                    note.type = 'ln_start';
                                    tl.notes[lane] = { type: 'ln_end' };
                                    lastNoteTimeLine[lane] = tl;
                                }
                            }
                        } else {
                            tl.notes[lane] = { type: 'normal' };
                            lastNoteTimeLine[lane] = tl;
                        }
                    }
                } else if (basech === 109) {
                    tl.hasEndCandidate = true;
                } else if (basech === 181) {
                    let lane = getLaneIndex(basech, ch2);
                    if (lane !== -1) {
                        if (!startln[lane]) {
                            let note = { type: 'ln_start' };
                            tl.notes[lane] = note;
                            startln[lane] = { tl: tl, note: note };
                            lastNoteTimeLine[lane] = tl;
                        } else {
                            tl.notes[lane] = { type: 'ln_end' };
                            startln[lane] = null;
                            lastNoteTimeLine[lane] = tl;
                        }
                    }
                } else if (basech === 469) {
                    tl.hasEndCandidate = true;
                }
            }
        }

        sectionnum += rate;
    }

    let sortedTimelines = Object.values(timelines).sort((a, b) => a.section - b.section);

    let song_last_ms = 0;
    for (let i = sortedTimelines.length - 1; i >= 0; i--) {
        let tl = sortedTimelines[i];
        let hasNote = false;
        for (let lane = 0; lane < 8; lane++) {
            if (tl.notes[lane] !== null) {
                hasNote = true;
                break;
            }
        }
        if (hasNote || tl.hasEndCandidate) {
            song_last_ms = Math.floor(tl.time / 1000);
            break;
        }
    }

    let timeline_master = [];
    let total_notes = 0;
    for (let tl of sortedTimelines) {
        let this_timeline = new Array(9).fill(0);
        this_timeline[0] = Math.floor(tl.time / 1000);
        let hasHitNote = false;
        for (let lane = 0; lane < 8; lane++) {
            let note = tl.notes[lane];
            if (note && (note.type === 'normal' || note.type === 'ln_start')) {
                this_timeline[lane + 1] = 1;
                hasHitNote = true;
                total_notes++;
            }
        }
        if (hasHitNote) {
            timeline_master.push(this_timeline);
        }
    }

    return {
        timeline_master,
        song_info: {
            title,
            subtitle,
            artist,
            subartist,
            song_last_ms,
            total,
            total_notes
        }
    };
}
