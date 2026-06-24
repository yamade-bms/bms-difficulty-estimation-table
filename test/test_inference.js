import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
globalThis.ort = ort;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// テスト対象の関数をインポート
import { processBMSData } from '../estimate/bms-processor.js';

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

async function runTests() {
    const caseId = process.argv[2];
    const expected = process.argv[3]; // 'success' or 'error'

    if (!caseId || !expected) {
        console.error("Usage: node test_inference.js <caseId> <success|error>");
        process.exit(1);
    }

    console.log(`Starting test for Case: ${caseId} (Expected: ${expected})`);

    // パス定義 (/tmp/table_test/ 配下を使用)
    const bmsPath = '/tmp/table_test/test.bms';
    const expectTimelinePath = '/tmp/table_test/expect_out/expect_timeline.json';
    const expectInputXPath = '/tmp/table_test/expect_out/expect_input_x.json';
    const expectPredsPath = '/tmp/table_test/expect_out/expect_predictions.json';

    // 1. パーステスト
    console.log("\n[Test 1] Parsing consistency...");
    const fileBuffer = fs.readFileSync(bmsPath);
    const uint8array = new Uint8Array(fileBuffer);

    let timeline_master, song_info;
    try {
        const result = await processBMSData(uint8array);
        timeline_master = result.timeline_master;
        song_info = result.song_info;

        if (expected === 'error') {
            console.error("FAIL: processBMSData should have thrown an error for this giant chart but completed successfully.");
            process.exit(1);
        }
    } catch (e) {
        if (expected === 'error') {
            if (e.message.includes("オブジェクト数が多すぎます") || e.message.includes("長すぎます")) {
                console.log(`-> Safely blocked with expected error: "${e.message}" : PASS`);
                process.exit(0); // 弾かれるべきファイルが正しく弾かれたのでテスト成功
            } else {
                console.error(`FAIL: Threw unexpected error: "${e.message}"`);
                process.exit(1);
            }
        } else {
            console.error("FAIL: processBMSData threw an error for a normal chart:", e.message);
            process.exit(1);
        }
    }

    // パース結果の比較検証
    try {
        const expectData = JSON.parse(fs.readFileSync(expectTimelinePath, 'utf8'));
        const expectTimeline = expectData.timeline_master;
        const expectSongInfo = expectData.song_info;

        // timeline_master の比較
        if (timeline_master.length !== expectTimeline.length) {
            throw new Error(`Timeline length mismatch: JS has ${timeline_master.length}, python has ${expectTimeline.length}`);
        }

        for (let i = 0; i < timeline_master.length; i++) {
            for (let j = 0; j < 9; j++) {
                if (j === 0) {
                    // 時間（ミリ秒）は浮動小数点誤差による1ms以内のズレを許容する
                    if (Math.abs(timeline_master[i][j] - expectTimeline[i][j]) > 1) {
                        throw new Error(`Timeline time mismatch at row ${i}: JS=${timeline_master[i][j]}, python=${expectTimeline[i][j]}`);
                    }
                } else {
                    if (timeline_master[i][j] !== expectTimeline[i][j]) {
                        throw new Error(`Timeline value mismatch at row ${i}, col ${j}: JS=${timeline_master[i][j]}, python=${expectTimeline[i][j]}`);
                    }
                }
            }
        }
        console.log("-> Timeline matching: PASS");

        // song_info の比較
        if (song_info.total_notes !== expectSongInfo.total_notes) {
            throw new Error(`SongInfo mismatch for key 'total_notes': JS=${song_info.total_notes}, python=${expectSongInfo.total_notes}`);
        }
        // ギミック譜面でのタイミング計算エンジン誤差（高BPM・STOP計算の端数処理の違い）を考慮し、100ms以内の誤差を許容します
        if (Math.abs(song_info.song_last_ms - expectSongInfo.song_last_ms) > 100) {
            throw new Error(`SongInfo mismatch for key 'song_last_ms': JS=${song_info.song_last_ms}, python=${expectSongInfo.song_last_ms} (Diff > 100ms)`);
        }
        console.log("-> SongInfo matching: PASS");
    } catch (e) {
        console.error("FAIL:", e.message);
        process.exit(1);
    }

    // 2. 推論テスト
    if (fs.existsSync(expectPredsPath)) {
        console.log("\n[Test 2] Inference consistency...");
        try {
            const inputXList = JSON.parse(fs.readFileSync(expectInputXPath, 'utf8'));
            const expectPreds = JSON.parse(fs.readFileSync(expectPredsPath, 'utf8')).predictions;

            // Float32Array に平坦化
            const flatInput = new Float32Array(inputXList.flat());

            const feeds = {
                input_x: new ort.Tensor('float32', flatInput, [1, 600, 58])
            };

            const estimateDir = path.resolve(__dirname, '../estimate');
            const runCount = 3;
            const foldCount = 5;
            const jsPreds = [];

            let idx = 0;
            for (let r = 1; r <= runCount; r++) {
                for (let f = 1; f <= foldCount; f++) {
                    const modelPath = path.join(estimateDir, `run${r}_fold${f}.onnx`);
                    if (fs.existsSync(modelPath)) {
                        const session = await ort.InferenceSession.create(modelPath);
                        const result = await session.run(feeds);
                        const predVal = result[session.outputNames[0]].data[0];
                        jsPreds.push(predVal);

                        const expectedVal = expectPreds[idx];
                        const diff = Math.abs(predVal - expectedVal);
                        if (diff > 1e-4) {
                            throw new Error(`Inference mismatch at model run${r}_fold${f}: JS=${predVal.toFixed(6)}, python=${expectedVal.toFixed(6)}, diff=${diff.toExponential(3)}`);
                        }
                        idx++;
                    }
                }
            }

            console.log(`-> All ${jsPreds.length} ONNX models predictions matching (diff < 1e-4): PASS`);

            const jsScore = calculateIqrMean(jsPreds);
            const pythonScore = calculateIqrMean(expectPreds);
            console.log(`-> Final score: JS=${jsScore.toFixed(6)} | Python=${pythonScore.toFixed(6)} (Diff: ${Math.abs(jsScore - pythonScore).toExponential(3)})`);
            if (Math.abs(jsScore - pythonScore) > 1e-5) {
                throw new Error("Final ensemble score mismatch");
            }
            console.log("-> Ensemble score matching: PASS");

        } catch (e) {
            console.error("FAIL:", e.message);
            process.exit(1);
        }
    } else {
        console.log("\n[Test 2] Inference consistency skipped (no expectations).");
    }

    console.log("\nAll tests PASSED successfully!");
    process.exit(0);
}

runTests();
