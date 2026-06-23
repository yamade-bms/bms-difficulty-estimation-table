#!/bin/bash
set -e

# テストスクリプトのあるディレクトリに移動
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# テスト対象の定義 (MD5:EXPECTED_RESULT:COMMENT)
# EXPECTED_RESULT は "success" または "error"
TEST_CASES=(
    "0000c7e949345056897b4396deb85c8f:success:深淵 - Farthest World - [Maniac] / カンナ / obj.siokaze (通常譜面・1MB以下)"
    "577ec71453d823a9dd672b02379b7a66:success:gur yvsr（仮） / Frums ※緑300推奨 (大容量通常・BGA削除パーステスト)"
    "4ec10b846554b6eda6b62ebd49e15fb3:error:G e n g a o z o _ G J _ 3 0 0 / 455-38B / black train / keh (オブジェクト数超過・即時拒否テスト)"
)

# 1. Dockerイメージのビルド (最初に1回だけ実行)
echo "Building Docker image (bms-table-test)..."
cd ..
docker build -t bms-table-test -f test/Dockerfile .
cd test

failed_tests=0

for item in "${TEST_CASES[@]}"; do
    IFS=':' read -r MD5 EXPECTED INFO <<< "$item"
    echo "=================================================="
    echo "Testing MD5: $MD5"
    echo "Info: $INFO"
    echo "Expected Result: $EXPECTED"
    echo "=================================================="
    
    # 2. テスト用BMSファイルをコピー (/tmp/table_test/test.bms として一時配置)
    if [ ! -f "../../bms-files/bms/$MD5" ]; then
        echo "Error: BMS file with MD5 $MD5 not found in bms-files/bms/"
        failed_tests=$((failed_tests + 1))
        continue
    fi
    mkdir -p /tmp/table_test
    cp "../../bms-files/bms/$MD5" /tmp/table_test/test.bms
    
    # 3. 期待値データの生成 (正常に推定できるべき譜面のみ)
    if [ "$EXPECTED" = "success" ]; then
        echo "Generating expectations..."
        # 期待値生成のため /tmp/table_test/expect_out を空にする
        rm -rf /tmp/table_test/expect_out/
        uv run --with onnxruntime generate_expectations.py "$MD5"
    fi
    
    # 4. Dockerでテストを実行 (ホストの /tmp/table_test をコンテナ内の /tmp/table_test にマウント共有)
    cd ..
    if ! docker run --rm -v "$(pwd):/app" -v /tmp/table_test:/tmp/table_test bms-table-test node --experimental-network-imports test/test_inference.js "$MD5" "$EXPECTED"; then
        echo "-> TEST FAILED for MD5 $MD5"
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
