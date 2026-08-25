#!/usr/bin/env node
/**
 * Turn build/notice.txt into build/notice.rtf.
 *
 * NSIS colours a plain-text licence box with LicenseBkColor, but has no
 * setting for the text colour — so a dark background leaves black text on it,
 * which is what happened. An RTF licence renders in a RichEdit control and
 * carries its own colours, so the notice can match the browser's theme and
 * still be readable.
 *
 * The plain text stays the source of truth; this only typesets it.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'build', 'notice.txt');
const OUT = path.join(__dirname, '..', 'build', 'notice.rtf');

// Browser theme: --txt, --accent, --mut.
const COLOURS = '{\\colortbl;'
  + '\\red230\\green233\\blue239;'   // 1 body      #e6e9ef
  + '\\red230\\green57\\blue70;'     // 2 heading   #e63946
  + '\\red139\\green147\\blue163;'   // 3 muted     #8b93a3
  + '}';

const escape = (s) => s
  .replace(/\\/g, '\\\\')
  .replace(/\{/g, '\\{')
  .replace(/\}/g, '\\}')
  // Anything outside ASCII has to be escaped as a unicode run, but the notice
  // is deliberately plain ASCII so this should never fire.
  .replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0) + '?');

const lines = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n').split('\n');

const body = [];
let first = true;
for (const raw of lines) {
  const line = raw.replace(/\s+$/, '');
  const text = escape(line.trim());

  if (!line.trim()) { body.push('\\par'); continue; }

  // A line in capitals is a section heading.
  const isHeading = /^[A-Z][A-Z ,'()-]{4,}$/.test(line.trim());
  const isBullet = /^\s{2}\*/.test(line);
  const isIndented = /^\s{2,}/.test(line) && !isBullet;

  if (first) {
    // Title line.
    body.push('\\pard\\sa120\\cf2\\b\\fs30 ' + text + '\\b0\\fs22\\cf1\\par');
    first = false;
  } else if (isHeading) {
    body.push('\\pard\\sb220\\sa100\\cf2\\b ' + text + '\\b0\\cf1\\par');
  } else if (isBullet) {
    body.push('\\pard\\fi-180\\li360\\sa60\\cf1 ' + text.replace(/^\*\s*/, '\\bullet  ') + '\\par');
  } else if (isIndented) {
    body.push('\\pard\\li360\\sa60\\cf1 ' + text + '\\par');
  } else {
    body.push('\\pard\\sa80\\cf1 ' + text + '\\par');
  }
}

// Consecutive blank lines become one gap; RTF spacing handles the rest.
const collapsed = body.join('\n').replace(/(\\par\n){2,}/g, '\\par\n');

const rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0\n'
  + '{\\fonttbl{\\f0\\fswiss\\fcharset0 Segoe UI;}}\n'
  + COLOURS + '\n'
  + '\\f0\\fs22\\cf1\n'
  + collapsed + '\n}';

fs.writeFileSync(OUT, rtf, 'ascii');
console.log('wrote ' + path.relative(process.cwd(), OUT) + ' (' + rtf.length + ' bytes)');
