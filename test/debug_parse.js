import fs from 'fs';
import { processBMSData } from '../estimate/bms-processor.js';

const bmsPath = '/tmp/table_test/test.bms';
const fileBuffer = fs.readFileSync(bmsPath);
const uint8array = new Uint8Array(fileBuffer);

const res = await processBMSData(uint8array);

console.log("Song Info:");
console.log(res.song_info);

console.log("\nTimeline Master (First 20):");
for (let i = 0; i < Math.min(res.timeline_master.length, 20); i++) {
    console.log(`Row ${i}: ${JSON.stringify(res.timeline_master[i])}`);
}
