import os
import sys
import json
import shutil
import numpy as np

# chartディレクトリのモジュールをインポートできるようにパスを追加
chart_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../bms-difficulty-estimation/chart'))
sys.path.append(chart_dir)

from estimate11 import BMS
from utils import Utils

def prepare_onnx_input(bms_obj):
    window_size = 600
    stride = 200
    max_windows = 600
    meta_dim = 58
    
    temp_metas = []
    song_last_ms = bms_obj.song_info.song_last_ms
    for start in range(0, int(song_last_ms), stride):
        meta = bms_obj.get_window_meta(start, start + window_size)
        temp_metas.append(meta)
        
    # 有効な窓の抽出 (Max Density Logic)
    notes_count = [m[0] + m[1] for m in temp_metas]
    valid_indices = [i for i, count in enumerate(notes_count) if count > 0]
    
    if not valid_indices:
        raise ValueError("No notes found in windows")
        
    valid_length = valid_indices[-1] + 1
    start_idx = 0
    if valid_length > max_windows:
        start_idx = valid_length - max_windows
        max_density_idx = np.argmax(notes_count[:valid_length])
        if max_density_idx < start_idx:
            margin = 10
            start_idx = max(0, max_density_idx - margin)
            
    final_metas = temp_metas[start_idx : start_idx + max_windows]
    
    # [1, 600, 58] に右詰め
    all_metas = np.zeros((max_windows, meta_dim), dtype=np.float32)
    shift = max_windows - len(final_metas)
    for i, meta in enumerate(final_metas):
        all_metas[shift + i] = meta
        
    return all_metas

def main():
    if len(sys.argv) < 2:
        print("Usage: python generate_expectations.py <md5>")
        sys.exit(1)
        
    md5 = sys.argv[1]

    # キャッシュディレクトリを専用のものに設定
    Utils.cache_root = '/tmp/bms_cache_table_test'
    if os.path.exists(Utils.cache_root):
        shutil.rmtree(Utils.cache_root)
    os.makedirs(Utils.cache_root, exist_ok=True)
    BMS.cache_root = Utils.cache_root

    local_dir = os.path.dirname(__file__)
    bms_path = os.path.abspath(os.path.join(local_dir, f'../../bms-files/bms/{md5}'))
    out_dir = os.path.join(local_dir, 'out')
    os.makedirs(out_dir, exist_ok=True)

    if not os.path.exists(bms_path):
        print(f"Error: test.bms not found at {bms_path}")
        sys.exit(1)

    # 1. BMSのパース (beatoraja.jar を使用)
    print("Parsing BMS using beatoraja.jar...")
    bms_obj = BMS(bms_path)
    
    # 期待値の timeline_master
    timeline = bms_obj.timeline_master.tolist()
    
    # 期待値の song_info
    song_info = {
        "title": bms_obj.song_info.title,
        "subtitle": bms_obj.song_info.subtitle,
        "artist": bms_obj.song_info.artist,
        "subartist": bms_obj.song_info.subartist,
        "song_last_ms": bms_obj.song_info.song_last_ms,
        "total": bms_obj.song_info.total,
        "total_notes": bms_obj.song_info.total_notes
    }

    # 2. 特徴量抽出
    print("Extracting features...")
    onnx_input = prepare_onnx_input(bms_obj)
    
    # 3. ONNX推論の実行
    print("Running ONNX inference...")
    try:
        import onnxruntime as ort
    except ImportError:
        print("Warning: onnxruntime not found. Skipping python inference expectation generation.")
        # onnxruntimeがない場合は、予測期待値のJSON出力はスキップします
        # (JS側で推論が動くかどうかの確認のみになります)
        ort = None

    expect_preds = []
    if ort:
        estimate_dir = os.path.abspath(os.path.join(local_dir, '../estimate'))
        onnx_input_tensor = np.expand_dims(onnx_input, axis=0) # [1, 600, 58]
        
        # 15個のモデルで推論
        run_count = 3
        fold_count = 5
        for r in range(1, run_count + 1):
            for f in range(1, fold_count + 1):
                model_path = os.path.join(estimate_dir, f"run{r}_fold{f}.onnx")
                if os.path.exists(model_path):
                    session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
                    outputs = session.run(None, {'input_x': onnx_input_tensor})
                    pred = float(outputs[0][0][0])
                    expect_preds.append(pred)
                else:
                    print(f"Warning: {model_path} not found.")

    # JSON出力
    with open(os.path.join(out_dir, 'expect_timeline.json'), 'w', encoding='utf-8') as f:
        json.dump({"timeline_master": timeline, "song_info": song_info}, f, ensure_ascii=False, indent=2)

    with open(os.path.join(out_dir, 'expect_input_x.json'), 'w', encoding='utf-8') as f:
        json.dump(onnx_input.tolist(), f, ensure_ascii=False, indent=2)

    if expect_preds:
        with open(os.path.join(out_dir, 'expect_predictions.json'), 'w', encoding='utf-8') as f:
            json.dump({"predictions": expect_preds}, f, ensure_ascii=False, indent=2)
        print(f"Generated expectations with {len(expect_preds)} model predictions.")
    else:
        print("Generated timeline and input_x expectations.")

if __name__ == '__main__':
    main()
