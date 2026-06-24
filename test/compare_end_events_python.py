import jpype
import os
import re

# --- JVM起動 ---
if not jpype.isJVMStarted():
    jpype.startJVM(classpath=['/tmp/beatoraja.jar'], convertStrings=True)

import jpype.imports
Paths = jpype.JClass('java.nio.file.Paths')
BMSDecoder = jpype.JClass('bms.model.BMSDecoder')

bms_path = '/home/user/bms-difficulty-estimation-work/bms-difficulty-estimation-table/test/test_charts/large_bga_577ec71453d823a9dd672b02379b7a66.bms'
# FAIL: SongInfo mismatch for key 'song_last_ms': JS=132002, python=131952

# --- 1. Pythonによる簡易パース・JS同等タイミングシミュレーション ---
def parse_and_simulate(filepath):
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        lines = f.readlines()
        
    init_bpm = 130.0
    bpm_table = {}
    stop_table = {}
    measure_lengths = {}
    channel_data = []
    
    for line in lines:
        line = line.strip()
        if not line.startswith('#'):
            continue
            
        bpm_def = re.match(r'^#BPM\s+([\d\.]+)$', line, re.IGNORECASE)
        if bpm_def:
            init_bpm = float(bpm_def.group(1))
            continue
            
        bpm_xx_def = re.match(r'^#BPM(\w{2})\s+([\d\.]+)$', line, re.IGNORECASE)
        if bpm_xx_def:
            bpm_table[bpm_xx_def.group(1).upper()] = float(bpm_xx_def.group(2))
            continue
            
        stop_xx_def = re.match(r'^#STOP(\w{2})\s+(\d+)$', line, re.IGNORECASE)
        if stop_xx_def:
            stop_table[stop_xx_def.group(1).upper()] = int(stop_xx_def.group(2))
            continue
            
        chan_match = re.match(r'^#(\d{3})(\w{2}):(.*)$', line)
        if chan_match:
            measure = int(chan_match.group(1))
            channel = chan_match.group(2).upper()
            data = chan_match.group(3).strip()
            
            if channel == '02':
                measure_lengths[measure] = float(data)
            else:
                channel_data.append((measure, channel, data))
                
    # 各小節の開始ビート
    measure_start_beats = {}
    current_beat = 0.0
    max_measure = max([m for m, _, _ in channel_data] + list(measure_lengths.keys()))
    
    for m in range(max_measure + 2):
        measure_start_beats[m] = current_beat
        length = measure_lengths.get(m, 1.0)
        current_beat += 4.0 * length
        
    timing_points = []
    all_objects = []
    
    for measure, channel, data in channel_data:
        if not data:
            continue
        pairs = [data[i:i+2] for i in range(0, len(data), 2)]
        num_pairs = len(pairs)
        
        m_length = measure_lengths.get(measure, 1.0)
        m_beats = 4.0 * m_length
        m_start_beat = measure_start_beats[measure]
        
        for idx, val in enumerate(pairs):
            if val == '00':
                continue
                
            fraction = idx / num_pairs
            beat = m_start_beat + fraction * m_beats
            
            if channel == '03':
                bpm_val = int(val, 16)
                timing_points.append((beat, 'bpm', bpm_val))
            elif channel == '08':
                bpm_val = bpm_table.get(val.upper(), 130.0)
                timing_points.append((beat, 'bpm', bpm_val))
            elif channel == '09':
                stop_duration = stop_table.get(val.upper(), 0)
                timing_points.append((beat, 'stop', stop_duration))
            else:
                all_objects.append({
                    'measure': measure,
                    'fraction': fraction,
                    'channel': channel,
                    'value': val,
                    'beat': beat
                })
                
    timing_points.sort(key=lambda x: (x[0], 0 if x[1] == 'bpm' else 1))
    
    timeline = []
    curr_beat = 0.0
    curr_sec = 0.0
    curr_bpm = init_bpm
    timeline.append((curr_beat, curr_sec, curr_bpm))
    
    for t_beat, t_type, t_val in timing_points:
        if t_beat > curr_beat:
            d_beat = t_beat - curr_beat
            curr_sec += d_beat * (60.0 / curr_bpm)
            curr_beat = t_beat
            
        if t_type == 'bpm':
            curr_bpm = t_val
            timeline.append((curr_beat, curr_sec, curr_bpm))
        elif t_type == 'stop':
            stop_sec = (t_val / 192.0) * (60.0 / curr_bpm) * 4.0
            curr_sec += stop_sec
            timeline.append((curr_beat, curr_sec, curr_bpm))
            
    def beat_to_seconds(beat):
        last_pt = timeline[0]
        for pt in timeline:
            if pt[0] <= beat:
                last_pt = pt
            else:
                break
        d_beat = beat - last_pt[0]
        sec = last_pt[1] + d_beat * (60.0 / last_pt[2])
        return sec

    for obj in all_objects:
        sec = beat_to_seconds(obj['beat'])
        obj['timeSec'] = sec
        obj['timeMs'] = sec * 1000.0
        obj['timeMsRound'] = int(obj['timeMs'])
        
    return all_objects

print("Simulating JS timings in Python...")
js_simulated_objects = parse_and_simulate(bms_path)
js_simulated_objects.sort(key=lambda x: x['timeMs'])

# --- 2. Java (beatoraja) 側のイベント取得 ---
path = Paths.get(bms_path)
decoder = BMSDecoder()
model = decoder.decode(path)
timelines = model.getAllTimeLines()

java_events = []
for tl in timelines:
    t = tl.getMilliTime()
    notes = []
    for l in range(tl.getLaneCount()):
        note = tl.getNote(l)
        if note:
            notes.append(f"Lane {l}: {type(note).__name__}")
            
    bg_notes = tl.getBackGroundNotes()
    bg_notes_count = len(bg_notes) if bg_notes else 0
    
    java_events.append({
        "timeMs": t,
        "microTime": tl.getMicroTime(),
        "measure": tl.getSection(),
        "bga": tl.getBGA(),
        "bpm": tl.getBPM(),
        "milliStop": tl.getMilliStop(),
        "notes": notes,
        "bg_notes_count": bg_notes_count
    })

# --- 3. 比較表示 ---
print("\n=== JS Simulated Events (131945 - 132010 ms) ===")
js_filtered = [e for e in js_simulated_objects if 131945 <= e['timeMsRound'] <= 132010]
for e in js_filtered:
    print(f"TimeRound: {e['timeMsRound']} ms (Raw: {e['timeMs']:.6f} ms, Sec: {e['timeSec']:.8f} s)")
    print(f"  Measure: {e['measure']}, Fraction: {e['fraction']:.6f}, Beat: {e['beat']:.6f}")
    print(f"  Channel: {e['channel']}, Value: {e['value']}")

print("\n=== Java (beatoraja) Events (131945 - 132010 ms) ===")
for e in java_events:
    if 131945 <= e['timeMs'] <= 132010:
        print(f"TimeMs: {e['timeMs']} ms (MicroTime: {e['microTime']} us)")
        print(f"  Measure (Section): {e['measure']:.6f}")
        print(f"  BGA: {e['bga']}, BPM: {e['bpm']}, MilliStop: {e['milliStop']}")
        if e['notes']:
            print(f"  Notes: {e['notes']}")
        if e['bg_notes_count'] > 0:
            print(f"  BGM Notes: {e['bg_notes_count']}")
