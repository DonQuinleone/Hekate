// The take log's timecode reader (#51, decision 241): passes one channel of an audio input to
// the page, a few thousand samples at a time, with the sample each block ends at. The decoding
// is the page's (`decodeLtc` in packages/shared); nothing here is kept or sent anywhere else.
// Served from this origin, as the Content Security Policy requires of a worklet's script.
class LtcCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channel = options?.processorOptions?.channel ?? 0;
    this.block = new Float32Array(2048);
    this.fill = 0;
    this.seen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const samples = input?.[this.channel] ?? input?.[0];
    if (samples) {
      let at = 0;
      while (at < samples.length) {
        const take = Math.min(samples.length - at, this.block.length - this.fill);
        this.block.set(samples.subarray(at, at + take), this.fill);
        this.fill += take;
        at += take;
        if (this.fill === this.block.length) {
          this.seen += this.block.length;
          this.port.postMessage({ samples: this.block, end: this.seen, channels: input.length });
          this.block = new Float32Array(2048);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("ltc-capture", LtcCapture);
