// AudioWorkletProcessor for mic capture: converts the input channel to 16-bit mono PCM
// and posts each chunk back to the main thread over the message port. The mic
// AudioContext runs at 16 kHz (renderer.js), so the browser does the resampling.
// Runs on the dedicated audio rendering thread, never the main/UI thread.

function toPcm16(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

class MicDownsampleProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    const pcm = toPcm16(input);
    if (pcm.byteLength > 0) {
      const bytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      this.port.postMessage(bytes, [bytes]);
    }
    return true;
  }
}

registerProcessor("mic-downsample", MicDownsampleProcessor);
