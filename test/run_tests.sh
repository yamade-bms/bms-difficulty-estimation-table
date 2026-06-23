#!/bin/bash
set -e

# テストスクリプトのあるディレクトリに移動
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# テスト対象の定義 (MD5/ファイル名:EXPECTED_RESULT:COMMENT)
# EXPECTED_RESULT は "success" または "error"
TEST_CASES=(
    "normal_0000c7e949345056897b4396deb85c8f:success:通常譜面1 (既存・pred: 0.2799)"
    "normal_643c91096f35d0622ca3446b6562865f:success:通常譜面2 (pred: 0.6486)"
    "normal_88c4a60a4be94dd73169ea8f6fc3c7f0:success:通常譜面3 (pred: 0.3594)"
    "normal_3f71772b044b4fadb756740813bd04d8:success:通常譜面4 (pred: 0.3270)"
    "normal_0a682def4c79d7bd55a5c885b4d85638:success:通常譜面5 (pred: 0.3735)"
    "large_bga_577ec71453d823a9dd672b02379b7a66:success:大容量通常1 (既存・pred: 0.4133)"
    "large_bga_e37e94d1267f778e1f0e6c310eddfdb4:success:大容量通常2 (pred: 0.4667)"
    "large_bga_741c0702af1ba0cc2091c0a241f906a7:success:大容量通常3 (pred: 0.3201)"
    "large_bga_c96d43ca1b3e7410b7c423667ec4e213:success:大容量通常4 (pred: 0.0184)"
    "large_bga_865307772d39dbee555ba423ac7fddc9:success:大容量通常5 (pred: 0.0026)"
    "too_large_4ec10b846554b6eda6b62ebd49e15fb3:error:超過譜面1 (既存・オブジェクト数超過)"
    "too_large_37cfd4be61a3b90ab7c4f81f05df678e:error:超過譜面2 (時間超過)"
    "too_large_660cb6ab98a1e5c56a6cd2ac59a4bb61:error:超過譜面3 (時間超過)"
    "too_large_79c994f457851bd570a2ebdaac2ce0f6:error:超過譜面4 (時間超過)"
    "too_large_81f0523d580cc3afa5827e968d6ac9fe:error:超過譜面5 (時間超過)"
    "bpm_02219fc200b7bbf9d068ac978f85188b:success:BPM変化・STOP検証1 (pred: 0.4589)"
    "bpm_069b9488fdb130fed13386b9599429fc:success:BPM変化・STOP検証2 (pred: 0.5253)"
    "bpm_1388f3f994d93c25b1d550c8cf05dbbd:success:BPM変化・STOP検証3 (pred: 0.5052)"
    "bpm_17b5d2500efe034ab377e85ee7a929c7:success:BPM変化・STOP検証4 (pred: 0.5246)"
    "bpm_231e5292f372e77a369e45b1cde1a21c:success:BPM変化・STOP検証5 (pred: 0.5331)"
    "mine_069b9488fdb130fed13386b9599429fc:success:地雷除外検証1 (pred: 0.5253)"
    "mine_e05e18d4ed72a4202353667e4bf4c1ce:success:地雷除外検証2 (pred: 0.5603)"
    "mine_6e325629b762341e12c058c008a8d878:success:地雷除外検証3 (pred: 0.6504)"
    "mine_25e19d3b2a346044fb0fd678d499241e:success:地雷除外検証4 (pred: 0.1703)"
    "mine_e03b6b7e78bafcc7e0defccabe5ee780:success:地雷除外検証5 (pred: 0.1415)"
)

# 1. Dockerイメージのビルド (最初に1回だけ実行)
echo "Building Docker image (bms-table-test)..."
cd ..
docker build -t bms-table-test -f test/Dockerfile .
cd test

failed_tests=0

for item in "${TEST_CASES[@]}"; do
    IFS=':' read -r CASE_ID EXPECTED INFO <<< "$item"
    echo "=================================================="
    echo "Testing Case: $CASE_ID"
    echo "Info: $INFO"
    echo "Expected Result: $EXPECTED"
    echo "=================================================="
    
    # 2. テスト用BMSファイルをコピー (/tmp/table_test/test.bms として一時配置)
    mkdir -p /tmp/table_test
    if [ -f "bms/${CASE_ID}.bms" ]; then
        cp "bms/${CASE_ID}.bms" /tmp/table_test/test.bms
    else
        echo "Error: BMS file bms/${CASE_ID}.bms not found"
        failed_tests=$((failed_tests + 1))
        continue
    fi
    
    # 3. 期待値データの生成 (正常に推定できるべき譜面のみ)
    if [ "$EXPECTED" = "success" ]; then
        echo "Generating expectations..."
        # 期待値生成のため /tmp/table_test/expect_out を空にする
        rm -rf /tmp/table_test/expect_out/
        uv run --with onnxruntime generate_expectations.py "$CASE_ID"
    fi
    
    # 4. Dockerでテストを実行 (ホストの /tmp/table_test をコンテナ内の /tmp/table_test にマウント共有)
    cd ..
    if ! docker run --rm -v "$(pwd):/app" -v /tmp/table_test:/tmp/table_test bms-table-test node --experimental-network-imports test/test_inference.js "$CASE_ID" "$EXPECTED"; then
        echo "-> TEST FAILED for Case $CASE_ID"
        failed_tests=$((failed_tests + 1))
    else
        echo "-> TEST PASSED"
    fi
    cd test
done

# 後片付け
rm -rf /tmp/table_test


if [ $failed_tests -gt 0 ]; then
    echo "=================================================="
    echo "$failed_tests test(s) FAILED."
    exit 1
else
    echo "=================================================="
    echo "All tests PASSED successfully!"
    exit 0
fi
