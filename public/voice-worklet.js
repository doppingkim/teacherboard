// 마이크 입력(128샘플 Float32 조각)을 그대로 메인 스레드로 넘긴다.
class VoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      const chunk = new Float32Array(channel); // 복사: 입력 버퍼는 재사용된다
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
