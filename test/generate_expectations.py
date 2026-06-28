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
    window_size = 1600
    stride = 400
    max_windows = 300
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
        
    case_id = sys.argv[1]

    # キャッシュディレクトリを専用のものに設定
    Utils.cache_root = '/tmp/table_test/bms_cache_table_test'
    if os.path.exists(Utils.cache_root):
        shutil.rmtree(Utils.cache_root)
    os.makedirs(Utils.cache_root, exist_ok=True)
    BMS.cache_root = Utils.cache_root

    local_dir = os.path.dirname(__file__)
    # /tmp/table_test/test.bms から読み込み、/tmp/table_test/expect_out に出力する
    bms_path = '/tmp/table_test/test.bms'
    out_dir = '/tmp/table_test/expect_out'
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    if not os.path.exists(bms_path):
        print(f"Error: test file not found at {bms_path}")
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
    
    # 3. ONNX推論とPyTorch(pth)推論の比較
    print("Running ONNX and PyTorch comparison...")
    import onnxruntime as ort
    import torch

    expect_preds = []
    # pthモデルのロード
    local_est_dir = os.path.abspath(os.path.join(local_dir, '../../bms-difficulty-estimation/local_estimation'))
    sys.path.append(local_est_dir)
    from estimate import load_models
    
    device = torch.device("cpu")
    train_data_dir = os.path.join(local_est_dir, 'train_data')
    pth_models, _ = load_models(train_data_dir, device)
    
    estimate_dir = os.path.abspath(os.path.join(local_dir, '../estimate'))
    onnx_input_tensor = np.expand_dims(onnx_input, axis=0) # [1, 300, 58]
    x_tensor = torch.from_numpy(onnx_input).unsqueeze(0).to(device)
    
    # 25個のモデルで推論と比較
    run_count = 5
    fold_count = 5
    model_idx = 0
    
    for r in range(1, run_count + 1):
        for f in range(1, fold_count + 1):
            pth_model = pth_models[model_idx]
            model_idx += 1
            
            # PyTorch推論
            with torch.no_grad():
                pth_out = pth_model(x_tensor, None)[0]
                pth_pred = float(pth_out.view(-1).item())
            
            # ONNX推論
            model_path = os.path.join(estimate_dir, f"run{r}_fold{f}.onnx")
            if os.path.exists(model_path):
                session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
                outputs = session.run(None, {'input_x': onnx_input_tensor})
                onnx_pred = float(outputs[0][0][0])
                
                # 期待値との比較
                diff = abs(pth_pred - onnx_pred)
                if diff > 1e-4:
                    raise AssertionError(
                        f"Mismatch between PTH and ONNX for run{r}_fold{f}: "
                        f"PTH={pth_pred:.6f}, ONNX={onnx_pred:.6f}, diff={diff:.2e}"
                    )
                expect_preds.append(onnx_pred)
            else:
                raise FileNotFoundError(f"ONNX model not found: {model_path}")

    # JSON出力
    with open(os.path.join(out_dir, 'expect_timeline.json'), 'w', encoding='utf-8') as f:
        json.dump({"timeline_master": timeline, "song_info": song_info}, f, ensure_ascii=False, indent=2)

    with open(os.path.join(out_dir, 'expect_input_x.json'), 'w', encoding='utf-8') as f:
        json.dump(onnx_input.tolist(), f, ensure_ascii=False, indent=2)

    with open(os.path.join(out_dir, 'expect_predictions.json'), 'w', encoding='utf-8') as f:
        json.dump({"predictions": expect_preds}, f, ensure_ascii=False, indent=2)
    print(f"Generated expectations with {len(expect_preds)} model predictions.")

if __name__ == '__main__':
    main()
