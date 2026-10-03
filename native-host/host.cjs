/* global require, process, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- Chrome host runs directly as CommonJS outside the app bundle. */
const net = require('node:net');
const os = require('node:os');
const MAX_BYTES = 600 * 1024;
const [socketPath, origin] = process.argv.slice(2);
if (!socketPath || origin !== 'chrome-extension://haecnhoaegieddnhookppmcmdahidlal/') process.exit(2);

const socket = net.createConnection(socketPath);
let input = Buffer.alloc(0);
let output = Buffer.alloc(0);
const littleEndian = os.endianness() === 'LE';
function stop(code) { socket.destroy(); process.exit(code); }
socket.on('error', () => stop(1));
socket.on('close', () => stop(0));
process.stdin.on('end', () => stop(0));
process.stdin.on('error', () => stop(1));
process.stdout.on('error', () => stop(1));
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = littleEndian ? input.readUInt32LE(0) : input.readUInt32BE(0);
    if (!length || length > MAX_BYTES) return stop(1);
    if (input.length < length + 4) return;
    const payload = input.subarray(4, length + 4);
    if (payload.includes(10) || payload.includes(13)) return stop(1);
    socket.write(Buffer.concat([payload, Buffer.from('\n')]));
    input = input.subarray(length + 4);
  }
});
socket.on('data', chunk => {
  output = Buffer.concat([output, chunk]);
  for (;;) {
    const newline = output.indexOf(10);
    if (newline < 0) { if (output.length > MAX_BYTES) stop(1); return; }
    if (!newline || newline > MAX_BYTES) return stop(1);
    const payload = output.subarray(0, newline);
    const header = Buffer.alloc(4);
    if (littleEndian) header.writeUInt32LE(payload.length); else header.writeUInt32BE(payload.length);
    process.stdout.write(Buffer.concat([header, payload]));
    output = output.subarray(newline + 1);
  }
});
