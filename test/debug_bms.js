import fs from 'fs';

const bmsPath = 'test/test_charts/large_bga_577ec71453d823a9dd672b02379b7a66.bms';
if (!fs.existsSync(bmsPath)) {
    console.error("File not found:", bmsPath);
    process.exit(1);
}

console.log("Reading file...");
const buffer = fs.readFileSync(bmsPath);
const text = new TextDecoder('shift-jis').decode(buffer);

const lines = text.split(/\r?\n/);
console.log("Total lines:", lines.length);

let wavCount = 0;
let bmpCount = 0;
let bgaCount = 0;
let dataCount = 0;
let otherCount = 0;

for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith('#WAV')) wavCount++;
    else if (trimmed.toUpperCase().startsWith('#BMP')) bmpCount++;
    else if (trimmed.toUpperCase().startsWith('#BGA')) bgaCount++;
    else if (/^#\d{3}\d{2}:/.test(trimmed)) dataCount++;
    else if (trimmed.startsWith('#')) otherCount++;
}

console.log("WAV definitions:", wavCount);
console.log("BMP definitions:", bmpCount);
console.log("BGA definitions (#BGA):", bgaCount);
console.log("Channel data lines (#xxx yy:):", dataCount);
console.log("Other headers:", otherCount);

console.log("\nSimulating processor replacements...");
let processed = text;
processed = processed.replace(/^[ \t]*#BMP\w+[ \t]+.*$/gim, '');
processed = processed.replace(/^[ \t]*#WAV\w+[ \t]+.*$/gim, '');
processed = processed.replace(/^[ \t]*#\d{3}(?!02|03|04|06|07|08|09|1[1-9]|2[1-9]|5[1-9]|6[1-9])\w{2}:.*$/gim, '');

const bgaLineRegex = /^[ \t]*#(\d{3})(04|06|07):/gim;
let match;
let maxBgaMeasure = -1;
while ((match = bgaLineRegex.exec(processed)) !== null) {
    const measure = parseInt(match[1], 10);
    if (measure > maxBgaMeasure) {
        maxBgaMeasure = measure;
    }
}
if (maxBgaMeasure !== -1) {
    const maxMeasureStr = String(maxBgaMeasure).padStart(3, '0');
    const replaceRegex = new RegExp(`^[ \\t]*#(?!${maxMeasureStr})\\d{3}(04|06|07):.*$`, 'gim');
    processed = processed.replace(replaceRegex, '');
} else {
    processed = processed.replace(/^[ \t]*#\d{3}(04|06|07):.*$/gim, '');
}

const processedLines = processed.split(/\r?\n/).filter(l => l.trim() !== '');
console.log("Processed lines count (non-empty):", processedLines.length);
console.log("Processed text length (chars):", processed.length);

console.log("\nFirst 15 non-empty processed lines:");
console.log(processedLines.slice(0, 15).join('\n'));

console.log("\nLast 15 non-empty processed lines:");
console.log(processedLines.slice(-15).join('\n'));
