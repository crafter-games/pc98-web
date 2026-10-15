// Plays interleaved stereo S16 PCM pushed from the main thread.
// Keeps a small ring buffer; drops the oldest audio when the emulator runs ahead.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 48000; // 1 s of stereo frames at 48 kHz
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0;
    this.size = 0;
    this.port.onmessage = (e) => this.push(e.data);
  }

  push(pcm) {
    const frames = pcm.length >> 1;
    for (let i = 0; i < frames; i++) {
      if (this.size === this.capacity) {
        this.read = (this.read + 1) % this.capacity;
        this.size--;
      }
      const w = (this.read + this.size) % this.capacity;
      this.left[w] = pcm[i * 2] / 32768;
      this.right[w] = pcm[i * 2 + 1] / 32768;
      this.size++;
    }
    this.port.postMessage(this.size);
  }

  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    for (let i = 0; i < l.length; i++) {
      if (this.size > 0) {
        l[i] = this.left[this.read];
        r[i] = this.right[this.read];
        this.read = (this.read + 1) % this.capacity;
        this.size--;
      } else {
        l[i] = 0;
        r[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
