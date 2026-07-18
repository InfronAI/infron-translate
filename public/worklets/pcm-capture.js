class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input?.length) return true
    const copy = new Float32Array(input)
    this.port.postMessage(copy, [copy.buffer])
    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
