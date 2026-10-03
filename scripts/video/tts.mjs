#!/usr/bin/env node
// Narration for the demo video with Deepgram Aura-2 on Workers AI (REST, the operator's wrangler login).
// One MP3 per segment of video/narration.json, cached by text and voice. Each MP3 is transcribed back with
// Whisper (also Workers AI): the word timestamps time the captions, and the transcript is printed so a
// mispronounced word shows up as a different word.
//
//   node scripts/video/tts.mjs --narration video/narration.json --out <dir> [--speaker thalia]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cfApi, cfRaw } from '../cf-api.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const NARRATION = arg('narration', 'video/narration.json');
const OUT = arg('out');
const SPEAKER = arg('speaker', 'thalia');
if (!OUT) {
  console.error('usage: node scripts/video/tts.mjs --narration <file> --out <dir> [--speaker name]');
  process.exit(2);
}
const { segments } = JSON.parse(fs.readFileSync(NARRATION, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const durations = {};
for (const seg of segments) {
  if (!seg.text) continue;
  const hash = createHash('sha256').update(`${SPEAKER}\n${seg.text}`).digest('hex').slice(0, 16);
  const file = path.join(OUT, `${seg.id}.${hash}.mp3`);
  if (!fs.existsSync(file)) {
    const r = await cfRaw('POST', '/ai/run/@cf/deepgram/aura-2-en', { text: seg.text, speaker: SPEAKER, encoding: 'mp3' });
    fs.writeFileSync(file, r.bytes);
  }
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
  const wordsFile = file.replace(/\.mp3$/, '.words.json');
  if (!fs.existsSync(wordsFile)) {
    const r = await cfApi('POST', '/ai/run/@cf/openai/whisper-large-v3-turbo', { audio: fs.readFileSync(file).toString('base64'), language: 'en' });
    const words = (r.segments ?? []).flatMap((x) => x.words ?? []).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
    fs.writeFileSync(wordsFile, JSON.stringify({ text: r.text.trim(), words }));
  }
  const heard = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
  durations[seg.id] = { file, seconds: d, words: heard.words };
  console.error(`${seg.id.padEnd(14)} ${d.toFixed(1)} s  heard: ${heard.text}`);
}
fs.writeFileSync(path.join(OUT, 'durations.json'), JSON.stringify(durations, null, 2));
console.error(`total narration: ${Object.values(durations).reduce((a, d) => a + d.seconds, 0).toFixed(1)} s`);
