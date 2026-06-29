#!/bin/bash
set -e

# テストスクリプトのあるディレクトリに移動
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# テスト対象の定義 (test_cases.txt から読み込む)
TEST_CASES_FILE="test_cases.txt"
if [ ! -f "$TEST_CASES_FILE" ]; then
    echo "Error: $TEST_CASES_FILE not found"
    exit 1
fi

mapfile -t TEST_CASES < "$TEST_CASES_FILE"


# 1. Dockerイメージのビルド (最初に1回だけ実行)
echo "Building Docker image (bms-table-test)..."
cd ..
docker build -t bms-table-test -f test/Dockerfile .
cd test

failed_tests=0
TARGET_CASE="$1"

for item in "${TEST_CASES[@]}"; do
    IFS=':' read -r CASE_ID EXPECTED INFO <<< "$item"
    if [ -n "$TARGET_CASE" ] && [ "$CASE_ID" != "$TARGET_CASE" ]; then
        continue
    fi
    echo "=================================================="
    echo "Testing Case: $CASE_ID"
    echo "Info: $INFO"
    echo "Expected Result: $EXPECTED"
    echo "=================================================="
    
    # 2. テスト用BMSファイルをコピー (/tmp/table_test/test.bms として一時配置)
    mkdir -p /tmp/table_test
    if [ -f "test_charts/${CASE_ID}.bms" ]; then
        cp "test_charts/${CASE_ID}.bms" /tmp/table_test/test.bms
    else
        echo "Error: BMS file test_charts/${CASE_ID}.bms not found"
        failed_tests=$((failed_tests + 1))
        continue
    fi
    
    # 3. 期待値データの生成 (正常に推定できるべき譜面のみ)
    if [ "$EXPECTED" = "success" ]; then
        echo "Generating expectations..."
        # 期待値生成のため /tmp/table_test/expect_out を空にする
        rm -rf /tmp/table_test/expect_out/
        uv run --project ../../bms-difficulty-estimation/local_estimation --with onnxruntime generate_expectations.py "$CASE_ID"
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
